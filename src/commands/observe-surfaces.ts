import type {
  ExtractScopeLifetime,
  LocatorCandidate,
  SurfaceDescriptor,
  TargetContext,
  TargetDescriptor,
} from '../runtime-state.js';
import { locatorCandidateKey } from '../runtime-state.js';
import type { DomObservedTarget } from './observe-inventory.js';

const HIGH_SIGNAL_SCOPE_KINDS = new Set([
  'form',
  'dialog',
  'listbox',
  'menu',
  'grid',
  'tabpanel',
  'popover',
  'dropdown',
  'datepicker',
  'floating-panel',
  'sticky-panel',
]);

const SNAPSHOT_SCOPE_KINDS = new Set([
  'dialog',
  'listbox',
  'menu',
  'grid',
  'tabpanel',
  'popover',
  'dropdown',
  'datepicker',
  'floating-panel',
  'sticky-panel',
]);

export const OUTPUT_LEADING_TARGET_LIMIT = 20;

function inferExtractScopeLifetime(
  kind: string | undefined,
  locatorCandidates: ReadonlyArray<LocatorCandidate>
): ExtractScopeLifetime {
  const normalizedKind = (kind ?? '').trim().toLowerCase();
  if (SNAPSHOT_SCOPE_KINDS.has(normalizedKind)) {
    return 'snapshot';
  }

  if (normalizedKind === 'form') {
    return locatorCandidates.length > 0 ? 'durable' : 'snapshot';
  }

  return 'snapshot';
}

export function selectScopesForOutput(
  scopes: ReadonlyArray<SurfaceDescriptor>,
  targets: ReadonlyArray<
    Pick<TargetDescriptor, 'surfaceRef' | 'allowedActions' | 'acceptancePolicy'>
  >,
  preferredScopeRefs?: ReadonlySet<string>
): SurfaceDescriptor[] {
  if (scopes.length === 0) {
    return [];
  }

  const linkedScopeRefs = new Set(
    targets
      .slice(0, OUTPUT_LEADING_TARGET_LIMIT)
      .map((target) => target.surfaceRef)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  );
  const explicitlyPreferredScopeRefs = new Set(
    [...(preferredScopeRefs ?? [])].filter((value) => typeof value === 'string' && value.length > 0)
  );
  const scopeByRef = new Map(scopes.map((scope) => [scope.ref, scope]));
  const includedScopeRefs = new Set([...linkedScopeRefs, ...explicitlyPreferredScopeRefs]);

  for (const scopeRef of [...includedScopeRefs]) {
    let parentSurfaceRef = scopeByRef.get(scopeRef)?.parentSurfaceRef;
    while (parentSurfaceRef) {
      if (includedScopeRefs.has(parentSurfaceRef)) {
        break;
      }
      includedScopeRefs.add(parentSurfaceRef);
      parentSurfaceRef = scopeByRef.get(parentSurfaceRef)?.parentSurfaceRef;
    }
  }

  const scored = scopes
    .map((scope) => {
      const directlyLinked = linkedScopeRefs.has(scope.ref);
      const explicitlyPreferred = explicitlyPreferredScopeRefs.has(scope.ref);
      const disambiguatingAncestor = includedScopeRefs.has(scope.ref);
      if (!disambiguatingAncestor) {
        return null;
      }

      const scopeTargets = targets.filter((target) => target.surfaceRef === scope.ref);
      const kind = (scope.kind ?? '').toLowerCase();
      const overlayLike = HIGH_SIGNAL_SCOPE_KINDS.has(kind);
      const linkedCount = scopeTargets.length;
      const interactionRich = scopeTargets.some(
        (target) =>
          target.allowedActions.includes('fill') ||
          target.allowedActions.includes('select') ||
          target.acceptancePolicy === 'selection' ||
          target.acceptancePolicy === 'date-selection'
      );
      let score = 0;

      if (explicitlyPreferred) score += 160;
      if (directlyLinked) score += 100;
      if (!directlyLinked && !explicitlyPreferred) score += 40;
      if (overlayLike) score += 60;
      if (interactionRich) score += 30;
      score += Math.min(linkedCount, 6) * 5;

      return { scope, score };
    })
    .filter((entry): entry is { scope: SurfaceDescriptor; score: number } => entry !== null)
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) => right.score - left.score || left.scope.ref.localeCompare(right.scope.ref)
    );

  if (scored.length > 0) {
    return scored.slice(0, 12).map(({ scope }) => scope);
  }

  return [];
}

