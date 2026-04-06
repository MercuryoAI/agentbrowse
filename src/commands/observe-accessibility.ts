import type { Page } from 'playwright-core';
import { resolveLocatorRoot } from './action-fallbacks.js';
import { buildObserveDisplayLabel } from './observe-display-label.js';
import {
  isButtonLikeObservedInput,
  shouldAllowLooseFieldLabelFallbackForObservedControl,
} from './observe-label-policy.js';
import {
  fallbackContextNodeLabelOf,
  fallbackHintTextOf,
  fallbackSurfaceLabelOf,
  fallbackTargetLabelOf,
} from './observe-fallback-semantics.js';
import type {
  DomObservedContextNode,
  DomObservedTarget,
  DomObservedTargetContext,
} from './observe-inventory.js';

type ObserveAccessibilitySemantics = {
  role?: string;
  name?: string;
  states?: Record<string, string | boolean | number>;
};

type ObserveDomFallbackSemantics = {
  label?: string;
  hintText?: string;
};

export type ObserveAccessibilityStats = {
  axAttempts: number;
  axHits: number;
  fallbackUses: number;
};

type ObserveAccessibilityOptions = {
  onStats?: (stats: ObserveAccessibilityStats) => void;
};

type AccessibilitySelectorRef = Pick<DomObservedTarget, 'selector' | 'framePath'>;

const AX_ENRICHMENT_CONCURRENCY = 12;
const AX_SNAPSHOT_TIMEOUT_MS = 250;
const GENERIC_FALLBACK_LABELS = new Set([
  'button',
  'link',
  'combobox',
  'text input',
  'email input',
  'password input',
  'phone input',
  'search input',
  'date input',
  'text area',
  'option',
  'menu item',
  'grid cell',
]);
const GENERIC_CONTAINER_AX_NAMES = new Set([
  'alertdialog',
  'article',
  'complementary',
  'dialog',
  'form',
  'group',
  'main',
  'region',
  'search',
]);
const NON_CONTAINER_AX_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'gridcell',
  'img',
  'link',
  'menuitem',
  'option',
  'radio',
  'switch',
  'tab',
  'textbox',
]);

const DOM_FALLBACK_SEMANTICS_SCRIPT = String.raw`
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  const normalizeText = (value) => {
    const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
    return normalized || undefined;
  };
  const relationTextOf = (attribute) => {
    const relation = element.getAttribute(attribute)?.trim();
    if (!relation) {
      return undefined;
    }

    const text = relation
      .split(/\s+/)
      .map((id) => {
        const related = element.ownerDocument.getElementById(id);
        return related instanceof HTMLElement ? related.innerText || related.textContent || '' : '';
      })
      .join(' ');
    return normalizeText(text);
  };
  const heading = element.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
  const headingText =
    heading instanceof HTMLElement && heading !== element && !heading.contains(element)
      ? normalizeText(
          heading.getAttribute('aria-label') ||
            heading.getAttribute('title') ||
            heading.innerText ||
            heading.textContent
        )
      : undefined;

  return {
    label: normalizeText(
      element.getAttribute('aria-label') ||
        relationTextOf('aria-labelledby') ||
        element.getAttribute('title') ||
        headingText
    ),
    hintText: relationTextOf('aria-describedby'),
  };
`;

function emptyStats(): ObserveAccessibilityStats {
  return {
    axAttempts: 0,
    axHits: 0,
    fallbackUses: 0,
  };
}

function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function isMeaningfulName(value: string | undefined): value is string {
  const normalized = normalizeText(value);
  return normalized.length >= 2 && normalized !== '[object Object]';
}

function normalizeLabelKey(value: string | undefined): string {
  return normalizeText(value).toLowerCase();
}

