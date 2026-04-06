import type { BrowserSessionState } from './browser-session-state.js';
import type { PersistedFillableForm, SecretCatalogSnapshot } from './secrets/types.js';
import { resolveCachedSecretCatalogForHost } from './secrets/catalog-applicability.js';
import { protectedBindingKey } from './secrets/protected-bindings.js';
import {
  inferAcceptancePolicyFromFacts,
  inferAllowedActionsFromFacts,
  inferAvailabilityFromFacts,
  inferControlFamilyFromFacts,
} from './control-semantics.js';

export type LocatorStrategy =
  | 'role'
  | 'label'
  | 'placeholder'
  | 'text'
  | 'title'
  | 'testId'
  | 'css'
  | 'xpath';

export interface LocatorCandidate {
  strategy: LocatorStrategy;
  value: string;
  name?: string;
  attribute?: 'data-testid' | 'data-test-id';
  scope?: 'root' | 'surface';
}

export function locatorCandidateKey(
  candidate: Pick<LocatorCandidate, 'strategy' | 'value' | 'name' | 'attribute' | 'scope'>
): string {
  return [
    candidate.strategy,
    candidate.name ?? '',
    candidate.value,
    candidate.attribute ?? '',
    candidate.scope ?? '',
  ].join(':');
}

export interface TargetSemantics {
  role?: string;
  name?: string;
  states?: Record<string, string | boolean | number>;
  source?: 'dom' | 'stagehand' | 'aria-snapshot' | 'cdp-ax';
}

export type TargetCapability = 'actionable' | 'scope' | 'informational';
export type TargetLifecycle = 'live' | 'stale' | 'invalidated';
export type TargetAvailability = 'available' | 'gated' | 'surface-inactive' | 'hidden';
export type TargetAllowedAction = 'click' | 'fill' | 'type' | 'select' | 'press';
export type TargetControlFamily =
  | 'text-input'
  | 'select'
  | 'datepicker'
  | 'structured-grid'
  | 'trigger';
export type TargetAcceptancePolicy =
  | 'value-change'
  | 'selection'
  | 'toggle'
  | 'disclosure'
  | 'date-selection'
  | 'submit'
  | 'navigation'
  | 'generic-click';

export interface TargetAvailabilityState {
  state: TargetAvailability;
  reason?: string;
}

export interface TargetContextNode {
  kind?: string;
  label?: string;
  text?: string;
  selector?: string;
}

export interface TargetVisualContext {
  emphasis?: 'muted' | 'normal' | 'strong';
  fill?: 'none' | 'light' | 'mid' | 'dark';
  outlined?: boolean;
}

export interface TargetStructure {
  family?: 'structured-grid';
  variant?: 'date-cell' | 'seat-cell' | 'grid-cell';
  row?: string;
  column?: string;
  zone?: string;
  cellLabel?: string;
}

export interface TargetContext {
  item?: TargetContextNode;
  group?: TargetContextNode;
  container?: TargetContextNode;
  landmark?: TargetContextNode;
  layout?: {
    lane?: 'left' | 'center' | 'right';
    band?: 'top' | 'middle' | 'bottom';
  };
  hintText?: string;
  visual?: TargetVisualContext;
}

export interface TargetValidationEvidence {
  invalid?: boolean;
  required?: boolean;
  message?: string;
  errorStyling?: boolean;
}

export interface TargetDescriptor {
  ref: string;
  pageRef: string;
  framePath?: string[];
  frameUrl?: string;
  kind?: string;
  label?: string;
  displayLabel?: string;
  placeholder?: string;
  inputName?: string;
  inputType?: string;
  autocomplete?: string;
  ariaAutocomplete?: string;
  surfaceKind?: string;
  controlsSurfaceSelector?: string;
  validation?: TargetValidationEvidence;
  capability: TargetCapability;
  lifecycle: TargetLifecycle;
  availability: TargetAvailabilityState;
  allowedActions: TargetAllowedAction[];
  controlFamily?: TargetControlFamily;
  acceptancePolicy?: TargetAcceptancePolicy;
  surfaceRef?: string;
  ownerRef?: string;
  locatorCandidates: LocatorCandidate[];
  semantics?: TargetSemantics;
  structure?: TargetStructure;
  context?: TargetContext;
  stagehandAction?: unknown;
  createdAt: number;
  pageSignature?: string;
  domSignature?: string;
  lifecycleReason?: string;
}