export function buildSurfaceRef(target: DomObservedTarget): string | undefined {
  if (!target.surfaceKind && !target.surfaceSelector && !target.surfaceLabel) {
    return undefined;
  }

  const frameKey = target.framePath?.join('>') ?? 'top';
  return [
    target.pageSignature ?? 'unknown-page',
    frameKey,
    target.surfaceKind ?? 'surface',
    target.surfaceSelector ?? '',
    target.surfaceLabel ?? '',
  ].join('|');
}

function normalizeSurfaceText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
}

function semanticFormContextLabel(target: Pick<DomObservedTarget, 'context'>): string | undefined {
  for (const node of [
    target.context?.landmark,
    target.context?.container,
    target.context?.group,
    target.context?.item,
  ]) {
    const kind = (node?.kind ?? '').trim().toLowerCase();
    if (kind !== 'form') {
      continue;
    }

    return normalizeSurfaceText(node?.label ?? node?.text);
  }

  return undefined;
}

export function buildSyntheticFormSurfaceId(
  target: Pick<
    DomObservedTarget,
    'pageSignature' | 'framePath' | 'frameUrl' | 'formSelector' | 'context'
  >
): string | undefined {
  const pageKey = normalizeSurfaceText(target.pageSignature);
  if (!pageKey) {
    return undefined;
  }

  const formKey =
    normalizeSurfaceText(target.formSelector) ?? semanticFormContextLabel(target)?.toLowerCase();
  if (!formKey) {
    return undefined;
  }

  const frameKey =
    target.framePath?.join('>') ??
    (normalizeSurfaceText(target.frameUrl)
      ? `url:${normalizeSurfaceText(target.frameUrl)}`
      : 'top');
  return `${pageKey}|${frameKey}|form|${formKey}`;
}

export function surfaceReplacementKey(
  surface: Pick<SurfaceDescriptor, 'pageRef' | 'pageSignature' | 'framePath' | 'kind' | 'label'>
): string {
  const pageKey = surface.pageSignature ?? surface.pageRef;
  const frameKey = surface.framePath?.join('>') ?? 'top';
  const kindKey = (surface.kind ?? 'surface').toLowerCase();
  const labelKey = (surface.label ?? '').trim().toLowerCase();
  return `${pageKey}|${frameKey}|${kindKey}|${labelKey}`;
}

export function summarizeContext(context: TargetContext | undefined): string | undefined {
  if (!context) return undefined;

  const parts: string[] = [];
  const pushIfDistinct = (value: string | undefined) => {
    const normalized = normalizeSurfaceText(value);
    if (!normalized || parts.includes(normalized)) {
      return;
    }
    parts.push(normalized);
  };

  pushIfDistinct(context.item?.label ?? context.item?.text ?? context.item?.kind);

  pushIfDistinct(context.group?.label ?? context.group?.text ?? context.group?.kind);

  if (parts.length === 0) {
    pushIfDistinct(context.container?.label ?? context.container?.text ?? context.container?.kind);
  }

  if (parts.length === 0 || context.landmark?.label || context.landmark?.text) {
    pushIfDistinct(context.landmark?.label ?? context.landmark?.text ?? context.landmark?.kind);
  }

  if (parts.length === 0 && context.hintText) {
    pushIfDistinct(context.hintText);
  }

  if (parts.length === 0) return undefined;
  return parts.join(' / ');
}

export function pushUniqueLocatorCandidate(
  acc: LocatorCandidate[],
  candidate: LocatorCandidate | undefined
): void {
  if (!candidate) return;
  const key = locatorCandidateKey(candidate);
  if (acc.some((existing) => locatorCandidateKey(existing) === key)) {
    return;
  }
  acc.push(candidate);
}

