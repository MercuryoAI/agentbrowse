import type { Locator, Page } from 'playwright-core';
import type { LocatorCandidate, SurfaceDescriptor, TargetDescriptor } from '../runtime-state.js';
import { locatorCandidateKey } from '../runtime-state.js';
import { rankLocatorCandidates } from './action-acceptance.js';
import { buildLocator, resolveLocatorRoot, type LocatorRoot } from './action-fallbacks.js';
import { normalizePageSignature, readLocatorDomSignature } from './descriptor-validation.js';
import { resolveSurfaceScopeRoot } from './target-resolution.js';

export type InteractionResolutionAction = 'click' | 'fill' | 'type' | 'select' | 'press';

export type SharedBindingStaleReason =
  | 'page_signature_mismatch'
  | 'dom_signature_mismatch'
  | 'locator_resolution_failed';

export type PreparedLocatorCandidateResolution = {
  resolved: boolean;
  sawDisabledTarget: boolean;
  sawReadonlyTarget: boolean;
};

function defaultLocatorVisibility(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
}

export function targetUsesSurfaceAsPrimaryLocator(
  target: Pick<TargetDescriptor, 'locatorCandidates'>,
  surface: Pick<SurfaceDescriptor, 'locatorCandidates'>
): boolean {
  const surfaceCandidates = new Set(surface.locatorCandidates.map(locatorCandidateKey));
  return target.locatorCandidates.some((candidate) =>
    surfaceCandidates.has(locatorCandidateKey(candidate))
  );
}

export async function resolveInteractionRoots(
  page: Page,
  target: Pick<TargetDescriptor, 'framePath' | 'locatorCandidates'>,
  surface: SurfaceDescriptor | null,
  attempts: string[],
  options?: {
    recordSelfTargetReuse?: boolean;
  }
): Promise<{
  baseRoot: LocatorRoot;
  locatorRoot: LocatorRoot;
  surfaceRoot: Locator | null;
}> {
  const baseRoot = resolveLocatorRoot(page, target.framePath ?? surface?.framePath);
  if (!surface) {
    return {
      baseRoot,
      locatorRoot: baseRoot,
      surfaceRoot: null,
    };
  }

  const surfaceRoot = await resolveSurfaceScopeRoot(page, surface, attempts);
  if (surfaceRoot) {
    if (targetUsesSurfaceAsPrimaryLocator(target, surface)) {
      if (options?.recordSelfTargetReuse) {
        attempts.push('surface.resolve.self-target');
      }
      return {
        baseRoot,
        locatorRoot: baseRoot,
        surfaceRoot,
      };
    }

    return {
      baseRoot,
      locatorRoot: surfaceRoot,
      surfaceRoot,
    };
  }

  attempts.push('surface.resolve.fallback:page');
  return {
    baseRoot,
    locatorRoot: baseRoot,
    surfaceRoot: null,
  };
}

export function resolveScopedLocatorRootForCandidate(
  baseRoot: LocatorRoot,
  defaultRoot: LocatorRoot,
  surfaceRoot: Locator | null,
  scope: LocatorCandidate['scope']
): LocatorRoot | null {
  if (scope === 'root') {
    return baseRoot;
  }
  if (scope === 'surface') {
    return surfaceRoot;
  }
  return defaultRoot;
}

export async function prepareEditableInteractionLocator(
  locator: Locator,
  action: InteractionResolutionAction,
  strategy: string,
  attempts: string[],
  options?: {
    allowReadonlyFallback?: boolean;
    allowDescendantPressFallback?: boolean;
    isUserActionable?: (locator: Locator) => Promise<boolean>;
  }
): Promise<{
  locator: Locator | null;
  blockedReason?: 'disabled' | 'readonly';
}> {
  const isUserActionable = options?.isUserActionable ?? defaultLocatorVisibility;
  const count = await locator.count().catch(() => 0);
  if (count === 0) {
    attempts.push(`resolve.skip:${strategy}:empty`);
    return { locator: null };
  }

  if (action !== 'click' && count > 1) {
    attempts.push(`resolve.skip:${strategy}:ambiguous:${count}`);
    return { locator: null };
  }

  let resolvedLocator = locator.first();
  if (action === 'click' && count > 1) {
    const visibleCandidates: Locator[] = [];

    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      const visible = await isUserActionable(candidate).catch(() => false);
      if (!visible) {
        continue;
      }
      visibleCandidates.push(candidate);
    }

    if (visibleCandidates.length === 1) {
      attempts.push(`resolve.visible-unique:${strategy}`);
      resolvedLocator = visibleCandidates[0] ?? locator.first();
    } else if (visibleCandidates.length > 1) {
      attempts.push(`resolve.skip:${strategy}:ambiguous-visible:${visibleCandidates.length}`);
      return { locator: null };
    } else {
      attempts.push(`resolve.skip:${strategy}:hidden`);
      return { locator: null };
    }
  }

  const visible = await isUserActionable(resolvedLocator).catch(() => false);
  if (!visible) {
    attempts.push(`resolve.skip:${strategy}:hidden`);
    return { locator: null };
  }

  const disabled = await resolvedLocator.isDisabled?.().catch(() => false);
  if (disabled) {
    attempts.push(`resolve.skip:${strategy}:disabled`);
    return { locator: null, blockedReason: 'disabled' };
  }

  const shouldRecoverDescendantEditable =
    action === 'fill' ||
    action === 'type' ||
    (action === 'press' && options?.allowDescendantPressFallback);
  if (!shouldRecoverDescendantEditable) {
    return { locator: resolvedLocator };
  }

  const editable = await resolvedLocator.isEditable().catch(() => false);
  if (editable) {
    return { locator: resolvedLocator };
  }

  const descendantSelector =
    action === 'press' && options?.allowDescendantPressFallback
      ? 'input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]'
      : 'input:not([type="hidden"]), textarea, select, [contenteditable="true"]';
  const descendantCandidates = resolvedLocator.locator(descendantSelector);
  const descendantCount = await descendantCandidates.count().catch(() => 0);
  const candidateDescendants: Locator[] = [];

  for (let index = 0; index < descendantCount; index += 1) {
    const descendant = descendantCandidates.nth(index);
    const descendantVisible = await isUserActionable(descendant).catch(() => false);
    if (!descendantVisible) {
      continue;
    }

    if (action !== 'press' || !options?.allowDescendantPressFallback) {
      const descendantEditable = await descendant.isEditable().catch(() => false);
      if (!descendantEditable) {
        continue;
      }
    }

    candidateDescendants.push(descendant);
  }

  if (candidateDescendants.length === 1) {
    attempts.push(
      action === 'press' && options?.allowDescendantPressFallback
        ? `resolve.descendant-press:${strategy}`
        : `resolve.descendant-editable:${strategy}`
    );
    return { locator: candidateDescendants[0] ?? null };
  }

  if (candidateDescendants.length > 1) {
    attempts.push(`resolve.skip:${strategy}:descendant-ambiguous:${candidateDescendants.length}`);
    return { locator: null };
  }

  if (options?.allowReadonlyFallback) {
    attempts.push(`resolve.readonly-fallback:${strategy}`);
    return { locator: resolvedLocator };
  }

  attempts.push(`resolve.skip:${strategy}:readonly`);
  return { locator: null, blockedReason: 'readonly' };
}

