import type {
  ExtractScopeLifetime,
  SurfaceDescriptor,
  TargetDescriptor,
  TargetValidationEvidence,
} from '../runtime-state.js';
import type { PersistedFillableForm, ProtectedBindingValueHint } from '../secrets/types.js';
import type { DomObservedTarget } from './observe-inventory.js';
import type { ObservedPageSignal } from './observe-signals.js';
import {
  formGroupingKeyOf,
  isPrimaryFormControlTarget,
  normalizeSemanticDuplicateLabel,
  observedTargetKey,
} from './observe-semantics.js';
import {
  buildSyntheticFormSurfaceId,
  OUTPUT_LEADING_TARGET_LIMIT,
  summarizeContext,
} from './observe-surfaces.js';

export type GoalObserveScopeCandidate = {
  goalInventoryType: 'scope';
  goalSurfaceId: string;
  kind?: string;
  label?: string;
  capability: 'scope';
  surfaceRef?: string;
  surfacePriority?: number;
  framePath?: string[];
  frameUrl?: string;
  pageSignature?: string;
  context?: TargetDescriptor['context'];
  structure?: TargetDescriptor['structure'];
};

export type GoalObserveTargetCandidate = DomObservedTarget & {
  goalInventoryType: 'target';
  goalTargetKey: string;
};

export type GoalObserveInventoryCandidate = GoalObserveTargetCandidate | GoalObserveScopeCandidate;

const WORKFLOW_ROOT_KINDS = new Set([
  'dialog',
  'form',
  'tabpanel',
  'menu',
  'listbox',
  'popover',
  'dropdown',
  'datepicker',
  'card',
]);

type AgentFacingTargetValidationEvidence = Omit<TargetValidationEvidence, 'required'>;