function surfaceRoleFromKind(kind: string | undefined): string | undefined {
  const normalized = (kind ?? '').trim().toLowerCase();
  switch (normalized) {
    case 'card':
      return 'article';
    case 'article':
    case 'dialog':
    case 'listbox':
    case 'menu':
    case 'grid':
    case 'tabpanel':
    case 'group':
    case 'region':
    case 'listitem':
    case 'row':
    case 'form':
      return normalized;
    case 'fieldset':
      return 'group';
    case 'section':
      return 'region';
    default:
      return undefined;
  }
}

function collectSurfaceLocatorCandidates(target: DomObservedTarget): LocatorCandidate[] {
  const candidates: LocatorCandidate[] = [];
  const selectors = [target.surfaceSelector, ...(target.surfaceSelectors ?? [])].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );

  for (const selector of selectors) {
    pushUniqueLocatorCandidate(candidates, {
      strategy: selector.startsWith('xpath=') ? 'xpath' : 'css',
      value: selector,
      scope: 'root',
    });
  }

  const surfaceRole = surfaceRoleFromKind(target.surfaceKind);
  if (surfaceRole) {
    pushUniqueLocatorCandidate(
      candidates,
      target.surfaceLabel
        ? { strategy: 'role', value: surfaceRole, name: target.surfaceLabel }
        : undefined
    );
    pushUniqueLocatorCandidate(candidates, { strategy: 'role', value: surfaceRole });
  }

  return candidates;
}

export function collectSurfaceDescriptors(
  pageRef: string,
  targets: ReadonlyArray<DomObservedTarget>
) {
  const descriptors = new Map<string, Omit<SurfaceDescriptor, 'ref'>>();

  for (const target of targets) {
    const surfaceId = target.surfaceRef;
    if (!surfaceId) {
      continue;
    }

    const existing = descriptors.get(surfaceId);
    const locatorCandidates = existing ? [...existing.locatorCandidates] : [];

    for (const candidate of collectSurfaceLocatorCandidates(target)) {
      pushUniqueLocatorCandidate(locatorCandidates, candidate);
    }

    descriptors.set(surfaceId, {
      surfaceId,
      pageRef,
      framePath: existing?.framePath ?? target.framePath,
      frameUrl: existing?.frameUrl ?? target.frameUrl,
      kind: existing?.kind ?? target.surfaceKind ?? 'surface',
      label:
        existing?.label && existing.label !== 'Active surface'
          ? existing.label
          : (target.surfaceLabel ?? target.surfaceKind ?? existing?.label ?? 'Active surface'),
      lifecycle: 'live' as const,
      availability: { state: 'available' as const },
      locatorCandidates,
      createdAt: existing?.createdAt ?? Date.now(),
      pageSignature: existing?.pageSignature ?? target.pageSignature,
      extractScopeLifetime: inferExtractScopeLifetime(
        existing?.kind ?? target.surfaceKind ?? 'surface',
        locatorCandidates
      ),
    });
  }

  for (const target of targets) {
    const surfaceId = buildSyntheticFormSurfaceId(target);
    if (!surfaceId) {
      continue;
    }

    const existing = descriptors.get(surfaceId);
    const locatorCandidates = existing ? [...existing.locatorCandidates] : [];
    const formSelector = target.formSelector?.trim();
    if (formSelector) {
      pushUniqueLocatorCandidate(locatorCandidates, {
        strategy: formSelector.startsWith('xpath=') ? 'xpath' : 'css',
        value: formSelector,
        scope: 'root',
      });
    }

    descriptors.set(surfaceId, {
      surfaceId,
      pageRef,
      framePath: existing?.framePath ?? target.framePath,
      frameUrl: existing?.frameUrl ?? target.frameUrl,
      kind: 'form',
      label: existing?.label ?? semanticFormContextLabel(target) ?? 'Form',
      lifecycle: 'live' as const,
      availability: { state: 'available' as const },
      locatorCandidates,
      createdAt: existing?.createdAt ?? Date.now(),
      pageSignature: existing?.pageSignature ?? target.pageSignature,
      extractScopeLifetime: inferExtractScopeLifetime('form', locatorCandidates),
    });
  }

  return [...descriptors.values()];
}