export function parseObserveAriaSnapshot(
  snapshot: string | undefined | null
): ObserveAccessibilitySemantics | null {
  const rawSnapshot = typeof snapshot === 'string' ? snapshot : '';
  if (!normalizeText(rawSnapshot)) {
    return null;
  }

  const lines = rawSnapshot
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headerLine = lines.find((line) => line.startsWith('- '));
  if (!headerLine) {
    return null;
  }

  const header = headerLine
    .replace(/^-+\s*/, '')
    .replace(/:\s*$/, '')
    .trim();
  if (!header) {
    return null;
  }

  const roleMatch = header.match(/^([a-z][a-z0-9_-]*)\b/i);
  const quotedParts = [...header.matchAll(/"([^"]+)"/g)].map((match) => normalizeText(match[1]));
  const stateParts = [...header.matchAll(/\[([^\]]+)\]/g)].map((match) =>
    normalizeText(match[1]).toLowerCase()
  );

  const states: Record<string, string | boolean | number> = {};
  for (const state of stateParts) {
    if (!state) {
      continue;
    }
    if (state === 'checked') states.checked = true;
    else if (state === 'disabled') states.disabled = true;
    else if (state === 'expanded') states.expanded = true;
    else if (state === 'pressed') states.pressed = true;
    else if (state === 'selected') states.selected = true;
    else if (state.startsWith('level=')) {
      const level = Number(state.slice('level='.length));
      if (Number.isFinite(level)) {
        states.level = level;
      }
    }
  }

  return {
    role: roleMatch?.[1]?.toLowerCase(),
    name: quotedParts.length > 0 ? quotedParts.join(' ') : undefined,
    states: Object.keys(states).length > 0 ? states : undefined,
  };
}

function shouldPreferAccessibilityName(
  target: Pick<DomObservedTarget, 'kind' | 'role' | 'inputType' | 'label' | 'text'>,
  accessibilityName: string
): boolean {
  const currentLabel = normalizeText(target.label);
  const currentKey = normalizeLabelKey(currentLabel);
  const nextLabel = normalizeText(accessibilityName);
  const nextKey = normalizeLabelKey(nextLabel);
  const visibleText = normalizeText(target.text);
  const kind = normalizeText(target.kind)?.toLowerCase();
  const role = normalizeText(target.role)?.toLowerCase();
  const looseFieldFallbackAllowed = shouldAllowLooseFieldLabelFallbackForObservedControl({
    tag: kind,
    role,
    inputType: target.inputType,
  });
  const primaryAxControl =
    !looseFieldFallbackAllowed &&
    (kind === 'button' ||
      kind === 'link' ||
      kind === 'checkbox' ||
      kind === 'radio' ||
      role === 'button' ||
      role === 'link' ||
      role === 'checkbox' ||
      role === 'radio' ||
      role === 'menuitem' ||
      role === 'option' ||
      role === 'switch' ||
      role === 'tab' ||
      isButtonLikeObservedInput({
        tag: kind,
        inputType: target.inputType,
      }));

  if (!isMeaningfulName(nextLabel)) {
    return false;
  }
  if (!isMeaningfulName(currentLabel)) {
    return true;
  }
  if (GENERIC_FALLBACK_LABELS.has(nextKey) && !GENERIC_FALLBACK_LABELS.has(currentKey)) {
    return false;
  }
  if (primaryAxControl && currentLabel !== nextLabel) {
    return true;
  }
  if (GENERIC_FALLBACK_LABELS.has(currentKey)) {
    return true;
  }
  if (currentLabel === nextLabel) {
    return false;
  }
  if (
    isMeaningfulName(visibleText) &&
    visibleText === nextLabel &&
    nextLabel.startsWith(currentLabel) &&
    nextLabel.length > currentLabel.length
  ) {
    return true;
  }

  return currentLabel.startsWith(nextLabel) && currentLabel.length - nextLabel.length >= 12;
}

function patchDisplayLabel(
  displayLabel: string | undefined,
  previousLabel: string | undefined,
  nextLabel: string
): string | undefined {
  if (!displayLabel || !previousLabel) {
    return displayLabel;
  }

  const normalizedPrevious = normalizeText(previousLabel);
  if (!normalizedPrevious) {
    return displayLabel;
  }

  return displayLabel.startsWith(previousLabel)
    ? nextLabel + displayLabel.slice(previousLabel.length)
    : displayLabel;
}

function shouldUseCurrentValueDisplayLabel(
  target: Pick<DomObservedTarget, 'controlFamily' | 'kind'>
): boolean {
  return target.controlFamily === 'select' && target.kind !== 'select';
}

function chooseDisplayLabel(
  target: Pick<
    DomObservedTarget,
    'controlFamily' | 'currentValue' | 'displayLabel' | 'kind' | 'label'
  >,
  nextLabel: string | undefined
): string | undefined {
  if (shouldUseCurrentValueDisplayLabel(target)) {
    const currentValueDisplayLabel = buildObserveDisplayLabel(
      nextLabel ?? target.label,
      target.currentValue
    );
    if (currentValueDisplayLabel) {
      return currentValueDisplayLabel;
    }
  }

  return nextLabel && nextLabel !== target.label
    ? patchDisplayLabel(target.displayLabel, target.label, nextLabel)
    : target.displayLabel;
}