type TargetDescriptorInput = Omit<
  TargetDescriptor,
  'ref' | 'capability' | 'lifecycle' | 'availability' | 'allowedActions'
> & {
  ref?: string;
  capability?: TargetCapability;
  lifecycle?: TargetLifecycle;
  availability?: TargetAvailabilityState;
  allowedActions?: TargetAllowedAction[];
};

function inferLegacyActionMethod(descriptor: TargetDescriptorInput): string {
  const kind = (descriptor.kind ?? '').toLowerCase();
  if (['click', 'fill', 'type', 'select', 'press'].includes(kind)) {
    return kind;
  }

  const stagehandAction = descriptor.stagehandAction;
  if (
    stagehandAction &&
    typeof stagehandAction === 'object' &&
    !Array.isArray(stagehandAction) &&
    typeof (stagehandAction as { method?: unknown }).method === 'string'
  ) {
    return ((stagehandAction as { method: string }).method ?? '').toLowerCase();
  }

  return '';
}

function inferAllowedActions(descriptor: TargetDescriptorInput): TargetAllowedAction[] {
  const legacyMethod = inferLegacyActionMethod(descriptor);
  return inferAllowedActionsFromFacts({
    kind: descriptor.kind,
    role: descriptor.semantics?.role,
    label: descriptor.label,
    displayLabel: descriptor.displayLabel,
    placeholder: descriptor.placeholder,
    inputName: descriptor.inputName,
    inputType: descriptor.inputType,
    autocomplete: descriptor.autocomplete,
    ariaAutocomplete: descriptor.ariaAutocomplete,
    surfaceKind: descriptor.surfaceKind,
    controlsSurfaceSelector: descriptor.controlsSurfaceSelector,
    states: descriptor.semantics?.states,
    structure: descriptor.structure,
    legacyMethod,
  });
}

function inferControlFamily(
  descriptor: TargetDescriptorInput,
  allowedActions: ReadonlyArray<TargetAllowedAction>
): TargetControlFamily | undefined {
  return inferControlFamilyFromFacts(
    {
      kind: descriptor.kind,
      role: descriptor.semantics?.role,
      label: descriptor.label,
      displayLabel: descriptor.displayLabel,
      placeholder: descriptor.placeholder,
      inputName: descriptor.inputName,
      inputType: descriptor.inputType,
      autocomplete: descriptor.autocomplete,
      ariaAutocomplete: descriptor.ariaAutocomplete,
      surfaceKind: descriptor.surfaceKind,
      controlsSurfaceSelector: descriptor.controlsSurfaceSelector,
      states: descriptor.semantics?.states,
      structure: descriptor.structure,
      legacyMethod: inferLegacyActionMethod(descriptor),
    },
    allowedActions
  );
}

function inferAcceptancePolicy(
  descriptor: TargetDescriptorInput,
  allowedActions: ReadonlyArray<TargetAllowedAction>
): TargetAcceptancePolicy | undefined {
  return inferAcceptancePolicyFromFacts(
    {
      kind: descriptor.kind,
      role: descriptor.semantics?.role,
      label: descriptor.label,
      displayLabel: descriptor.displayLabel,
      placeholder: descriptor.placeholder,
      inputName: descriptor.inputName,
      inputType: descriptor.inputType,
      autocomplete: descriptor.autocomplete,
      ariaAutocomplete: descriptor.ariaAutocomplete,
      surfaceKind: descriptor.surfaceKind,
      controlsSurfaceSelector: descriptor.controlsSurfaceSelector,
      states: descriptor.semantics?.states,
      structure: descriptor.structure,
      legacyMethod: inferLegacyActionMethod(descriptor),
    },
    allowedActions
  );
}

function inferAvailability(descriptor: TargetDescriptorInput): TargetAvailabilityState {
  if (descriptor.availability?.state) {
    return descriptor.availability;
  }
  const allowedActions = descriptor.allowedActions
    ? [...descriptor.allowedActions]
    : inferAllowedActions(descriptor);
  const controlFamily = descriptor.controlFamily ?? inferControlFamily(descriptor, allowedActions);
  const acceptancePolicy =
    descriptor.acceptancePolicy ?? inferAcceptancePolicy(descriptor, allowedActions);
  return inferAvailabilityFromFacts(descriptor.semantics?.states, descriptor.context?.hintText, {
    readonlyInteractive:
      controlFamily === 'select' ||
      controlFamily === 'datepicker' ||
      acceptancePolicy === 'selection' ||
      acceptancePolicy === 'date-selection',
  });
}