function normalizeClusterText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function normalizeWorkflowSurfaceSelector(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function workflowRootKeyOf(target: DomObservedTarget): string | undefined {
  const contextNodes = [
    target.context?.landmark,
    target.context?.container,
    target.context?.group,
    target.context?.item,
  ];

  for (const node of contextNodes) {
    const kind = normalizeClusterText(node?.kind);
    if (!kind || !WORKFLOW_ROOT_KINDS.has(kind)) {
      continue;
    }

    const label = normalizeClusterText(node?.label ?? node?.text);
    return label ? `${kind}:${label}` : `${kind}:anonymous`;
  }

  const surfaceKind = normalizeClusterText(target.surfaceKind);
  if (!surfaceKind || !WORKFLOW_ROOT_KINDS.has(surfaceKind)) {
    return undefined;
  }

  const surfaceLabel = normalizeClusterText(target.surfaceLabel);
  return surfaceLabel ? `${surfaceKind}:${surfaceLabel}` : `${surfaceKind}:anonymous`;
}

function isActiveControllerTarget(target: DomObservedTarget): boolean {
  if (!normalizeWorkflowSurfaceSelector(target.controlsSurfaceSelector)) {
    return false;
  }

  return target.states?.selected === true || target.states?.expanded === true;
}

function sortObservedTargets(targets: ReadonlyArray<DomObservedTarget>): DomObservedTarget[] {
  return [...targets].sort((left, right) => {
    const leftOrdinal = left.ordinal ?? Number.MAX_SAFE_INTEGER;
    const rightOrdinal = right.ordinal ?? Number.MAX_SAFE_INTEGER;
    if (leftOrdinal !== rightOrdinal) {
      return leftOrdinal - rightOrdinal;
    }
    return (left.label ?? '').localeCompare(right.label ?? '');
  });
}

function selectedSurfaceSelectorsOf(
  selectedTargets: ReadonlyArray<DomObservedTarget>
): Set<string> {
  const selectors = new Set<string>();
  for (const target of selectedTargets) {
    const selector = normalizeWorkflowSurfaceSelector(target.surfaceSelector);
    if (selector) {
      selectors.add(selector);
    }
  }
  return selectors;
}

function compactValidationEvidence(
  validation: TargetValidationEvidence | undefined
): AgentFacingTargetValidationEvidence | undefined {
  if (!validation) {
    return undefined;
  }

  const compacted = {
    invalid: validation.invalid,
    message: validation.message,
    errorStyling: validation.errorStyling,
  };

  return Object.values(compacted).some((value) => value !== undefined) ? compacted : undefined;
}

function selectedSurfaceRefsOf(selectedTargets: ReadonlyArray<DomObservedTarget>): Set<string> {
  return new Set(
    selectedTargets
      .map((target) => target.surfaceRef?.trim())
      .filter((value): value is string => Boolean(value))
  );
}

function matchesSelectedSurfaceSeed(
  target: DomObservedTarget,
  selectedSurfaceIds: ReadonlySet<string>
): boolean {
  if (selectedSurfaceIds.size === 0) {
    return false;
  }

  const surfaceRef = target.surfaceRef?.trim();
  if (surfaceRef && selectedSurfaceIds.has(surfaceRef)) {
    return true;
  }

  const syntheticFormSurfaceId = buildSyntheticFormSurfaceId(target);
  return syntheticFormSurfaceId ? selectedSurfaceIds.has(syntheticFormSurfaceId) : false;
}

function workflowClusterKeyOf(target: DomObservedTarget): string | undefined {
  const formKey = formGroupingKeyOf(target);
  if (formKey) {
    return `form:${formKey}`;
  }

  const surfaceRef = target.surfaceRef?.trim();
  if (surfaceRef) {
    return `surface:${surfaceRef}`;
  }

  const surfaceSelector = normalizeWorkflowSurfaceSelector(target.surfaceSelector);
  return surfaceSelector ? `selector:${surfaceSelector}` : undefined;
}

function matchesWorkflowCluster(target: DomObservedTarget, clusterKey: string): boolean {
  return workflowClusterKeyOf(target) === clusterKey;
}

function canonicalGoalMatchedTarget(
  target: DomObservedTarget,
  allTargets: ReadonlyArray<DomObservedTarget>,
  targetsByOrdinal: ReadonlyMap<number, DomObservedTarget>
): DomObservedTarget {
  if (isPrimaryFormControlTarget(target) || typeof target.ownerIndex !== 'number') {
    return target;
  }

  const ownerTarget = allTargets[target.ownerIndex] ?? targetsByOrdinal.get(target.ownerIndex);
  if (!ownerTarget || !isPrimaryFormControlTarget(ownerTarget)) {
    return target;
  }

  const targetLabel = normalizeSemanticDuplicateLabel(target);
  const ownerLabel = normalizeSemanticDuplicateLabel(ownerTarget);
  if (!targetLabel || !ownerLabel || targetLabel !== ownerLabel) {
    return target;
  }

  const targetFormKey = formGroupingKeyOf(target);
  const ownerFormKey = formGroupingKeyOf(ownerTarget);
  if (
    targetFormKey &&
    ownerFormKey &&
    targetFormKey !== ownerFormKey &&
    target.surfaceRef !== ownerTarget.surfaceRef
  ) {
    return target;
  }

  return ownerTarget;
}

function isTerminalWorkflowActionTarget(target: DomObservedTarget): boolean {
  const acceptancePolicy = (target.acceptancePolicy ?? '').trim().toLowerCase();
  const inputType = (target.inputType ?? '').trim().toLowerCase();
  return acceptancePolicy === 'submit' || inputType === 'submit';
}

function canJoinSelectedWorkflowRoot(
  target: DomObservedTarget,
  selectedSurfaceRefs: ReadonlySet<string>,
  selectedSurfaceSelectors: ReadonlySet<string>
): boolean {
  if (!isPrimaryFormControlTarget(target)) {
    return false;
  }

  const surfaceRef = target.surfaceRef?.trim();
  if (surfaceRef && selectedSurfaceRefs.has(surfaceRef)) {
    return true;
  }

  const surfaceSelector = normalizeWorkflowSurfaceSelector(target.surfaceSelector);
  if (surfaceSelector && selectedSurfaceSelectors.has(surfaceSelector)) {
    return true;
  }

  const surfaceKind = normalizeClusterText(target.surfaceKind);
  return surfaceKind === 'dialog' || surfaceKind === 'form' || (!surfaceRef && !surfaceSelector);
}

function shouldExpandAcrossWorkflowRoots(
  selectedPrimaryTargets: ReadonlyArray<DomObservedTarget>,
  selectedSurfaceSelectors: ReadonlySet<string>
): boolean {
  if (selectedSurfaceSelectors.size > 0) {
    return true;
  }

  return selectedPrimaryTargets.some((target) => Boolean(target.framePath?.length));
}

type ExpandWorkflowGraphTargetOptions = {
  selectedSurfaceIds?: ReadonlySet<string>;
};

export function expandWorkflowGraphTargets(
  allTargets: ReadonlyArray<DomObservedTarget>,
  selectedTargets: ReadonlyArray<DomObservedTarget>,
  options: ExpandWorkflowGraphTargetOptions = {}
): DomObservedTarget[] {
  const selectedSurfaceIds = options.selectedSurfaceIds ?? new Set<string>();
  if (selectedTargets.length === 0 && selectedSurfaceIds.size === 0) {
    return [];
  }

  const expanded = new Map<string, DomObservedTarget>();
  for (const target of selectedTargets) {
    expanded.set(observedTargetKey(target), target);
  }

  for (const target of allTargets) {
    const key = observedTargetKey(target);
    if (expanded.has(key) || !matchesSelectedSurfaceSeed(target, selectedSurfaceIds)) {
      continue;
    }

    expanded.set(key, target);
  }

  const seededTargets = [...expanded.values()];
  const selectedSurfaceSelectors = selectedSurfaceSelectorsOf(seededTargets);
  const selectedSurfaceRefs = selectedSurfaceRefsOf(seededTargets);
  const selectedPrimaryTargets = seededTargets.filter(isPrimaryFormControlTarget);
  const selectedClusterCounts = new Map<string, number>();

  for (const target of selectedPrimaryTargets) {
    const clusterKey = workflowClusterKeyOf(target);
    if (!clusterKey) {
      continue;
    }
    selectedClusterCounts.set(clusterKey, (selectedClusterCounts.get(clusterKey) ?? 0) + 1);
  }

  for (const target of allTargets) {
    const key = observedTargetKey(target);
    if (expanded.has(key) || !isActiveControllerTarget(target)) {
      continue;
    }

    const controlsSurfaceSelector = normalizeWorkflowSurfaceSelector(
      target.controlsSurfaceSelector
    );
    if (!controlsSurfaceSelector || !selectedSurfaceSelectors.has(controlsSurfaceSelector)) {
      continue;
    }

    expanded.set(key, target);
  }

  const expandableClusterKeys = new Set(
    [...selectedClusterCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([clusterKey]) => clusterKey)
  );

  for (const target of allTargets) {
    const key = observedTargetKey(target);
    if (expanded.has(key) || !isPrimaryFormControlTarget(target)) {
      continue;
    }

    const clusterKey = workflowClusterKeyOf(target);
    if (
      !clusterKey ||
      !expandableClusterKeys.has(clusterKey) ||
      !matchesWorkflowCluster(target, clusterKey)
    ) {
      continue;
    }

    expanded.set(key, target);
  }

  const expandedPrimaryTargets = [...expanded.values()].filter(isPrimaryFormControlTarget);
  const selectedRootCounts = new Map<string, number>();
  for (const target of expandedPrimaryTargets) {
    const workflowRootKey = workflowRootKeyOf(target);
    if (!workflowRootKey) {
      continue;
    }
    selectedRootCounts.set(workflowRootKey, (selectedRootCounts.get(workflowRootKey) ?? 0) + 1);
  }

  const selectedWorkflowRoots = new Set(
    [...selectedRootCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([workflowRootKey]) => workflowRootKey)
  );
  if (
    selectedWorkflowRoots.size === 0 ||
    !shouldExpandAcrossWorkflowRoots(expandedPrimaryTargets, selectedSurfaceSelectors)
  ) {
    return sortObservedTargets([...expanded.values()]);
  }

  const rootClosureCandidates: Array<{
    key: string;
    target: DomObservedTarget;
    workflowRootKey: string;
  }> = [];
  const rootTerminalCandidateCounts = new Map<string, number>();

  for (const target of allTargets) {
    const key = observedTargetKey(target);
    if (expanded.has(key)) {
      continue;
    }

    const workflowRootKey = workflowRootKeyOf(target);
    if (!workflowRootKey || !selectedWorkflowRoots.has(workflowRootKey)) {
      continue;
    }

    if (!canJoinSelectedWorkflowRoot(target, selectedSurfaceRefs, selectedSurfaceSelectors)) {
      continue;
    }

    rootClosureCandidates.push({ key, target, workflowRootKey });
    if (isTerminalWorkflowActionTarget(target)) {
      rootTerminalCandidateCounts.set(
        workflowRootKey,
        (rootTerminalCandidateCounts.get(workflowRootKey) ?? 0) + 1
      );
    }
  }

  for (const candidate of rootClosureCandidates) {
    if (
      isTerminalWorkflowActionTarget(candidate.target) &&
      (rootTerminalCandidateCounts.get(candidate.workflowRootKey) ?? 0) > 1
    ) {
      continue;
    }

    expanded.set(candidate.key, candidate.target);
  }

  return sortObservedTargets([...expanded.values()]);
}

function isActionLikeGoalTarget(target: DomObservedTarget): boolean {
  const actions = target.allowedActions ?? [];
  const kind = (target.kind ?? '').trim().toLowerCase();
  const role = (target.role ?? '').trim().toLowerCase();
  const isValueControl =
    actions.includes('fill') || actions.includes('type') || actions.includes('select');
  if (isValueControl) {
    return false;
  }

  return (
    actions.includes('click') ||
    actions.includes('press') ||
    kind === 'button' ||
    role === 'button' ||
    kind === 'link' ||
    role === 'link'
  );
}

function goalActionClusterKey(target: DomObservedTarget): string | undefined {
  const itemKey = normalizeClusterText(target.context?.item?.label ?? target.context?.item?.text);
  const groupKey = normalizeClusterText(
    target.context?.group?.label ?? target.context?.group?.text
  );
  const containerKey = normalizeClusterText(
    target.context?.container?.label ?? target.context?.container?.text
  );

  const parts = [
    target.surfaceRef ? `surface:${target.surfaceRef}` : undefined,
    itemKey ? `item:${itemKey}` : undefined,
    groupKey ? `group:${groupKey}` : undefined,
    containerKey ? `container:${containerKey}` : undefined,
  ].filter((value): value is string => Boolean(value));

  return parts.length > 0 ? parts.join('|') : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripContextTokens(
  value: string | undefined,
  suppressedTokens: ReadonlyArray<string>
): string | undefined {
  if (!value) {
    return value;
  }

  let sanitized = value;
  for (const token of suppressedTokens) {
    if (!token) {
      continue;
    }
    sanitized = sanitized.replace(new RegExp(escapeRegExp(token), 'gi'), ' ');
  }

  const collapsed = sanitized
    .replace(/\s+[—-]\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed || undefined;
}

function suppressionKeyOf(value: string | undefined): string | undefined {
  const normalized = normalizeClusterText(value);
  return normalized || undefined;
}

function isLikelyTransientChoiceText(value: string | undefined): value is string {
  const normalized = normalizeClusterText(value);
  if (!normalized) {
    return false;
  }

  return normalized.length >= 12 && normalized.split(' ').length >= 2;
}

function hasInformativeContextText(context: DomObservedTarget['context']): boolean {
  return Boolean(
    suppressionKeyOf(context?.item?.label ?? context?.item?.text) ||
      suppressionKeyOf(context?.group?.label ?? context?.group?.text) ||
      suppressionKeyOf(context?.container?.label ?? context?.container?.text) ||
      suppressionKeyOf(context?.landmark?.label ?? context?.landmark?.text) ||
      suppressionKeyOf(context?.hintText)
  );
}

function isLikelyAutocompleteChoiceTarget(target: DomObservedTarget): boolean {
  if (!isActionLikeGoalTarget(target)) {
    return false;
  }

  const kind = normalizeClusterText(target.kind);
  const role = normalizeClusterText(target.role);
  if (kind === 'button' || role === 'button' || kind === 'link' || role === 'link') {
    return false;
  }

  if ((target.acceptancePolicy ?? '').trim().toLowerCase() === 'submit') {
    return false;
  }

  const normalizedControlFamily = normalizeClusterText(target.controlFamily);
  if (normalizedControlFamily && normalizedControlFamily !== 'trigger') {
    return false;
  }

  if (hasInformativeContextText(target.context)) {
    return false;
  }

  return [target.label, target.currentValue, target.text].some(isLikelyTransientChoiceText);
}

function collectTransientAutocompleteChoiceTexts(
  targets: ReadonlyArray<DomObservedTarget>
): string[] {
  const collected: string[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (!isLikelyAutocompleteChoiceTarget(target)) {
      continue;
    }

    for (const value of [target.currentValue, target.text, target.label]) {
      const normalized = suppressionKeyOf(value);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      collected.push(value ?? normalized);
    }
  }

  return collected;
}

function sanitizeContextNode<T extends { label?: string; text?: string } | undefined>(
  node: T,
  suppressedTokens: ReadonlyArray<string>
): T {
  if (!node) {
    return node;
  }

  return {
    ...node,
    label: stripContextTokens(node.label, suppressedTokens),
    text: stripContextTokens(node.text, suppressedTokens),
  } as T;
}

function sanitizeTargetContext<
  T extends
    | {
        item?: unknown;
        group?: unknown;
        container?: unknown;
        landmark?: unknown;
        hintText?: string;
      }
    | undefined,
>(context: T, suppressedTokens: ReadonlyArray<string>): T {
  if (!context) {
    return context;
  }

  return {
    ...context,
    item: sanitizeContextNode(
      context.item as { label?: string; text?: string } | undefined,
      suppressedTokens
    ),
    group: sanitizeContextNode(
      context.group as { label?: string; text?: string } | undefined,
      suppressedTokens
    ),
    container: sanitizeContextNode(
      context.container as { label?: string; text?: string } | undefined,
      suppressedTokens
    ),
    landmark: sanitizeContextNode(
      context.landmark as { label?: string; text?: string } | undefined,
      suppressedTokens
    ),
    hintText: stripContextTokens(context.hintText, suppressedTokens),
  } as T;
}

function sanitizeGoalTargetContext(
  target: DomObservedTarget,
  siblingLabelsByCluster: ReadonlyMap<string, string[]>,
  transientAutocompleteChoiceTexts: ReadonlyArray<string>
): DomObservedTarget {
  if (!isActionLikeGoalTarget(target)) {
    return target;
  }

  const clusterKey = goalActionClusterKey(target);
  if (!clusterKey) {
    return target;
  }

  const ownLabel = normalizeClusterText(target.label);
  const siblingLabels = (siblingLabelsByCluster.get(clusterKey) ?? []).filter(
    (label) => label !== ownLabel
  );
  const suppressedTokens =
    (target.acceptancePolicy ?? '').trim().toLowerCase() === 'submit'
      ? [...siblingLabels, ...transientAutocompleteChoiceTexts]
      : siblingLabels;
  if (suppressedTokens.length === 0 || !target.context) {
    return target;
  }

  return {
    ...target,
    context: {
      ...sanitizeTargetContext(target.context, suppressedTokens),
    },
  };
}

export function compactTargets(
  targets: ReadonlyArray<
    Pick<
      TargetDescriptor,
      | 'ref'
      | 'kind'
      | 'label'
      | 'displayLabel'
      | 'placeholder'
      | 'inputName'
      | 'inputType'
      | 'autocomplete'
      | 'validation'
      | 'context'
      | 'semantics'
      | 'structure'
      | 'capability'
      | 'availability'
      | 'surfaceRef'
    >
  >
): Array<{
  ref: string;
  kind?: string;
  label?: string;
  displayLabel?: string;
  placeholder?: string;
  inputName?: string;
  inputType?: string;
  autocomplete?: string;
  validation?: AgentFacingTargetValidationEvidence;
  context?: string;
  state?: Record<string, string | boolean | number>;
  structure?: TargetDescriptor['structure'];
  capability?: TargetDescriptor['capability'];
  availability?: string;
  availabilityReason?: string;
  surfaceRef?: string;
  source?: 'dom' | 'stagehand' | 'aria-snapshot' | 'cdp-ax';
}> {
  return targets.map((target) => ({
    ref: target.ref,
    kind: target.kind,
    label: target.label,
    displayLabel: target.displayLabel,
    placeholder: target.placeholder,
    inputName: target.inputName,
    inputType: target.inputType,
    autocomplete: target.autocomplete,
    validation: compactValidationEvidence(target.validation),
    context: summarizeContext(target.context),
    state: target.semantics?.states,
    structure: target.structure,
    capability: target.capability,
    availability: target.availability?.state,
    availabilityReason: target.availability?.reason,
    surfaceRef: target.surfaceRef,
    source: target.semantics?.source,
  }));
}

export type CompactObservedTarget = ReturnType<typeof compactTargets>[number];

export function compactScopes(
  scopes: ReadonlyArray<
    Pick<
      SurfaceDescriptor,
      | 'ref'
      | 'kind'
      | 'label'
      | 'availability'
      | 'parentSurfaceRef'
      | 'childSurfaceRefs'
      | 'targetRefs'
      | 'extractScopeLifetime'
    >
  >
): Array<{
  ref: string;
  kind?: string;
  label?: string;
  capability: 'scope';
  availability?: string;
  availabilityReason?: string;
  parentSurfaceRef?: string;
  childSurfaceRefs?: string[];
  targetRefs?: string[];
  extractScopeLifetime?: ExtractScopeLifetime;
  source: 'dom';
}> {
  return scopes.map((scope) => ({
    ref: scope.ref,
    kind: scope.kind,
    label: scope.label,
    capability: 'scope' as const,
    availability: scope.availability?.state,
    availabilityReason: scope.availability?.reason,
    parentSurfaceRef: scope.parentSurfaceRef,
    childSurfaceRefs: scope.childSurfaceRefs ? [...scope.childSurfaceRefs] : [],
    targetRefs: scope.targetRefs ? [...scope.targetRefs] : [],
    extractScopeLifetime: scope.extractScopeLifetime,
    source: 'dom' as const,
  }));
}

export type CompactObservedScope = {
  ref: string;
  kind?: string;
  label?: string;
  capability: 'scope';
  availability?: string;
  availabilityReason?: string;
  parentSurfaceRef?: string;
  childSurfaceRefs?: string[];
  extractScopeLifetime?: ExtractScopeLifetime;
  targets: CompactObservedTarget[];
  source: 'dom' | 'stagehand' | 'aria-snapshot' | 'cdp-ax';
};

type BuildGroupedObserveScopesOptions = {
  pageRef: string;
  title?: string;
  scopes: ReadonlyArray<
    Pick<
      SurfaceDescriptor,
      | 'ref'
      | 'kind'
      | 'label'
      | 'availability'
      | 'parentSurfaceRef'
      | 'childSurfaceRefs'
      | 'extractScopeLifetime'
    >
  >;
  targets: ReadonlyArray<
    Pick<
      TargetDescriptor,
      | 'ref'
      | 'kind'
      | 'label'
      | 'displayLabel'
      | 'placeholder'
      | 'inputName'
      | 'inputType'
      | 'autocomplete'
      | 'validation'
      | 'context'
      | 'semantics'
      | 'structure'
      | 'capability'
      | 'availability'
      | 'surfaceRef'
    >
  >;
};

function compactScopeSource(
  targets: ReadonlyArray<CompactObservedTarget>
): 'dom' | 'stagehand' | 'aria-snapshot' | 'cdp-ax' {
  return targets.find((target) => typeof target.source === 'string')?.source ?? 'dom';
}

export function buildGroupedObserveScopes(
  options: BuildGroupedObserveScopesOptions
): CompactObservedScope[] {
  const compactedTargets = compactTargets(options.targets);
  const scopeRefs = new Set(options.scopes.map((scope) => scope.ref));
  const compactedTargetsByScope = new Map<string, CompactObservedTarget[]>();
  const leadingPageTargetRefs = new Set(
    compactedTargets
      .slice(0, OUTPUT_LEADING_TARGET_LIMIT)
      .filter((target) => (target.surfaceRef?.trim() ?? '').length === 0)
      .map((target) => target.ref)
  );
  const unscopedTargets: CompactObservedTarget[] = [];

  for (const target of compactedTargets) {
    const surfaceRef = target.surfaceRef?.trim();
    if (surfaceRef) {
      if (!scopeRefs.has(surfaceRef)) {
        continue;
      }

      const grouped = compactedTargetsByScope.get(surfaceRef) ?? [];
      grouped.push(target);
      compactedTargetsByScope.set(surfaceRef, grouped);
      continue;
    }

    if (leadingPageTargetRefs.has(target.ref)) {
      unscopedTargets.push(target);
    }
  }

  const groupedScopes: CompactObservedScope[] = options.scopes.map((scope) => {
    const scopeTargets = compactedTargetsByScope.get(scope.ref) ?? [];
    const visibleChildSurfaceRefs = (scope.childSurfaceRefs ?? []).filter((ref) =>
      scopeRefs.has(ref)
    );

    return {
      ref: scope.ref,
      kind: scope.kind,
      label: scope.label,
      capability: 'scope',
      availability: scope.availability?.state,
      availabilityReason: scope.availability?.reason,
      parentSurfaceRef:
        scope.parentSurfaceRef && scopeRefs.has(scope.parentSurfaceRef)
          ? scope.parentSurfaceRef
          : undefined,
      childSurfaceRefs: visibleChildSurfaceRefs,
      extractScopeLifetime: scope.extractScopeLifetime,
      targets: scopeTargets,
      source: compactScopeSource(scopeTargets),
    };
  });

  if (unscopedTargets.length === 0) {
    return groupedScopes;
  }

  return [
    ...groupedScopes,
    {
      ref: `page:${options.pageRef}`,
      kind: 'page',
      label: options.title ?? 'Page',
      capability: 'scope',
      availability: 'available',
      childSurfaceRefs: [],
      extractScopeLifetime: 'snapshot',
      targets: unscopedTargets,
      source: compactScopeSource(unscopedTargets),
    },
  ];
}

export function compactFillableForms(forms: ReadonlyArray<PersistedFillableForm>): Array<{
  fillRef: string;
  scopeRef?: string;
  purpose: string;
  presence: 'present' | 'unknown';
  fields: Array<{
    fieldKey: string;
    targetRef: string;
    label?: string;
    required?: boolean;
    valueHint?: ProtectedBindingValueHint;
  }>;
  storedSecretCandidates: Array<{
    storedSecretRef: string;
    kind: string;
    scope: string;
    displayName: string;
    matchConfidence: 'high' | 'medium' | 'low';
    intentRequired: boolean;
  }>;
}> {
  return forms
    .filter((form) => form.presence !== 'absent')
    .map((form) => ({
      fillRef: form.fillRef,
      scopeRef: form.scopeRef,
      purpose: form.purpose,
      presence: form.presence === 'unknown' ? 'unknown' : 'present',
      fields: form.fields.map((field) => ({
        fieldKey: field.fieldKey,
        targetRef: field.targetRef,
        label: field.label,
        required: field.required,
        valueHint: field.valueHint,
      })),
      storedSecretCandidates: form.storedSecretCandidates.map((candidate) => ({
        storedSecretRef: candidate.storedSecretRef,
        kind: candidate.kind,
        scope: candidate.scope,
        displayName: candidate.displayName,
        matchConfidence: candidate.matchConfidence,
        intentRequired: candidate.intentRequired,
      })),
    }));
}

export type CompactObservedFillableForm = ReturnType<typeof compactFillableForms>[number];

export function compactSignals(signals: ReadonlyArray<ObservedPageSignal>): Array<{
  kind: ObservedPageSignal['kind'];
  text: string;
  framePath?: string[];
  source: 'dom';
}> {
  return signals.map((signal) => ({
    kind: signal.kind,
    text: signal.text,
    framePath: signal.framePath,
    source: signal.source,
  }));
}

export type CompactObservedSignal = ReturnType<typeof compactSignals>[number];

export function buildGoalObserveInventoryCandidates(
  targets: ReadonlyArray<DomObservedTarget>,
  surfaces: ReadonlyArray<Omit<SurfaceDescriptor, 'ref'>>
): GoalObserveInventoryCandidate[] {
  const siblingLabelsByCluster = new Map<string, string[]>();
  const transientAutocompleteChoiceTexts = collectTransientAutocompleteChoiceTexts(targets);
  for (const target of targets) {
    if (!isActionLikeGoalTarget(target)) {
      continue;
    }

    const clusterKey = goalActionClusterKey(target);
    const normalizedLabel = normalizeClusterText(target.label);
    if (!clusterKey || !normalizedLabel) {
      continue;
    }

    const labels = siblingLabelsByCluster.get(clusterKey) ?? [];
    if (!labels.includes(normalizedLabel)) {
      labels.push(normalizedLabel);
      siblingLabelsByCluster.set(clusterKey, labels);
    }
  }

  const targetCandidates: GoalObserveTargetCandidate[] = targets.map((target) => {
    const sanitized = sanitizeGoalTargetContext(
      target,
      siblingLabelsByCluster,
      transientAutocompleteChoiceTexts
    );
    const syntheticFormSurfaceId = buildSyntheticFormSurfaceId(sanitized);
    const surfaceRef = sanitized.surfaceRef ?? syntheticFormSurfaceId;
    const surfaceKind = sanitized.surfaceKind ?? (syntheticFormSurfaceId ? 'form' : undefined);
    const surfaceLabel =
      sanitized.surfaceLabel ??
      (syntheticFormSurfaceId
        ? (sanitized.context?.landmark?.label ?? sanitized.context?.group?.label ?? 'Form')
        : undefined);
    const surfacePriority = sanitized.surfacePriority ?? (surfaceKind === 'form' ? 70 : undefined);

    return {
      ...sanitized,
      surfaceRef,
      surfaceKind,
      surfaceLabel,
      surfacePriority,
      goalInventoryType: 'target',
      goalTargetKey: observedTargetKey(target),
    };
  });

  const scopeCandidates: GoalObserveScopeCandidate[] = surfaces.map((surface) => {
    const linkedTargets = targets.filter((target) => target.surfaceRef === surface.surfaceId);
    const primaryLinkedTarget = linkedTargets[0];

    return {
      goalInventoryType: 'scope',
      goalSurfaceId: surface.surfaceId,
      kind: surface.kind,
      label: surface.label,
      capability: 'scope',
      surfaceRef: `scope:${surface.surfaceId}`,
      surfacePriority:
        linkedTargets.reduce((best, target) => Math.max(best, target.surfacePriority ?? 0), 0) ||
        undefined,
      framePath: surface.framePath,
      frameUrl: surface.frameUrl,
      pageSignature: surface.pageSignature,
      context: primaryLinkedTarget?.context,
      structure: primaryLinkedTarget?.structure,
    };
  });

  return [...targetCandidates, ...scopeCandidates];
}

function isGoalObserveTargetCandidate(
  candidate: GoalObserveInventoryCandidate
): candidate is GoalObserveTargetCandidate {
  return candidate.goalInventoryType === 'target';
}

function isGoalObserveScopeCandidate(
  candidate: GoalObserveInventoryCandidate
): candidate is GoalObserveScopeCandidate {
  return candidate.goalInventoryType === 'scope';
}

export function selectTargetsForGoalMatches(
  allTargets: ReadonlyArray<DomObservedTarget>,
  rerankedCandidates: ReadonlyArray<GoalObserveInventoryCandidate>
): {
  targets: DomObservedTarget[];
  selectedSurfaceIds: Set<string>;
} {
  const directTargetOrdinals = new Set<number>();
  const directTargetKeys = new Set<string>();
  const selectedSurfaceIds = new Set(
    rerankedCandidates
      .filter(isGoalObserveScopeCandidate)
      .map((candidate) => candidate.goalSurfaceId)
  );
  const targetsByOrdinal = new Map<number, DomObservedTarget>();
  for (const target of allTargets) {
    if (typeof target.ordinal === 'number') {
      targetsByOrdinal.set(target.ordinal, target);
    }
  }

  const matchedTargets: DomObservedTarget[] = [];
  const seenTargetKeys = new Set<string>();

  for (const candidate of rerankedCandidates) {
    if (!isGoalObserveTargetCandidate(candidate)) {
      continue;
    }

    if (typeof candidate.ordinal === 'number') {
      directTargetOrdinals.add(candidate.ordinal);
    }
    if (typeof candidate.goalTargetKey === 'string' && candidate.goalTargetKey.length > 0) {
      directTargetKeys.add(candidate.goalTargetKey);
    }

    const matchedTarget = allTargets.find((target) => {
      const directMatch =
        typeof candidate.ordinal === 'number' &&
        typeof target.ordinal === 'number' &&
        target.ordinal === candidate.ordinal;
      const directKeyMatch = observedTargetKey(target) === candidate.goalTargetKey;
      return directMatch || directKeyMatch;
    });

    if (!matchedTarget) {
      continue;
    }

    const canonicalTarget = canonicalGoalMatchedTarget(matchedTarget, allTargets, targetsByOrdinal);
    const observedKey = observedTargetKey(canonicalTarget);
    if (seenTargetKeys.has(observedKey)) {
      continue;
    }

    seenTargetKeys.add(observedKey);
    matchedTargets.push(canonicalTarget);
  }

  return {
    targets: matchedTargets,
    selectedSurfaceIds,
  };
}

export function buildGoalProjectionScopeRefs(
  projectedTargets: ReadonlyArray<Pick<TargetDescriptor, 'surfaceRef'>>,
  selectedSurfaceIds: ReadonlySet<string>,
  surfaceRefMap: ReadonlyMap<string, string>
): Set<string> {
  const preferredScopeRefs = new Set<string>();

  for (const surfaceId of selectedSurfaceIds) {
    const scopeRef = surfaceRefMap.get(surfaceId);
    if (scopeRef) {
      preferredScopeRefs.add(scopeRef);
    }
  }

  for (const target of projectedTargets) {
    const surfaceRef = target.surfaceRef?.trim();
    if (surfaceRef) {
      preferredScopeRefs.add(surfaceRef);
    }
  }

  return preferredScopeRefs;
}

export function projectPersistedTargetsForGoal(
  domTargets: ReadonlyArray<DomObservedTarget>,
  persistedTargets: ReadonlyArray<TargetDescriptor>,
  selectedTargets: ReadonlyArray<DomObservedTarget>
): TargetDescriptor[] {
  const persistedByKey = new Map<string, TargetDescriptor>();
  const persistedByOrdinal = new Map<number, TargetDescriptor>();

  persistedTargets.forEach((target, index) => {
    const domTarget = domTargets[index];
    if (!domTarget) {
      return;
    }

    persistedByKey.set(observedTargetKey(domTarget), target);
    if (typeof domTarget.ordinal === 'number') {
      persistedByOrdinal.set(domTarget.ordinal, target);
    }
  });

  const siblingLabelsByCluster = new Map<string, string[]>();
  const transientAutocompleteChoiceTexts = collectTransientAutocompleteChoiceTexts(domTargets);
  for (const target of domTargets) {
    if (!isActionLikeGoalTarget(target)) {
      continue;
    }

    const clusterKey = goalActionClusterKey(target);
    const normalizedLabel = normalizeClusterText(target.label);
    if (!clusterKey || !normalizedLabel) {
      continue;
    }

    const labels = siblingLabelsByCluster.get(clusterKey) ?? [];
    if (!labels.includes(normalizedLabel)) {
      labels.push(normalizedLabel);
      siblingLabelsByCluster.set(clusterKey, labels);
    }
  }

  const projected: TargetDescriptor[] = [];
  const seenRefs = new Set<string>();
  for (const selectedTarget of selectedTargets) {
    const byKey = persistedByKey.get(observedTargetKey(selectedTarget));
    const byOrdinal =
      typeof selectedTarget.ordinal === 'number'
        ? persistedByOrdinal.get(selectedTarget.ordinal)
        : undefined;
    const persistedTarget = byKey ?? byOrdinal;
    if (!persistedTarget || seenRefs.has(persistedTarget.ref)) {
      continue;
    }
    seenRefs.add(persistedTarget.ref);

    const ownLabel = normalizeClusterText(selectedTarget.label);
    const siblingLabels = (
      siblingLabelsByCluster.get(goalActionClusterKey(selectedTarget) ?? '') ?? []
    ).filter((label) => label !== ownLabel);
    const suppressedTokens =
      (selectedTarget.acceptancePolicy ?? '').trim().toLowerCase() === 'submit'
        ? [...siblingLabels, ...transientAutocompleteChoiceTexts]
        : siblingLabels;

    projected.push(
      suppressedTokens.length > 0 && persistedTarget.context
        ? {
            ...persistedTarget,
            context: sanitizeTargetContext(persistedTarget.context, suppressedTokens),
          }
        : persistedTarget
    );
  }

  return projected;
}