function framePathKey(framePath: ReadonlyArray<string> | undefined): string {
  return framePath?.join('>') ?? '__top__';
}

function accessibilityCacheKeyOf(target: AccessibilitySelectorRef): string {
  return `${framePathKey(target.framePath)}::${target.selector?.trim() ?? ''}`;
}

function hasAccessibilitySemantics(
  semantics: ObserveAccessibilitySemantics | null
): semantics is ObserveAccessibilitySemantics {
  return Boolean(
    semantics &&
      (isMeaningfulName(semantics.name) ||
        isMeaningfulName(semantics.role) ||
        (semantics.states && Object.keys(semantics.states).length > 0))
  );
}

async function readAccessibilitySemantics(
  page: Page,
  target: AccessibilitySelectorRef,
  rootCache: Map<string, ReturnType<typeof resolveLocatorRoot>>,
  snapshotCache: Map<string, Promise<ObserveAccessibilitySemantics | null>>,
  stats: ObserveAccessibilityStats
): Promise<ObserveAccessibilitySemantics | null> {
  const selector = target.selector?.trim();
  if (!selector) {
    return null;
  }

  const cacheKey = accessibilityCacheKeyOf(target);
  const cachedSnapshot = snapshotCache.get(cacheKey);
  if (cachedSnapshot) {
    return cachedSnapshot;
  }

  stats.axAttempts += 1;
  const pendingSnapshot = (async () => {
    try {
      const rootKey = framePathKey(target.framePath);
      const root =
        rootCache.get(rootKey) ??
        (() => {
          const resolvedRoot = resolveLocatorRoot(page, target.framePath);
          rootCache.set(rootKey, resolvedRoot);
          return resolvedRoot;
        })();
      const locator = root.locator(selector).first();
      const snapshot = await locator.ariaSnapshot({ timeout: AX_SNAPSHOT_TIMEOUT_MS });
      const semantics = parseObserveAriaSnapshot(snapshot);
      if (hasAccessibilitySemantics(semantics)) {
        stats.axHits += 1;
      }
      return semantics;
    } catch {
      return null;
    }
  })();

  snapshotCache.set(cacheKey, pendingSnapshot);
  return pendingSnapshot;
}

async function readDomFallbackSemantics(
  page: Page,
  target: AccessibilitySelectorRef,
  rootCache: Map<string, ReturnType<typeof resolveLocatorRoot>>,
  fallbackCache: Map<string, Promise<ObserveDomFallbackSemantics | null>>
): Promise<ObserveDomFallbackSemantics | null> {
  const selector = target.selector?.trim();
  if (!selector) {
    return null;
  }

  const cacheKey = accessibilityCacheKeyOf(target);
  const cachedFallback = fallbackCache.get(cacheKey);
  if (cachedFallback) {
    return cachedFallback;
  }

  const pendingFallback = (async () => {
    try {
      const rootKey = framePathKey(target.framePath);
      const root =
        rootCache.get(rootKey) ??
        (() => {
          const resolvedRoot = resolveLocatorRoot(page, target.framePath);
          rootCache.set(rootKey, resolvedRoot);
          return resolvedRoot;
        })();
      const locator = root.locator(selector).first();
      return await locator.evaluate(
        (element, source) =>
          Function('element', source)(element) as ObserveDomFallbackSemantics | null,
        DOM_FALLBACK_SEMANTICS_SCRIPT
      );
    } catch {
      return null;
    }
  })();

  fallbackCache.set(cacheKey, pendingFallback);
  return pendingFallback;
}

function chooseSemanticName(
  fallbackValue: string | undefined,
  semantics: ObserveAccessibilitySemantics | null,
  stats: ObserveAccessibilityStats
): string | undefined {
  const normalizedFallback = normalizeText(fallbackValue);
  const normalizedSemanticName = normalizeText(semantics?.name);

  if (isMeaningfulName(normalizedSemanticName) && normalizedSemanticName === normalizedFallback) {
    return normalizedSemanticName;
  }
  if (isMeaningfulName(fallbackValue)) {
    stats.fallbackUses += 1;
    return fallbackValue;
  }
  if (isMeaningfulName(normalizedSemanticName)) {
    return normalizedSemanticName;
  }
  return fallbackValue;
}