function normalizeTargetDescriptor(
  descriptor: TargetDescriptorInput,
  ref: string
): TargetDescriptor {
  const allowedActions = descriptor.allowedActions
    ? [...descriptor.allowedActions]
    : inferAllowedActions(descriptor);
  return {
    ...descriptor,
    ref,
    capability: descriptor.capability ?? 'actionable',
    lifecycle: descriptor.lifecycle ?? 'live',
    availability: inferAvailability(descriptor),
    allowedActions,
    controlFamily: descriptor.controlFamily ?? inferControlFamily(descriptor, allowedActions),
    acceptancePolicy:
      descriptor.acceptancePolicy ?? inferAcceptancePolicy(descriptor, allowedActions),
  };
}

function targetIdentity(
  descriptor: Pick<
    TargetDescriptor,
    | 'pageRef'
    | 'framePath'
    | 'frameUrl'
    | 'kind'
    | 'label'
    | 'controlFamily'
    | 'surfaceRef'
    | 'structure'
    | 'locatorCandidates'
    | 'pageSignature'
    | 'domSignature'
  >,
  options: {
    ignoreSurfaceRef?: boolean;
  } = {}
): string {
  const frameKey =
    descriptor.framePath?.join('>') ??
    (descriptor.frameUrl?.trim() ? `url:${descriptor.frameUrl.trim()}` : 'top');
  const pageKey = descriptor.pageSignature ?? descriptor.pageRef;
  const familyKey = descriptor.controlFamily ?? '';
  const surfaceKey = options.ignoreSurfaceRef ? '' : (descriptor.surfaceRef ?? '');
  const structureKey = descriptor.structure
    ? [
        descriptor.structure.family ?? '',
        descriptor.structure.variant ?? '',
        descriptor.structure.row ?? '',
        descriptor.structure.column ?? '',
        descriptor.structure.zone ?? '',
        descriptor.structure.cellLabel ?? '',
      ].join(':')
    : '';
  const locatorKey = descriptor.locatorCandidates
    .map((candidate) => locatorCandidateKey(candidate))
    .join('|');
  const domKey = descriptor.domSignature?.trim();
  if (domKey && locatorKey) {
    return `${pageKey}|${frameKey}|family|${familyKey}|surface|${surfaceKey}|structure|${structureKey}|dom|${domKey}|locator|${locatorKey}`;
  }
  if (domKey) {
    return `${pageKey}|${frameKey}|family|${familyKey}|surface|${surfaceKey}|structure|${structureKey}|dom|${domKey}`;
  }
  if (locatorKey) {
    return `${pageKey}|${frameKey}|family|${familyKey}|surface|${surfaceKey}|structure|${structureKey}|locator|${locatorKey}`;
  }

  return `${pageKey}|${frameKey}|family|${familyKey}|surface|${surfaceKey}|structure|${structureKey}|fallback|${descriptor.kind ?? ''}|${descriptor.label ?? ''}`;
}

export interface BrowsePageState {
  pageRef: string;
  createdAt: string;
  updatedAt: string;
  url?: string;
  title?: string;
  targetId?: string;
  openerPageRef?: string;
  scopeEpoch: number;
}

export type ExtractScopeLifetime = 'durable' | 'snapshot';

export interface SurfaceDescriptor {
  ref: string;
  surfaceId: string;
  pageRef: string;
  framePath?: string[];
  frameUrl?: string;
  kind?: string;
  label?: string;
  parentSurfaceRef?: string;
  childSurfaceRefs?: string[];
  targetRefs?: string[];
  lifecycle: TargetLifecycle;
  availability: TargetAvailabilityState;
  locatorCandidates: LocatorCandidate[];
  createdAt: number;
  pageSignature?: string;
  lifecycleReason?: string;
  extractScopeLifetime?: ExtractScopeLifetime;
  scopeEpoch?: number;
}

type SurfaceDescriptorInput = Omit<SurfaceDescriptor, 'ref' | 'lifecycle' | 'availability'> & {
  ref?: string;
  lifecycle?: TargetLifecycle;
  availability?: TargetAvailabilityState;
};

export interface BrowseRuntimeMetrics {
  stagehandCalls: number;
  deterministicActions: number;
  fallbackActions: number;
  observeAxAttempts: number;
  observeAxHits: number;
  observeFallbackUses: number;
  successfulActions: number;
  failedActions: number;
  totalActionDurationMs: number;
  successRate: number;
  averageActionDurationMs: number;
  llmCalls?: number;
  llmPromptTokens?: number;
  llmCompletionTokens?: number;
  llmTotalTokens?: number;
  llmCachedInputTokens?: number;
  llmReasoningTokens?: number;
  llmUsageByPurpose?: Record<string, BrowseLlmUsageBucket>;
  payloadBudget?: BrowsePayloadBudgetMetrics;
}