export async function assertStoredBindingStillValid(
  page: Page,
  locator: Locator,
  target: Pick<TargetDescriptor, 'pageSignature' | 'domSignature'>,
  stage: string,
  options?: {
    onReason?: (
      reason: SharedBindingStaleReason,
      stage: string
    ) => Promise<boolean | void> | boolean | void;
    errorForReason?: (reason: SharedBindingStaleReason, stage: string) => string;
  }
): Promise<void> {
  const errorForReason =
    options?.errorForReason ??
    ((reason: SharedBindingStaleReason, errorStage: string) =>
      `binding_stale:${reason}:${errorStage}`);

  if (target.pageSignature && normalizePageSignature(page.url()) !== target.pageSignature) {
    const handled = await options?.onReason?.('page_signature_mismatch', stage);
    if (handled === true) {
      return;
    }
    throw new Error(errorForReason('page_signature_mismatch', stage));
  }

  const liveCount = await locator.count().catch(() => 0);
  if (liveCount === 0) {
    const handled = await options?.onReason?.('locator_resolution_failed', stage);
    if (handled === true) {
      return;
    }
    throw new Error(errorForReason('locator_resolution_failed', stage));
  }

  if (!target.domSignature) {
    return;
  }

  const liveSignature = await readLocatorDomSignature(locator).catch(() => null);
  if (liveSignature && liveSignature !== target.domSignature) {
    const handled = await options?.onReason?.('dom_signature_mismatch', stage);
    if (handled === true) {
      return;
    }
    throw new Error(errorForReason('dom_signature_mismatch', stage));
  }
}

export async function resolvePreparedLocatorCandidates(params: {
  target: Pick<TargetDescriptor, 'locatorCandidates' | 'controlFamily'>;
  action: InteractionResolutionAction;
  baseRoot: LocatorRoot;
  locatorRoot: LocatorRoot;
  surfaceRoot: Locator | null;
  attempts: string[];
  prepareOptions?: {
    allowReadonlyFallback?: boolean;
    allowDescendantPressFallback?: boolean;
    isUserActionable?: (locator: Locator) => Promise<boolean>;
  };
  onPreparedLocator: (locator: Locator, strategy: LocatorCandidate['strategy']) => Promise<boolean>;
}): Promise<PreparedLocatorCandidateResolution> {
  let sawDisabledTarget = false;
  let sawReadonlyTarget = false;

  for (const candidate of rankLocatorCandidates(params.target.locatorCandidates, params.action)) {
    const candidateRoot = resolveScopedLocatorRootForCandidate(
      params.baseRoot,
      params.locatorRoot,
      params.surfaceRoot,
      candidate.scope
    );
    if (!candidateRoot) {
      params.attempts.push(`resolve.skip:${candidate.strategy}:surface-unavailable`);
      continue;
    }

    const locator = buildLocator(candidateRoot, candidate);
    if (!locator) {
      continue;
    }

    const preparedLocator = await prepareEditableInteractionLocator(
      locator,
      params.action,
      candidate.strategy,
      params.attempts,
      params.prepareOptions
    );
    if (preparedLocator.blockedReason === 'disabled') {
      sawDisabledTarget = true;
    }
    if (preparedLocator.blockedReason === 'readonly') {
      sawReadonlyTarget = true;
    }
    if (!preparedLocator.locator) {
      continue;
    }

    const resolved = await params.onPreparedLocator(preparedLocator.locator, candidate.strategy);
    if (resolved) {
      return {
        resolved: true,
        sawDisabledTarget,
        sawReadonlyTarget,
      };
    }
  }

  return {
    resolved: false,
    sawDisabledTarget,
    sawReadonlyTarget,
  };
}