function normalizedContainerKind(value: string | undefined): string {
  return normalizeText(value).toLowerCase();
}

function shouldUseContainerAccessibilityName(
  expectedKind: string | undefined,
  semantics: ObserveAccessibilitySemantics | null
): boolean {
  if (!isMeaningfulName(semantics?.name)) {
    return false;
  }

  const role = normalizedContainerKind(semantics?.role);
  if (!role) {
    return false;
  }
  if (NON_CONTAINER_AX_ROLES.has(role)) {
    return false;
  }

  const expected = normalizedContainerKind(expectedKind);
  if (!expected) {
    return true;
  }

  if (expected === role) {
    return true;
  }

  if (expected === 'form') {
    return role === 'form' || role === 'search';
  }
  if (expected === 'region' || expected === 'section' || expected === 'aside') {
    return role === 'region' || role === 'complementary';
  }
  if (expected === 'fieldset' || expected === 'group') {
    return role === 'group';
  }
  if (expected === 'dialog') {
    return role === 'dialog' || role === 'alertdialog';
  }
  if (expected === 'datepicker') {
    return role === 'dialog' || role === 'grid';
  }
  if (expected === 'grid') {
    return role === 'grid' || role === 'treegrid';
  }

  return false;
}

function chooseContainerSemanticName(
  fallbackValue: string | undefined,
  expectedKind: string | undefined,
  semantics: ObserveAccessibilitySemantics | null,
  stats: ObserveAccessibilityStats
): string | undefined {
  const normalizedFallback = normalizeText(fallbackValue);
  const normalizedSemanticName = normalizeLabelKey(semantics?.name);
  const normalizedSemanticRole = normalizedContainerKind(semantics?.role);

  if (
    isMeaningfulName(normalizedFallback) &&
    (!isMeaningfulName(normalizedSemanticName) ||
      GENERIC_CONTAINER_AX_NAMES.has(normalizedSemanticName) ||
      normalizedSemanticName === normalizedSemanticRole)
  ) {
    stats.fallbackUses += 1;
    return fallbackValue;
  }

  if (shouldUseContainerAccessibilityName(expectedKind, semantics)) {
    return semantics?.name;
  }
  if (isMeaningfulName(fallbackValue)) {
    stats.fallbackUses += 1;
  }
  return fallbackValue;
}

function enrichContextNode(
  node: DomObservedContextNode | undefined,
  semantics: ObserveAccessibilitySemantics | null,
  domFallback: ObserveDomFallbackSemantics | null,
  stats: ObserveAccessibilityStats
): DomObservedContextNode | undefined {
  if (!node) {
    return undefined;
  }

  const fallbackLabel = [fallbackContextNodeLabelOf(node), node.text, domFallback?.label]
    .map((value) => normalizeText(value))
    .find(isMeaningfulName);

  return {
    ...node,
    kind: node.kind ?? semantics?.role,
    label: chooseContainerSemanticName(fallbackLabel, node.kind, semantics, stats),
  };
}

function chooseHintText(
  context: DomObservedTargetContext | undefined,
  nextContext: DomObservedTargetContext | undefined,
  domFallbackHint: string | undefined,
  stats: ObserveAccessibilityStats
): string | undefined {
  const fallbackHint = fallbackHintTextOf(context) ?? normalizeText(domFallbackHint);
  const nextHintCandidate = [
    nextContext?.container?.label,
    nextContext?.landmark?.label,
    nextContext?.group?.label,
  ].find(isMeaningfulName);

  if (isMeaningfulName(nextHintCandidate)) {
    return nextHintCandidate;
  }

  if (fallbackHint) {
    stats.fallbackUses += 1;
    return fallbackHint;
  }

  return undefined;
}