export interface BrowseLlmUsageBucket {
  calls: number;
  inputChars: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

export interface BrowsePayloadBudgetMetrics {
  observeRerankCandidatesSeen: number;
  observeRerankCandidatesSent: number;
  extractSnapshotLinesSeen: number;
  extractSnapshotLinesSent: number;
  protectedBindingsSeen: number;
  protectedBindingsSent: number;
}

export type ProtectedExactValueMatcher = 'text' | 'digits' | 'email' | 'expiry';

export interface ProtectedExactValueRule {
  matcher: ProtectedExactValueMatcher;
  digest: string;
  normalizedLength: number;
}

export interface ProtectedExactValueProfile {
  version: 1;
  rules: ProtectedExactValueRule[];
}

export interface ProtectedExposureState {
  pageRef: string;
  scopeRef?: string;
  fillRef: string;
  requestId: string;
  activatedAt: string;
  exactValueProfile?: ProtectedExactValueProfile;
  reason:
    | 'protected_fill_success'
    | 'protected_fill_binding_stale'
    | 'protected_fill_validation_failed'
    | 'protected_fill_unexpected_error';
}

export interface BrowseRuntimeState {
  version: 1;
  currentPageRef: string;
  pages: Record<string, BrowsePageState>;
  surfaces: Record<string, SurfaceDescriptor>;
  targets: Record<string, TargetDescriptor>;
  secretCatalogByHost: Record<string, SecretCatalogSnapshot>;
  fillableForms: Record<string, PersistedFillableForm>;
  protectedExposureByPage?: Record<string, ProtectedExposureState>;
  counters: {
    nextPage: number;
    nextSurface: number;
    nextTarget: number;
    nextFill: number;
  };
  metrics: BrowseRuntimeMetrics;
}

export function createPayloadBudgetMetrics(): BrowsePayloadBudgetMetrics {
  return {
    observeRerankCandidatesSeen: 0,
    observeRerankCandidatesSent: 0,
    extractSnapshotLinesSeen: 0,
    extractSnapshotLinesSent: 0,
    protectedBindingsSeen: 0,
    protectedBindingsSent: 0,
  };
}

export function createLlmUsageBucket(): BrowseLlmUsageBucket {
  return {
    calls: 0,
    inputChars: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
}

export function ensureMetricsExtensions(metrics: BrowseRuntimeMetrics): void {
  metrics.llmCalls ??= 0;
  metrics.llmPromptTokens ??= 0;
  metrics.llmCompletionTokens ??= 0;
  metrics.llmTotalTokens ??= 0;
  metrics.llmCachedInputTokens ??= 0;
  metrics.llmReasoningTokens ??= 0;
  metrics.llmUsageByPurpose ??= {};
  metrics.payloadBudget ??= createPayloadBudgetMetrics();
}

function inferSurfaceAvailability(descriptor: SurfaceDescriptorInput): TargetAvailabilityState {
  return descriptor.availability?.state ? descriptor.availability : { state: 'available' };
}

function normalizeSurfaceDescriptor(
  descriptor: SurfaceDescriptorInput,
  ref: string
): SurfaceDescriptor {
  return {
    ...descriptor,
    ref,
    childSurfaceRefs: descriptor.childSurfaceRefs ? [...descriptor.childSurfaceRefs] : [],
    targetRefs: descriptor.targetRefs ? [...descriptor.targetRefs] : [],
    lifecycle: descriptor.lifecycle ?? 'live',
    availability: inferSurfaceAvailability(descriptor),
  };
}

function surfaceIdentity(
  descriptor: Pick<
    SurfaceDescriptor,
    | 'surfaceId'
    | 'pageRef'
    | 'framePath'
    | 'frameUrl'
    | 'kind'
    | 'label'
    | 'locatorCandidates'
    | 'pageSignature'
  >
): string {
  if (descriptor.surfaceId) {
    return descriptor.surfaceId;
  }

  const frameKey =
    descriptor.framePath?.join('>') ??
    (descriptor.frameUrl?.trim() ? `url:${descriptor.frameUrl.trim()}` : 'top');
  const pageKey = descriptor.pageSignature ?? descriptor.pageRef;
  const locatorKey = descriptor.locatorCandidates
    .map((candidate) => locatorCandidateKey(candidate))
    .join('|');
  if (locatorKey) {
    return `${pageKey}|${frameKey}|surface-locator|${locatorKey}`;
  }
  return `${pageKey}|${frameKey}|surface-fallback|${descriptor.kind ?? ''}|${descriptor.label ?? ''}`;
}

function syncTargetCounter(runtime: BrowseRuntimeState, ref: string): void {
  const match = /^t(\d+)$/.exec(ref);
  if (!match) return;

  const nextTarget = Number(match[1]) + 1;
  if (Number.isFinite(nextTarget)) {
    runtime.counters.nextTarget = Math.max(runtime.counters.nextTarget, nextTarget);
  }
}

function syncFillCounter(runtime: BrowseRuntimeState, ref: string): void {
  const match = /^f(\d+)$/.exec(ref);
  if (!match) return;

  const nextFill = Number(match[1]) + 1;
  if (Number.isFinite(nextFill)) {
    runtime.counters.nextFill = Math.max(runtime.counters.nextFill, nextFill);
  }
}

function syncSurfaceCounter(runtime: BrowseRuntimeState, ref: string): void {
  const match = /^s(\d+)$/.exec(ref);
  if (!match) return;

  const nextSurface = Number(match[1]) + 1;
  if (Number.isFinite(nextSurface)) {
    runtime.counters.nextSurface = Math.max(runtime.counters.nextSurface, nextSurface);
  }
}

export function createRuntimeState(
  initialPage: Partial<Omit<BrowsePageState, 'pageRef' | 'createdAt' | 'updatedAt'>> & {
    pageRef?: string;
  } = {}
): BrowseRuntimeState {
  const pageRef = initialPage.pageRef ?? 'p0';
  const now = new Date().toISOString();

  return {
    version: 1,
    currentPageRef: pageRef,
    pages: {
      [pageRef]: {
        pageRef,
        createdAt: now,
        updatedAt: now,
        url: initialPage.url,
        title: initialPage.title,
        openerPageRef: initialPage.openerPageRef,
        scopeEpoch: 0,
      },
    },
    surfaces: {},
    targets: {},
    secretCatalogByHost: {},
    fillableForms: {},
    protectedExposureByPage: {},
    counters: {
      nextPage: pageRef === 'p0' ? 1 : 0,
      nextSurface: 1,
      nextTarget: 1,
      nextFill: 1,
    },
    metrics: {
      stagehandCalls: 0,
      deterministicActions: 0,
      fallbackActions: 0,
      observeAxAttempts: 0,
      observeAxHits: 0,
      observeFallbackUses: 0,
      successfulActions: 0,
      failedActions: 0,
      totalActionDurationMs: 0,
      successRate: 0,
      averageActionDurationMs: 0,
      llmCalls: 0,
      llmPromptTokens: 0,
      llmCompletionTokens: 0,
      llmTotalTokens: 0,
      llmCachedInputTokens: 0,
      llmReasoningTokens: 0,
      llmUsageByPurpose: {},
      payloadBudget: createPayloadBudgetMetrics(),
    },
  };
}

export function ensureRuntimeState(session: BrowserSessionState): BrowseRuntimeState {
  if (!session.runtime) {
    session.runtime = createRuntimeState();
  }
  session.runtime.surfaces ??= {};
  session.runtime.secretCatalogByHost ??= {};
  session.runtime.fillableForms ??= {};
  session.runtime.protectedExposureByPage ??= {};
  session.runtime.counters.nextPage ??= 1;
  session.runtime.counters.nextSurface ??= 1;
  session.runtime.counters.nextTarget ??= 1;
  session.runtime.counters.nextFill ??= 1;
  for (const pageRef of Object.keys(session.runtime.pages ?? {})) {
    const match = /^p(\d+)$/.exec(pageRef);
    if (!match) {
      continue;
    }
    const nextPage = Number(match[1]) + 1;
    if (Number.isFinite(nextPage)) {
      session.runtime.counters.nextPage = Math.max(session.runtime.counters.nextPage, nextPage);
    }
  }
  for (const page of Object.values(session.runtime.pages ?? {})) {
    page.scopeEpoch ??= 0;
  }
  for (const surfaceRef of Object.keys(session.runtime.surfaces ?? {})) {
    syncSurfaceCounter(session.runtime, surfaceRef);
  }
  for (const targetRef of Object.keys(session.runtime.targets ?? {})) {
    syncTargetCounter(session.runtime, targetRef);
  }
  for (const fillRef of Object.keys(session.runtime.fillableForms ?? {})) {
    syncFillCounter(session.runtime, fillRef);
  }
  ensureMetricsExtensions(session.runtime.metrics);
  return session.runtime;
}

export function createTargetRef(session: BrowserSessionState): string {
  const runtime = ensureRuntimeState(session);
  return `t${runtime.counters.nextTarget++}`;
}

export function createFillRef(session: BrowserSessionState): string {
  const runtime = ensureRuntimeState(session);
  return `f${runtime.counters.nextFill++}`;
}

export function createSurfaceRef(session: BrowserSessionState): string {
  const runtime = ensureRuntimeState(session);
  return `s${runtime.counters.nextSurface++}`;
}

export function saveSurfaces(
  session: BrowserSessionState,
  descriptors: ReadonlyArray<SurfaceDescriptorInput>
): SurfaceDescriptor[] {
  const runtime = ensureRuntimeState(session);

  return descriptors.map((descriptor) => {
    const ref = descriptor.ref ?? createSurfaceRef(session);
    const surface = normalizeSurfaceDescriptor(descriptor, ref);
    runtime.surfaces[ref] = surface;
    syncSurfaceCounter(runtime, ref);
    return surface;
  });
}

export function replaceSurfacesForPage(
  session: BrowserSessionState,
  pageRef: string,
  descriptors: ReadonlyArray<SurfaceDescriptorInput>,
  options: {
    preserveExistingOnEmpty?: boolean;
    preserveExisting?: boolean;
  } = {}
): SurfaceDescriptor[] {
  const runtime = ensureRuntimeState(session);
  const existingEntries = Object.entries(runtime.surfaces).filter(
    ([, surface]) => surface.pageRef === pageRef
  );
  const preserveExistingOnEmpty = options.preserveExistingOnEmpty !== false;
  const preserveExisting = options.preserveExisting !== false;

  if (descriptors.length === 0 && preserveExistingOnEmpty) {
    return existingEntries.map(([, surface]) => surface);
  }

  const reusableRefs = new Map<string, string[]>();
  for (const [ref, surface] of existingEntries) {
    const identity = surfaceIdentity(surface);
    const refs = reusableRefs.get(identity) ?? [];
    refs.push(ref);
    reusableRefs.set(identity, refs);
  }

  const nextSurfaces: SurfaceDescriptor[] = [];
  const reusedRefs = new Set<string>();

  for (const descriptor of descriptors) {
    const normalizedDescriptor = normalizeSurfaceDescriptor(
      {
        ...descriptor,
        pageRef,
      },
      descriptor.ref ?? '__identity__'
    );
    const identity = surfaceIdentity(normalizedDescriptor);
    const matchedRef = reusableRefs.get(identity)?.shift();
    const ref = descriptor.ref ?? matchedRef ?? createSurfaceRef(session);
    const surface = normalizeSurfaceDescriptor(descriptor, ref);
    runtime.surfaces[ref] = surface;
    syncSurfaceCounter(runtime, ref);
    reusedRefs.add(ref);
    nextSurfaces.push(surface);
  }

  if (!preserveExisting) {
    for (const [ref] of existingEntries) {
      if (!reusedRefs.has(ref)) {
        delete runtime.surfaces[ref];
      }
    }
  }

  return nextSurfaces;
}

export function saveTargets(
  session: BrowserSessionState,
  descriptors: ReadonlyArray<TargetDescriptorInput>
): TargetDescriptor[] {
  const runtime = ensureRuntimeState(session);

  return descriptors.map((descriptor) => {
    const ref = descriptor.ref ?? createTargetRef(session);
    const target = normalizeTargetDescriptor(descriptor, ref);
    runtime.targets[ref] = target;
    syncTargetCounter(runtime, ref);
    return target;
  });
}

export function replaceTargetsForPage(
  session: BrowserSessionState,
  pageRef: string,
  descriptors: ReadonlyArray<TargetDescriptorInput>,
  options: {
    preserveExistingOnEmpty?: boolean;
    preserveExisting?: boolean;
  } = {}
): TargetDescriptor[] {
  const runtime = ensureRuntimeState(session);
  const existingEntries = Object.entries(runtime.targets).filter(
    ([, target]) => target.pageRef === pageRef
  );
  const existingTargets = new Map(existingEntries);
  const preserveExistingOnEmpty = options.preserveExistingOnEmpty !== false;
  const preserveExisting = options.preserveExisting !== false;

  if (descriptors.length === 0 && preserveExistingOnEmpty) {
    return existingEntries.map(([, target]) => target);
  }

  function pushReusableRef(map: Map<string, string[]>, identity: string, ref: string): void {
    const refs = map.get(identity) ?? [];
    refs.push(ref);
    map.set(identity, refs);
  }

  function ownerWorkflowBoundaryChanged(
    current: TargetDescriptor,
    next: Pick<TargetDescriptor, 'ownerRef'>
  ): boolean {
    const currentOwnerRef = current.ownerRef?.trim();
    const nextOwnerRef = next.ownerRef?.trim();
    return Boolean(currentOwnerRef && nextOwnerRef && currentOwnerRef !== nextOwnerRef);
  }

  function workflowContextKey(
    context: Pick<TargetContext, 'item' | 'group' | 'container'> | undefined
  ): string {
    if (!context) {
      return '';
    }

    return ['item', 'group', 'container']
      .map((key) => {
        const node = context[key as keyof Pick<TargetContext, 'item' | 'group' | 'container'>];
        return node ? `${node.kind ?? ''}:${node.label ?? ''}` : '';
      })
      .join('|');
  }

  function workflowContextBoundaryChanged(
    current: Pick<TargetDescriptor, 'context'>,
    next: Pick<TargetDescriptor, 'context'>
  ): boolean {
    const currentContextKey = workflowContextKey(current.context);
    const nextContextKey = workflowContextKey(next.context);
    return Boolean(
      currentContextKey.trim().length > 0 &&
        nextContextKey.trim().length > 0 &&
        currentContextKey !== nextContextKey
    );
  }

  function takeReusableTargetRef(
    map: Map<string, string[]>,
    identity: string,
    consumedRefs: ReadonlySet<string>,
    next: TargetDescriptor
  ): string | undefined {
    const refs = map.get(identity);
    if (!refs || refs.length === 0) {
      return undefined;
    }

    for (let index = 0; index < refs.length; index += 1) {
      const candidate = refs[index];
      if (!candidate || consumedRefs.has(candidate)) {
        continue;
      }

      const current = existingTargets.get(candidate);
      if (
        current &&
        (ownerWorkflowBoundaryChanged(current, next) ||
          workflowContextBoundaryChanged(current, next))
      ) {
        continue;
      }

      refs.splice(index, 1);
      return candidate;
    }

    return undefined;
  }

  const reusableRefs = new Map<string, string[]>();
  const surfacePromotionRefs = new Map<string, string[]>();
  for (const [ref, target] of existingEntries) {
    pushReusableRef(reusableRefs, targetIdentity(target), ref);
    if (!target.surfaceRef?.trim()) {
      pushReusableRef(
        surfacePromotionRefs,
        targetIdentity(target, { ignoreSurfaceRef: true }),
        ref
      );
    }
  }

  const nextTargets: TargetDescriptor[] = [];
  const reusedRefs = new Set<string>();

  for (const descriptor of descriptors) {
    const normalizedDescriptor = normalizeTargetDescriptor(
      {
        ...descriptor,
        pageRef,
      },
      descriptor.ref ?? '__identity__'
    );
    const identity = targetIdentity(normalizedDescriptor);
    const matchedRef =
      takeReusableTargetRef(reusableRefs, identity, reusedRefs, normalizedDescriptor) ??
      (normalizedDescriptor.surfaceRef?.trim()
        ? takeReusableTargetRef(
            surfacePromotionRefs,
            targetIdentity(normalizedDescriptor, { ignoreSurfaceRef: true }),
            reusedRefs,
            normalizedDescriptor
          )
        : undefined);
    const ref = descriptor.ref ?? matchedRef ?? createTargetRef(session);
    const target = normalizeTargetDescriptor(descriptor, ref);
    runtime.targets[ref] = target;
    syncTargetCounter(runtime, ref);
    reusedRefs.add(ref);
    nextTargets.push(target);
  }

  if (!preserveExisting) {
    for (const [ref] of existingEntries) {
      if (!reusedRefs.has(ref)) {
        delete runtime.targets[ref];
      }
    }
  }

  return nextTargets;
}

export function getTarget(
  session: BrowserSessionState,
  targetRef: string
): TargetDescriptor | null {
  const runtime = ensureRuntimeState(session);
  return runtime.targets[targetRef] ?? null;
}

export function getSurface(
  session: BrowserSessionState,
  surfaceRef: string
): SurfaceDescriptor | null {
  const runtime = ensureRuntimeState(session);
  return runtime.surfaces[surfaceRef] ?? null;
}

export function saveSecretCatalog(
  session: BrowserSessionState,
  snapshot: SecretCatalogSnapshot
): SecretCatalogSnapshot {
  const runtime = ensureRuntimeState(session);
  runtime.secretCatalogByHost[snapshot.host] = snapshot;
  return snapshot;
}

export function getSecretCatalog(
  session: BrowserSessionState,
  host: string
): SecretCatalogSnapshot | null {
  const runtime = ensureRuntimeState(session);
  return resolveCachedSecretCatalogForHost(host, Object.values(runtime.secretCatalogByHost));
}

export function updateSurface(
  session: BrowserSessionState,
  surfaceRef: string,
  patch: Partial<Omit<SurfaceDescriptor, 'ref' | 'createdAt'>>
): SurfaceDescriptor | null {
  const runtime = ensureRuntimeState(session);
  const current = runtime.surfaces[surfaceRef];
  if (!current) {
    return null;
  }

  const next = normalizeSurfaceDescriptor(
    {
      ...current,
      ...patch,
      availability: patch.availability ?? current.availability,
    },
    surfaceRef
  );
  runtime.surfaces[surfaceRef] = next;
  return next;
}

export function markSurfaceLifecycle(
  session: BrowserSessionState,
  surfaceRef: string,
  lifecycle: TargetLifecycle,
  reason?: string
): SurfaceDescriptor | null {
  return updateSurface(session, surfaceRef, {
    lifecycle,
    lifecycleReason: reason,
  });
}

export function setSurfaceAvailability(
  session: BrowserSessionState,
  surfaceRef: string,
  state: TargetAvailability,
  reason?: string
): SurfaceDescriptor | null {
  return updateSurface(session, surfaceRef, {
    availability: {
      state,
      reason,
    },
  });
}

export function deleteTarget(session: BrowserSessionState, targetRef: string): void {
  const runtime = ensureRuntimeState(session);
  delete runtime.targets[targetRef];
}

export function updateTarget(
  session: BrowserSessionState,
  targetRef: string,
  patch: Partial<Omit<TargetDescriptor, 'ref' | 'createdAt'>>
): TargetDescriptor | null {
  const runtime = ensureRuntimeState(session);
  const current = runtime.targets[targetRef];
  if (!current) {
    return null;
  }

  const next = normalizeTargetDescriptor(
    {
      ...current,
      ...patch,
      availability: patch.availability ?? current.availability,
      allowedActions: patch.allowedActions ?? current.allowedActions,
    },
    targetRef
  );
  runtime.targets[targetRef] = next;
  return next;
}

export function markTargetLifecycle(
  session: BrowserSessionState,
  targetRef: string,
  lifecycle: TargetLifecycle,
  reason?: string
): TargetDescriptor | null {
  return updateTarget(session, targetRef, {
    lifecycle,
    lifecycleReason: reason,
  });
}

export function setTargetAvailability(
  session: BrowserSessionState,
  targetRef: string,
  state: TargetAvailability,
  reason?: string
): TargetDescriptor | null {
  return updateTarget(session, targetRef, {
    availability: {
      state,
      reason,
    },
  });
}

export function listTargets(session: BrowserSessionState): TargetDescriptor[] {
  return Object.values(ensureRuntimeState(session).targets);
}

export function listSurfaces(session: BrowserSessionState): SurfaceDescriptor[] {
  return Object.values(ensureRuntimeState(session).surfaces);
}

export function clearTargets(session: BrowserSessionState, pageRef?: string): void {
  const runtime = ensureRuntimeState(session);
  if (!pageRef) {
    runtime.surfaces = {};
    runtime.targets = {};
    runtime.fillableForms = {};
    return;
  }

  for (const [surfaceRef, surface] of Object.entries(runtime.surfaces)) {
    if (surface.pageRef === pageRef) {
      delete runtime.surfaces[surfaceRef];
    }
  }
  for (const [targetRef, target] of Object.entries(runtime.targets)) {
    if (target.pageRef === pageRef) {
      delete runtime.targets[targetRef];
    }
  }
  for (const [fillRef, form] of Object.entries(runtime.fillableForms)) {
    if (form.pageRef === pageRef) {
      delete runtime.fillableForms[fillRef];
    }
  }
}