function chooseStructuredGridZone(
  target: DomObservedTarget,
  nextContext: DomObservedTargetContext | undefined,
  surfaceSemantics: ObserveAccessibilitySemantics | null,
  surfaceDomFallback: ObserveDomFallbackSemantics | null,
  containerSemantics: ObserveAccessibilitySemantics | null,
  containerDomFallback: ObserveDomFallbackSemantics | null,
  landmarkSemantics: ObserveAccessibilitySemantics | null,
  landmarkDomFallback: ObserveDomFallbackSemantics | null,
  stats: ObserveAccessibilityStats
): string | undefined {
  if (target.structure?.family !== 'structured-grid' || target.structure.variant !== 'seat-cell') {
    return target.structure?.zone;
  }

  const blockedZoneKeys = new Set(
    [fallbackSurfaceLabelOf(target), target.surfaceLabel]
      .map((value) => normalizeLabelKey(value))
      .filter(Boolean)
  );
  const chooseCandidate = (candidates: Array<string | undefined>): string | undefined => {
    for (const candidate of candidates) {
      const normalized = normalizeText(candidate);
      if (!isMeaningfulName(normalized)) {
        continue;
      }
      if (blockedZoneKeys.has(normalizeLabelKey(normalized))) {
        continue;
      }
      return normalized;
    }
    return undefined;
  };

  const semanticZone = chooseCandidate([
    surfaceSemantics?.name,
    landmarkSemantics?.name,
    containerSemantics?.name,
  ]);
  if (semanticZone) {
    return semanticZone;
  }

  const fallbackZone = chooseCandidate([
    surfaceDomFallback?.label,
    landmarkDomFallback?.label,
    containerDomFallback?.label,
    nextContext?.landmark?.label,
    nextContext?.container?.label,
    nextContext?.group?.label,
    target.structure?.zone,
  ]);
  if (fallbackZone) {
    stats.fallbackUses += 1;
    return fallbackZone;
  }

  return target.structure?.zone;
}

function enrichStructure(
  target: DomObservedTarget,
  nextContext: DomObservedTargetContext | undefined,
  surfaceSemantics: ObserveAccessibilitySemantics | null,
  surfaceDomFallback: ObserveDomFallbackSemantics | null,
  containerSemantics: ObserveAccessibilitySemantics | null,
  containerDomFallback: ObserveDomFallbackSemantics | null,
  landmarkSemantics: ObserveAccessibilitySemantics | null,
  landmarkDomFallback: ObserveDomFallbackSemantics | null,
  stats: ObserveAccessibilityStats
): DomObservedTarget['structure'] {
  if (!target.structure) {
    return target.structure;
  }

  const nextZone = chooseStructuredGridZone(
    target,
    nextContext,
    surfaceSemantics,
    surfaceDomFallback,
    containerSemantics,
    containerDomFallback,
    landmarkSemantics,
    landmarkDomFallback,
    stats
  );

  if (nextZone === target.structure.zone) {
    return target.structure;
  }

  return {
    ...target.structure,
    zone: nextZone,
  };
}

async function enrichTargetWithAccessibility(
  page: Page,
  target: DomObservedTarget,
  rootCache: Map<string, ReturnType<typeof resolveLocatorRoot>>,
  snapshotCache: Map<string, Promise<ObserveAccessibilitySemantics | null>>,
  fallbackCache: Map<string, Promise<ObserveDomFallbackSemantics | null>>,
  stats: ObserveAccessibilityStats
): Promise<DomObservedTarget> {
  const semantics = await readAccessibilitySemantics(page, target, rootCache, snapshotCache, stats);
  const surfaceSemantics = await readAccessibilitySemantics(
    page,
    { selector: target.surfaceSelector, framePath: target.framePath },
    rootCache,
    snapshotCache,
    stats
  );
  const surfaceDomFallback = await readDomFallbackSemantics(
    page,
    { selector: target.surfaceSelector, framePath: target.framePath },
    rootCache,
    fallbackCache
  );

  const itemSemantics = await readAccessibilitySemantics(
    page,
    { selector: target.context?.item?.selector, framePath: target.framePath },
    rootCache,
    snapshotCache,
    stats
  );
  const itemDomFallback = await readDomFallbackSemantics(
    page,
    { selector: target.context?.item?.selector, framePath: target.framePath },
    rootCache,
    fallbackCache
  );
  const groupSemantics = await readAccessibilitySemantics(
    page,
    { selector: target.context?.group?.selector, framePath: target.framePath },
    rootCache,
    snapshotCache,
    stats
  );
  const groupDomFallback = await readDomFallbackSemantics(
    page,
    { selector: target.context?.group?.selector, framePath: target.framePath },
    rootCache,
    fallbackCache
  );
  const containerSemantics = await readAccessibilitySemantics(
    page,
    { selector: target.context?.container?.selector, framePath: target.framePath },
    rootCache,
    snapshotCache,
    stats
  );
  const containerDomFallback = await readDomFallbackSemantics(
    page,
    { selector: target.context?.container?.selector, framePath: target.framePath },
    rootCache,
    fallbackCache
  );
  const landmarkSemantics = await readAccessibilitySemantics(
    page,
    { selector: target.context?.landmark?.selector, framePath: target.framePath },
    rootCache,
    snapshotCache,
    stats
  );
  const landmarkDomFallback = await readDomFallbackSemantics(
    page,
    { selector: target.context?.landmark?.selector, framePath: target.framePath },
    rootCache,
    fallbackCache
  );
  const targetDomFallback = await readDomFallbackSemantics(page, target, rootCache, fallbackCache);

  const nextLabel =
    isMeaningfulName(semantics?.name) &&
    shouldPreferAccessibilityName(
      {
        kind: target.kind,
        role: target.role,
        inputType: target.inputType,
        label: fallbackTargetLabelOf(target),
        text: target.text,
      },
      semantics.name
    )
      ? semantics.name
      : chooseSemanticName(fallbackTargetLabelOf(target), semantics, stats);

  const nextContext: DomObservedTargetContext | undefined = target.context
    ? {
        ...target.context,
        item: enrichContextNode(target.context.item, itemSemantics, itemDomFallback, stats),
        group: enrichContextNode(target.context.group, groupSemantics, groupDomFallback, stats),
        container: enrichContextNode(
          target.context.container,
          containerSemantics,
          containerDomFallback,
          stats
        ),
        landmark: enrichContextNode(
          target.context.landmark,
          landmarkSemantics,
          landmarkDomFallback,
          stats
        ),
      }
    : undefined;
  const nextStructure = enrichStructure(
    target,
    nextContext,
    surfaceSemantics,
    surfaceDomFallback,
    containerSemantics,
    containerDomFallback,
    landmarkSemantics,
    landmarkDomFallback,
    stats
  );

  const usedAxSemantics = Boolean(
    (isMeaningfulName(semantics?.name) && nextLabel === semantics?.name) ||
      (semantics?.role && semantics.role === (target.role ?? semantics.role)) ||
      (semantics?.states && Object.keys(semantics.states).length > 0) ||
      isMeaningfulName(surfaceSemantics?.name) ||
      isMeaningfulName(itemSemantics?.name) ||
      isMeaningfulName(groupSemantics?.name) ||
      isMeaningfulName(containerSemantics?.name) ||
      isMeaningfulName(landmarkSemantics?.name)
  );

  return {
    ...target,
    label: nextLabel,
    displayLabel: chooseDisplayLabel(target, nextLabel),
    role: target.role ?? semantics?.role,
    semanticsSource: usedAxSemantics ? 'aria-snapshot' : (target.semanticsSource ?? 'dom'),
    states:
      semantics?.states && Object.keys(semantics.states).length > 0
        ? { ...(target.states ?? {}), ...(semantics.states ?? {}) }
        : target.states,
    surfaceLabel: chooseContainerSemanticName(
      fallbackSurfaceLabelOf(target) ?? surfaceDomFallback?.label,
      target.surfaceKind,
      surfaceSemantics,
      stats
    ),
    structure: nextStructure,
    context: nextContext
      ? {
          ...nextContext,
          hintText: chooseHintText(target.context, nextContext, targetDomFallback?.hintText, stats),
        }
      : target.context,
  };
}

async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runWorker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index]!, index);
    }
  };

  const concurrency = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  return results;
}

export async function enrichDomTargetsWithAccessibility(
  page: Page,
  targets: ReadonlyArray<DomObservedTarget>,
  options?: ObserveAccessibilityOptions
): Promise<DomObservedTarget[]> {
  const rootCache = new Map<string, ReturnType<typeof resolveLocatorRoot>>();
  const snapshotCache = new Map<string, Promise<ObserveAccessibilitySemantics | null>>();
  const fallbackCache = new Map<string, Promise<ObserveDomFallbackSemantics | null>>();
  const stats = emptyStats();

  const enrichedTargets = await mapWithConcurrency(targets, AX_ENRICHMENT_CONCURRENCY, (target) =>
    enrichTargetWithAccessibility(page, target, rootCache, snapshotCache, fallbackCache, stats)
  );

  options?.onStats?.(stats);
  return enrichedTargets;
}

export const __testObserveAccessibility = {
  parseObserveAriaSnapshot,
};
