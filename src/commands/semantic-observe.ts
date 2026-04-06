import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tryCreateAgentbrowseAssistiveLlmClient } from '../assistive-runtime.js';
import type { BrowserSessionState } from '../browser-session-state.js';
import { recordLlmUsage, recordPayloadBudget } from '../runtime-metrics.js';
import type {
  TargetAcceptancePolicy,
  TargetAllowedAction,
  TargetCapability,
  TargetContext,
  TargetControlFamily,
  TargetStructure,
} from '../runtime-state.js';
import {
  analyzeSemanticObserveText,
  buildSemanticObserveBm25CorpusStats,
  buildSemanticObserveLexicalDocument,
  normalizeSemanticObserveText,
  scoreSemanticObserveBm25,
  type SemanticObserveAnalyzerKey,
  type SemanticObserveLexicalDocument,
  type SemanticObserveLexicalField,
} from './semantic-observe-lexical.js';

type ObserveInventoryTarget = {
  kind?: string;
  label?: string;
  displayLabel?: string;
  role?: string;
  interactionHint?: 'click';
  text?: string;
  placeholder?: string;
  title?: string;
  states?: Record<string, string | boolean | number>;
  context?: TargetContext;
  capability?: TargetCapability;
  allowedActions?: TargetAllowedAction[];
  acceptancePolicy?: TargetAcceptancePolicy;
  controlFamily?: TargetControlFamily;
  surfaceRef?: string;
  surfaceKind?: string;
  surfaceLabel?: string;
  surfacePriority?: number;
  structure?: TargetStructure;
  framePath?: string[];
  frameUrl?: string;
  formSelector?: string;
  pageSignature?: string;
  goalInventoryType?: 'target' | 'scope';
  goalSurfaceId?: string;
  goalLabel?: string;
  goalAliases?: string[];
  controlsSurfaceSelector?: string;
};

type SurfaceSummaryEntry = {
  id: string;
  line: string;
};

const rerankSchema = z.object({
  matches: z
    .array(
      z.object({
        candidateId: z.string(),
      })
    )
    .max(8),
});
const RERANK_CANDIDATE_LIMIT = 120;
const GOAL_RETRIEVAL_ENTITY_LIMIT = 64;
const FORM_BUCKET_RESERVE_LIMIT = 48;
const FORM_BUCKET_RESERVE_PER_BUCKET = 8;
const SCOPE_BUCKET_RESERVE_LIMIT = 24;
const SCOPE_BUCKET_RESERVE_PER_BUCKET = 2;
const IFRAME_BUCKET_RESERVE_LIMIT = 24;
const IFRAME_BUCKET_RESERVE_PER_BUCKET = 2;
const RETRIEVAL_FIELD_WEIGHTS = {
  entityLabel: 5.5,
  representativeLabel: 5,
  representativeLabels: 4,
  surfaceLabel: 2.25,
  placeholder: 2.5,
  title: 1.25,
  itemLabel: 2.5,
  itemText: 1.5,
  groupLabel: 1.75,
  groupText: 1,
  containerLabel: 1.5,
  containerText: 0.9,
  landmarkLabel: 1.25,
  landmarkText: 0.75,
  hintText: 1.5,
  kind: 0.6,
  role: 0.6,
  surfaceKind: 0.75,
  controlFamily: 0.9,
  acceptancePolicy: 1,
  allowedActions: 0.9,
  structure: 1.25,
  latentIntent: 1.2,
} as const;
const HIGH_SIGNAL_SCOPE_KINDS = new Set([
  'dialog',
  'listbox',
  'menu',
  'grid',
  'tabpanel',
  'popover',
  'dropdown',
  'datepicker',
  'card',
  'form',
]);

type GoalRetrievalEntityKind = 'form' | 'item' | 'scope' | 'standalone';

type GoalRetrievalEntity<T extends ObserveInventoryTarget> = {
  entityKind: GoalRetrievalEntityKind;
  entityKey: string;
  firstIndex: number;
  memberIndexes: number[];
  representative: T;
  label?: string;
  kind?: string;
  surfaceKind?: string;
  surfaceLabel?: string;
  surfacePriority?: number;
  framePath?: string[];
  frameUrl?: string;
  context?: TargetContext;
  structure?: TargetStructure;
  representativeLabels: string[];
  analyzerKey: SemanticObserveAnalyzerKey;
  lexicalDocument: SemanticObserveLexicalDocument;
};

type CachedLexicalDocument = {
  analyzerKey: SemanticObserveAnalyzerKey;
  weightedLength: number;
  weightedTermFrequencies: Array<[string, number]>;
};

type CachedGoalRetrievalEntity = {
  entityKind: GoalRetrievalEntityKind;
  entityKey: string;
  firstIndex: number;
  representativeIndex: number;
  memberIndexes: number[];
  analyzerKey: SemanticObserveAnalyzerKey;
  lexicalDocument: CachedLexicalDocument;
};

type CachedGoalShortlist = {
  goalKey: string;
  candidateIndexes: number[];
  cachedAt: string;
};

type SemanticObserveSnapshotCacheEntry = {
  snapshotKey: string;
  targetCount: number;
  cachedAt: string;
  retrievalEntities?: CachedGoalRetrievalEntity[];
  goalShortlists?: Record<string, CachedGoalShortlist>;
  goalOrder?: string[];
};

type SemanticObserveSnapshotCacheState = {
  version: 1;
  order: string[];
  snapshotsByKey: Record<string, SemanticObserveSnapshotCacheEntry>;
};

const SEMANTIC_OBSERVE_SNAPSHOT_CACHE_VERSION = 1;
const SEMANTIC_OBSERVE_SNAPSHOT_CACHE_KEY_VERSION = 'semantic-observe-snapshot-v1';
const SEMANTIC_OBSERVE_GOAL_CACHE_KEY_VERSION = 'semantic-observe-goal-v1';
const SEMANTIC_OBSERVE_MAX_SNAPSHOT_CACHE_ENTRIES = 4;
const SEMANTIC_OBSERVE_MAX_GOAL_SHORTLISTS_PER_SNAPSHOT = 6;
const semanticObserveSnapshotCacheBySession = new WeakMap<
  BrowserSessionState,
  SemanticObserveSnapshotCacheState
>();

function isFieldLikeTarget(target: ObserveInventoryTarget): boolean {
  const kind = (target.kind ?? '').trim().toLowerCase();
  const role = (target.role ?? '').trim().toLowerCase();
  return (
    ['input', 'textarea', 'select', 'combobox'].includes(kind) ||
    ['textbox', 'combobox'].includes(role)
  );
}

function isScopeLikeCandidate(target: ObserveInventoryTarget): boolean {
  return (
    (target.goalInventoryType ?? '').trim().toLowerCase() === 'scope' ||
    (target.capability ?? '').trim().toLowerCase() === 'scope'
  );
}

function isActionLikeTargetCandidate(target: ObserveInventoryTarget): boolean {
  if (isScopeLikeCandidate(target) || isFieldLikeTarget(target)) {
    return false;
  }

  const kind = (target.kind ?? '').trim().toLowerCase();
  const role = (target.role ?? '').trim().toLowerCase();
  return (
    target.allowedActions?.includes('click') ||
    target.allowedActions?.includes('press') ||
    kind === 'button' ||
    role === 'button' ||
    kind === 'link' ||
    role === 'link'
  );
}

function semanticFormContextKey(context: TargetContext | undefined): string | undefined {
  for (const node of [context?.landmark, context?.container, context?.group, context?.item]) {
    const kind = (node?.kind ?? '').trim().toLowerCase();
    if (kind !== 'form') {
      continue;
    }

    const label = (node?.label ?? node?.text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    return `${kind}|${label}`;
  }

  return undefined;
}

function formBucketKey(target: ObserveInventoryTarget): string | undefined {
  const formSelector = target.formSelector?.trim();
  if (formSelector) {
    return `selector:${formSelector}`;
  }

  const contextKey = semanticFormContextKey(target.context);
  return contextKey ? `context:${contextKey}` : undefined;
}

function candidateBucketKey(
  target: ObserveInventoryTarget,
  options: { preferFormBucket?: boolean } = {}
): string {
  const frameKey = target.framePath?.join('>') ?? 'top';
  const formKey = formBucketKey(target);
  const surfaceKey =
    (options.preferFormBucket ? formKey : undefined) ?? target.surfaceRef ?? formKey ?? 'page-root';
  return `${frameKey}|${surfaceKey}`;
}

function surfaceIdentityOf(target: ObserveInventoryTarget): string | undefined {
  const explicitSurfaceId = target.goalSurfaceId?.trim();
  if (explicitSurfaceId) {
    return explicitSurfaceId;
  }

  const surfaceRef = target.surfaceRef?.trim();
  if (!surfaceRef) {
    return undefined;
  }

  return surfaceRef.startsWith('scope:') ? surfaceRef.slice('scope:'.length) : surfaceRef;
}

function isPrimaryFormControlTarget(target: ObserveInventoryTarget): boolean {
  const kind = (target.kind ?? '').trim().toLowerCase();
  const role = (target.role ?? '').trim().toLowerCase();
  const controlFamily = (target.controlFamily ?? '').trim().toLowerCase();
  const acceptancePolicy = (target.acceptancePolicy ?? '').trim().toLowerCase();

  if (target.allowedActions?.includes('fill') || target.allowedActions?.includes('type')) {
    return true;
  }
  if (target.allowedActions?.includes('select')) {
    return true;
  }
  if (['text-input', 'select', 'datepicker'].includes(controlFamily)) {
    return true;
  }
  if (acceptancePolicy === 'submit' || acceptancePolicy === 'date-selection') {
    return true;
  }

  return (
    Boolean(formBucketKey(target)) &&
    acceptancePolicy === 'disclosure' &&
    (kind === 'button' || role === 'button')
  );
}

function isConcreteFormChoiceTarget(target: ObserveInventoryTarget): boolean {
  if (
    !formBucketKey(target) ||
    isScopeLikeCandidate(target) ||
    isFieldLikeTarget(target) ||
    !isActionLikeTargetCandidate(target) ||
    isPrimaryFormControlTarget(target)
  ) {
    return false;
  }

  const acceptancePolicy = (target.acceptancePolicy ?? '').trim().toLowerCase();
  const controlFamily = (target.controlFamily ?? '').trim().toLowerCase();
  const surfaceKind = (target.surfaceKind ?? '').trim().toLowerCase();
  const hasGoalIdentity = Boolean(goalLabelOf(target));

  if (!hasGoalIdentity) {
    return false;
  }

  return (
    controlFamily === 'trigger' ||
    acceptancePolicy === 'selection' ||
    ['listbox', 'menu', 'dropdown', 'popover'].includes(surfaceKind)
  );
}

function shouldPreserveStandaloneFormActionEntity(target: ObserveInventoryTarget): boolean {
  return (
    Boolean(formBucketKey(target)) &&
    !isScopeLikeCandidate(target) &&
    !isFieldLikeTarget(target) &&
    isActionLikeTargetCandidate(target) &&
    (isPrimaryFormControlTarget(target) || isConcreteFormChoiceTarget(target))
  );
}

function primaryFormTargetPriority(target: ObserveInventoryTarget): number {
  const acceptancePolicy = (target.acceptancePolicy ?? '').trim().toLowerCase();

  if (isFieldLikeTarget(target)) {
    return 0;
  }
  if (acceptancePolicy === 'submit') {
    return 1;
  }
  if (acceptancePolicy === 'selection' || acceptancePolicy === 'date-selection') {
    return 2;
  }
  if (acceptancePolicy === 'disclosure') {
    return 3;
  }
  return 4;
}

function isHighSignalScopeCandidate(target: ObserveInventoryTarget): boolean {
  if ((target.capability ?? '').trim().toLowerCase() !== 'scope') {
    return false;
  }

  const kind = (target.kind ?? '').trim().toLowerCase();
  return HIGH_SIGNAL_SCOPE_KINDS.has(kind);
}

function contentItemBucketKey(target: ObserveInventoryTarget): string | undefined {
  if (
    isScopeLikeCandidate(target) ||
    !isActionLikeTargetCandidate(target) ||
    Boolean(formBucketKey(target)) ||
    isPrimaryFormControlTarget(target)
  ) {
    return undefined;
  }

  const surfaceKind = (target.surfaceKind ?? '').trim().toLowerCase();
  if (
    ['form', 'dialog', 'listbox', 'menu', 'popover', 'dropdown', 'datepicker'].includes(surfaceKind)
  ) {
    return undefined;
  }

  const surfaceIdentity = surfaceIdentityOf(target);
  if (surfaceIdentity) {
    return `surface:${surfaceIdentity}`;
  }

  const itemKey = normalizeSemanticObserveText(
    target.context?.item?.label ?? target.context?.item?.text
  );
  if (itemKey) {
    return `item:${itemKey}`;
  }

  const containerKey = normalizeSemanticObserveText(
    target.context?.container?.label ?? target.context?.container?.text
  );
  if (containerKey) {
    return `container:${containerKey}`;
  }

  return undefined;
}

function cachedContextNodeValue(
  node:
    | {
        kind?: string;
        label?: string;
        text?: string;
      }
    | undefined
): { kind?: string; label?: string; text?: string } | undefined {
  if (!node) {
    return undefined;
  }

  return {
    ...(node.kind ? { kind: node.kind } : {}),
    ...(node.label ? { label: node.label } : {}),
    ...(node.text ? { text: node.text } : {}),
  };
}

function cachedStateEntries(
  states: ObserveInventoryTarget['states']
): Array<[string, string | boolean | number]> | undefined {
  if (!states) {
    return undefined;
  }

  const entries = Object.entries(states).sort(([left], [right]) => left.localeCompare(right));
  return entries.length > 0 ? entries : undefined;
}

function cachedStructureValue(structure: ObserveInventoryTarget['structure']):
  | {
      family?: string;
      variant?: string;
      row?: string;
      column?: string;
      zone?: string;
      cellLabel?: string;
    }
  | undefined {
  if (!structure) {
    return undefined;
  }

  return {
    ...(structure.family ? { family: structure.family } : {}),
    ...(structure.variant ? { variant: structure.variant } : {}),
    ...(structure.row ? { row: structure.row } : {}),
    ...(structure.column ? { column: structure.column } : {}),
    ...(structure.zone ? { zone: structure.zone } : {}),
    ...(structure.cellLabel ? { cellLabel: structure.cellLabel } : {}),
  };
}

function normalizeGoalIdentityValue(
  value: string | undefined,
  maxLength = 180
): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function appendGoalIdentityAlias(values: string[], value: string | undefined): void {
  const normalized = normalizeGoalIdentityValue(value);
  if (!normalized) {
    return;
  }

  const normalizedKey = normalized.toLowerCase();
  if (values.some((existing) => existing.toLowerCase() === normalizedKey)) {
    return;
  }

  values.push(normalized);
}

function goalIdentityValuesOf(target: ObserveInventoryTarget): string[] {
  const values: string[] = [];

  appendGoalIdentityAlias(values, target.goalLabel);
  for (const value of target.goalAliases ?? []) {
    appendGoalIdentityAlias(values, value);
  }
  if (values.length > 0) {
    return values;
  }

  if (isFieldLikeTarget(target)) {
    appendGoalIdentityAlias(values, target.label);
    appendGoalIdentityAlias(values, target.displayLabel);
    appendGoalIdentityAlias(values, target.placeholder);
    appendGoalIdentityAlias(values, target.title);
    return values;
  }

  appendGoalIdentityAlias(values, target.label);
  appendGoalIdentityAlias(values, target.displayLabel);
  appendGoalIdentityAlias(values, target.text);
  appendGoalIdentityAlias(values, target.title);
  return values;
}

function goalLabelOf(target: ObserveInventoryTarget): string | undefined {
  return goalIdentityValuesOf(target)[0];
}

function goalAliasesOf(target: ObserveInventoryTarget): string[] {
  return goalIdentityValuesOf(target).slice(1, 5);
}

function serializeObserveSnapshotTarget(target: ObserveInventoryTarget): Record<string, unknown> {
  const itemContext = cachedContextNodeValue(target.context?.item);
  const groupContext = cachedContextNodeValue(target.context?.group);
  const containerContext = cachedContextNodeValue(target.context?.container);
  const landmarkContext = cachedContextNodeValue(target.context?.landmark);
  const stateEntries = cachedStateEntries(target.states);
  const structure = cachedStructureValue(target.structure);
  const goalLabel = goalLabelOf(target);
  const goalAliases = goalAliasesOf(target);

  return {
    goalInventoryType: target.goalInventoryType,
    ...(target.goalInventoryType === 'scope' && target.goalSurfaceId
      ? { goalSurfaceId: target.goalSurfaceId }
      : {}),
    ...(goalLabel ? { goalLabel } : {}),
    ...(goalAliases.length ? { goalAliases } : {}),
    ...(target.kind ? { kind: target.kind } : {}),
    ...(target.label ? { label: target.label } : {}),
    ...(target.displayLabel ? { displayLabel: target.displayLabel } : {}),
    ...(target.role ? { role: target.role } : {}),
    ...(target.interactionHint ? { interactionHint: target.interactionHint } : {}),
    ...(target.text ? { text: target.text } : {}),
    ...(target.placeholder ? { placeholder: target.placeholder } : {}),
    ...(target.title ? { title: target.title } : {}),
    ...(target.capability ? { capability: target.capability } : {}),
    ...(target.allowedActions?.length ? { allowedActions: [...target.allowedActions].sort() } : {}),
    ...(target.acceptancePolicy ? { acceptancePolicy: target.acceptancePolicy } : {}),
    ...(target.controlFamily ? { controlFamily: target.controlFamily } : {}),
    ...(target.surfaceRef ? { surfaceRef: target.surfaceRef } : {}),
    ...(target.surfaceKind ? { surfaceKind: target.surfaceKind } : {}),
    ...(target.surfaceLabel ? { surfaceLabel: target.surfaceLabel } : {}),
    ...(typeof target.surfacePriority === 'number'
      ? { surfacePriority: target.surfacePriority }
      : {}),
    ...(target.framePath?.length ? { framePath: [...target.framePath] } : {}),
    ...(target.frameUrl ? { frameUrl: target.frameUrl } : {}),
    ...(target.formSelector ? { formSelector: target.formSelector } : {}),
    ...(target.pageSignature ? { pageSignature: target.pageSignature } : {}),
    ...(target.controlsSurfaceSelector
      ? { controlsSurfaceSelector: target.controlsSurfaceSelector }
      : {}),
    ...(stateEntries ? { states: stateEntries } : {}),
    ...(target.context
      ? {
          context: {
            ...(itemContext ? { item: itemContext } : {}),
            ...(groupContext ? { group: groupContext } : {}),
            ...(containerContext ? { container: containerContext } : {}),
            ...(landmarkContext ? { landmark: landmarkContext } : {}),
            ...(target.context.hintText ? { hintText: target.context.hintText } : {}),
          },
        }
      : {}),
    ...(structure ? { structure } : {}),
  };
}

function semanticObserveSnapshotKey(targets: ReadonlyArray<ObserveInventoryTarget>): string {
  const payload = JSON.stringify(targets.map((target) => serializeObserveSnapshotTarget(target)));
  return createHash('sha256')
    .update(SEMANTIC_OBSERVE_SNAPSHOT_CACHE_KEY_VERSION)
    .update(payload)
    .digest('hex');
}

function semanticObserveGoalKey(goal: string): string {
  return createHash('sha256')
    .update(SEMANTIC_OBSERVE_GOAL_CACHE_KEY_VERSION)
    .update(normalizedGoalText(goal))
    .digest('hex');
}

function serializeLexicalDocument(
  lexicalDocument: SemanticObserveLexicalDocument
): CachedLexicalDocument {
  return {
    analyzerKey: lexicalDocument.analyzerKey,
    weightedLength: lexicalDocument.weightedLength,
    weightedTermFrequencies: [...lexicalDocument.weightedTermFrequencies.entries()],
  };
}

function deserializeLexicalDocument(
  lexicalDocument: CachedLexicalDocument
): SemanticObserveLexicalDocument {
  return {
    analyzerKey: lexicalDocument.analyzerKey,
    weightedLength: lexicalDocument.weightedLength,
    weightedTermFrequencies: new Map(lexicalDocument.weightedTermFrequencies),
  };
}

function ensureSemanticObserveSnapshotCache(
  session: BrowserSessionState
): SemanticObserveSnapshotCacheState {
  const existing = semanticObserveSnapshotCacheBySession.get(session);
  if (
    existing &&
    existing.version === SEMANTIC_OBSERVE_SNAPSHOT_CACHE_VERSION &&
    Array.isArray(existing.order) &&
    existing.snapshotsByKey &&
    typeof existing.snapshotsByKey === 'object'
  ) {
    return existing;
  }

  const nextCache: SemanticObserveSnapshotCacheState = {
    version: SEMANTIC_OBSERVE_SNAPSHOT_CACHE_VERSION,
    order: [],
    snapshotsByKey: {},
  };
  semanticObserveSnapshotCacheBySession.set(session, nextCache);
  return nextCache;
}

function touchSemanticObserveSnapshotCacheEntry(
  cache: SemanticObserveSnapshotCacheState,
  snapshotKey: string
): void {
  cache.order = [snapshotKey, ...cache.order.filter((key) => key !== snapshotKey)].slice(
    0,
    SEMANTIC_OBSERVE_MAX_SNAPSHOT_CACHE_ENTRIES
  );
  for (const key of Object.keys(cache.snapshotsByKey)) {
    if (!cache.order.includes(key)) {
      delete cache.snapshotsByKey[key];
    }
  }
}

function materializeCachedRetrievalEntities<T extends ObserveInventoryTarget>(
  targets: ReadonlyArray<T>,
  cachedEntities: ReadonlyArray<CachedGoalRetrievalEntity>
): GoalRetrievalEntity<T>[] | null {
  const materialized: GoalRetrievalEntity<T>[] = [];

  for (const cachedEntity of cachedEntities) {
    const representative = targets[cachedEntity.representativeIndex];
    if (!representative) {
      return null;
    }
    if (cachedEntity.memberIndexes.some((index) => !targets[index])) {
      return null;
    }

    materialized.push({
      entityKind: cachedEntity.entityKind,
      entityKey: cachedEntity.entityKey,
      firstIndex: cachedEntity.firstIndex,
      memberIndexes: [...cachedEntity.memberIndexes],
      representative,
      label: pickEntityLabel(cachedEntity.entityKind, representative),
      kind:
        cachedEntity.entityKind === 'form'
          ? 'form'
          : cachedEntity.entityKind === 'item'
            ? (representative.surfaceKind ?? representative.kind)
            : representative.kind,
      surfaceKind: representative.surfaceKind,
      surfaceLabel: representative.surfaceLabel,
      surfacePriority: representative.surfacePriority,
      framePath: representative.framePath,
      frameUrl: representative.frameUrl,
      context: representative.context,
      structure: representative.structure,
      representativeLabels: [],
      analyzerKey: cachedEntity.analyzerKey,
      lexicalDocument: deserializeLexicalDocument(cachedEntity.lexicalDocument),
    });
  }

  return materialized;
}

function loadCachedRetrievalEntities<T extends ObserveInventoryTarget>(
  session: BrowserSessionState | undefined,
  snapshotKey: string,
  targets: ReadonlyArray<T>
): GoalRetrievalEntity<T>[] | null {
  if (!session) {
    return null;
  }

  const cache = ensureSemanticObserveSnapshotCache(session);
  const entry = cache.snapshotsByKey[snapshotKey];
  if (!entry || entry.targetCount !== targets.length || !entry.retrievalEntities) {
    return null;
  }

  const materialized = materializeCachedRetrievalEntities(targets, entry.retrievalEntities);
  if (!materialized) {
    delete cache.snapshotsByKey[snapshotKey];
    cache.order = cache.order.filter((key) => key !== snapshotKey);
    return null;
  }

  touchSemanticObserveSnapshotCacheEntry(cache, snapshotKey);
  return materialized;
}

function saveCachedRetrievalEntities<T extends ObserveInventoryTarget>(
  session: BrowserSessionState | undefined,
  snapshotKey: string,
  targets: ReadonlyArray<T>,
  entities: ReadonlyArray<GoalRetrievalEntity<T>>
): void {
  if (!session) {
    return;
  }

  const cache = ensureSemanticObserveSnapshotCache(session);
  const indexByTarget = new Map(targets.map((target, index) => [target, index]));
  const existingEntry = cache.snapshotsByKey[snapshotKey];

  cache.snapshotsByKey[snapshotKey] = {
    snapshotKey,
    targetCount: targets.length,
    cachedAt: new Date().toISOString(),
    retrievalEntities: entities.map((entity) => ({
      entityKind: entity.entityKind,
      entityKey: entity.entityKey,
      firstIndex: entity.firstIndex,
      representativeIndex: indexByTarget.get(entity.representative) ?? entity.firstIndex,
      memberIndexes: [...entity.memberIndexes],
      analyzerKey: entity.analyzerKey,
      lexicalDocument: serializeLexicalDocument(entity.lexicalDocument),
    })),
    goalShortlists: existingEntry?.goalShortlists ?? {},
    goalOrder: existingEntry?.goalOrder ?? [],
  };
  touchSemanticObserveSnapshotCacheEntry(cache, snapshotKey);
}

function loadCachedGoalShortlist<T extends ObserveInventoryTarget>(
  session: BrowserSessionState | undefined,
  snapshotKey: string,
  goalKey: string,
  targets: ReadonlyArray<T>
): T[] | null {
  if (!session || !goalKey) {
    return null;
  }

  const cache = ensureSemanticObserveSnapshotCache(session);
  const entry = cache.snapshotsByKey[snapshotKey];
  const shortlist = entry?.goalShortlists?.[goalKey];
  if (!entry || entry.targetCount !== targets.length || !shortlist) {
    return null;
  }

  const candidates = shortlist.candidateIndexes.map((index) => targets[index]).filter(Boolean);
  if (candidates.length !== shortlist.candidateIndexes.length) {
    delete entry.goalShortlists?.[goalKey];
    entry.goalOrder = (entry.goalOrder ?? []).filter((key) => key !== goalKey);
    return null;
  }

  entry.goalOrder = [goalKey, ...(entry.goalOrder ?? []).filter((key) => key !== goalKey)].slice(
    0,
    SEMANTIC_OBSERVE_MAX_GOAL_SHORTLISTS_PER_SNAPSHOT
  );
  touchSemanticObserveSnapshotCacheEntry(cache, snapshotKey);
  return candidates as T[];
}

function saveCachedGoalShortlist<T extends ObserveInventoryTarget>(
  session: BrowserSessionState | undefined,
  snapshotKey: string,
  goalKey: string,
  targets: ReadonlyArray<T>,
  shortlist: ReadonlyArray<T>
): void {
  if (!session || !goalKey) {
    return;
  }

  const cache = ensureSemanticObserveSnapshotCache(session);
  const existingEntry = cache.snapshotsByKey[snapshotKey];
  const entry: SemanticObserveSnapshotCacheEntry = existingEntry ?? {
    snapshotKey,
    targetCount: targets.length,
    cachedAt: new Date().toISOString(),
    goalShortlists: {},
    goalOrder: [],
  };
  const indexByTarget = new Map(targets.map((target, index) => [target, index]));

  entry.targetCount = targets.length;
  entry.cachedAt = new Date().toISOString();
  entry.goalShortlists ??= {};
  entry.goalOrder = [goalKey, ...(entry.goalOrder ?? []).filter((key) => key !== goalKey)].slice(
    0,
    SEMANTIC_OBSERVE_MAX_GOAL_SHORTLISTS_PER_SNAPSHOT
  );
  entry.goalShortlists[goalKey] = {
    goalKey,
    candidateIndexes: shortlist
      .map((candidate) => indexByTarget.get(candidate))
      .filter((index): index is number => index !== undefined),
    cachedAt: entry.cachedAt,
  };

  for (const cachedGoalKey of Object.keys(entry.goalShortlists)) {
    if (!entry.goalOrder.includes(cachedGoalKey)) {
      delete entry.goalShortlists[cachedGoalKey];
    }
  }

  cache.snapshotsByKey[snapshotKey] = entry;
  touchSemanticObserveSnapshotCacheEntry(cache, snapshotKey);
}

function scopeCandidatePriority(target: ObserveInventoryTarget): number {
  const kind = (target.kind ?? '').trim().toLowerCase();
  if (kind === 'dialog' || kind === 'listbox' || kind === 'menu') {
    return 0;
  }
  if (kind === 'card') {
    return 1;
  }
  if (kind === 'grid' || kind === 'tabpanel' || kind === 'datepicker') {
    return 2;
  }
  if (kind === 'form') {
    return 3;
  }
  return 4;
}

function representativeCandidateScore(target: ObserveInventoryTarget): number {
  const normalizedLabel = normalizeSemanticObserveText(target.label);
  const kind = (target.kind ?? '').trim().toLowerCase();
  const role = (target.role ?? '').trim().toLowerCase();
  let score = (target.surfacePriority ?? 0) * 10;

  if (isPrimaryFormControlTarget(target)) {
    score += 1_500 - primaryFormTargetPriority(target) * 100;
  } else if (isFieldLikeTarget(target)) {
    score += 1_250;
  } else if (isActionLikeTargetCandidate(target)) {
    score += 1_000;
  } else if (isScopeLikeCandidate(target)) {
    score += 700;
  }

  if (target.allowedActions?.includes('fill') || target.allowedActions?.includes('select')) {
    score += 120;
  }
  if (target.allowedActions?.includes('click') || target.allowedActions?.includes('press')) {
    score += 80;
  }
  if (target.acceptancePolicy === 'submit') {
    score += 120;
  }
  if (target.acceptancePolicy === 'navigation') {
    score += 60;
  }
  if (kind === 'link' || role === 'link') {
    score += 40;
  }

  if (normalizedLabel) {
    score += Math.min(normalizedLabel.length, 100);
    if (normalizedLabel === 'button' || normalizedLabel === 'link') {
      score -= 300;
    }
    if (normalizedLabel.includes('opens in new window')) {
      score -= 120;
    }
    if (normalizedLabel.includes('save this item')) {
      score -= 80;
    }
  }

  return score;
}

function entityMemberPriority(
  entityKind: GoalRetrievalEntityKind,
  target: ObserveInventoryTarget
): number {
  if (entityKind === 'form' && isPrimaryFormControlTarget(target)) {
    return 5_000 - primaryFormTargetPriority(target) * 100;
  }
  if (entityKind === 'scope' && isScopeLikeCandidate(target)) {
    return representativeCandidateScore(target) - 200;
  }
  return representativeCandidateScore(target);
}

function compareEntityMembers(
  entityKind: GoalRetrievalEntityKind,
  left: { index: number; target: ObserveInventoryTarget },
  right: { index: number; target: ObserveInventoryTarget }
): number {
  const scoreDelta =
    entityMemberPriority(entityKind, right.target) - entityMemberPriority(entityKind, left.target);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  return left.index - right.index;
}

function pickEntityLabel(
  entityKind: GoalRetrievalEntityKind,
  representative: ObserveInventoryTarget
): string | undefined {
  if (entityKind === 'form') {
    return (
      representative.context?.landmark?.label ??
      representative.context?.container?.label ??
      representative.context?.group?.label ??
      representative.surfaceLabel ??
      representative.label
    );
  }

  return (
    goalLabelOf(representative) ??
    representative.context?.container?.label ??
    representative.context?.item?.label ??
    representative.surfaceLabel ??
    representative.context?.group?.label ??
    representative.context?.landmark?.label
  );
}

function collectRepresentativeLabels(targets: ReadonlyArray<ObserveInventoryTarget>): string[] {
  const labels: string[] = [];
  for (const target of targets) {
    for (const label of [goalLabelOf(target), ...goalAliasesOf(target)]) {
      if (!label || label === 'Button' || label === 'Link' || labels.includes(label)) {
        continue;
      }
      labels.push(label);
      if (labels.length >= 4) {
        return labels;
      }
    }
  }
  return labels;
}

function structureLexicalValue(structure: TargetStructure | undefined): string | undefined {
  if (!structure) {
    return undefined;
  }

  return [
    structure.family,
    structure.variant,
    structure.row,
    structure.column,
    structure.zone,
    structure.cellLabel,
  ]
    .filter(Boolean)
    .join(' ');
}

function latentActionHintText(target: ObserveInventoryTarget): string | undefined {
  const acceptancePolicy = (target.acceptancePolicy ?? '').trim().toLowerCase();
  const controlFamily = (target.controlFamily ?? '').trim().toLowerCase();
  const surfaceKind = (target.surfaceKind ?? '').trim().toLowerCase();
  const kind = (target.kind ?? '').trim().toLowerCase();
  const role = (target.role ?? '').trim().toLowerCase();
  const popupBacked =
    acceptancePolicy === 'disclosure' ||
    Boolean(target.controlsSurfaceSelector) ||
    target.states?.expanded !== undefined;

  if (!popupBacked) {
    return undefined;
  }

  const hints = new Set<string>();
  hints.add('open menu options choices');

  if (!isFieldLikeTarget(target)) {
    hints.add('sort sorting filter filters view switch picker');
  }

  if (
    controlFamily === 'select' ||
    ['menu', 'listbox', 'dropdown', 'popover'].includes(surfaceKind)
  ) {
    hints.add('select choose option options menu dropdown listbox');
  }

  if (controlFamily === 'datepicker' || surfaceKind === 'datepicker') {
    hints.add('open calendar datepicker date picker choose date calendar');
  }

  const evidenceText = [
    target.label,
    target.placeholder,
    target.title,
    target.surfaceLabel,
    target.context?.group?.label,
    target.context?.container?.label,
    target.context?.landmark?.label,
    target.context?.hintText,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();

  if (
    /(?:sort|sorting|show first|ordered by|order by|popular|relevance|recommended|price|cheap|cheapest|expensive|сорт|сначала|популяр|релевант|рекоменд|цене|дешев|дорог)/i.test(
      evidenceText
    )
  ) {
    hints.add(
      'sort sorting order order by relevance popular recommended price cheapest cheapest first'
    );
  }

  if (
    /(?:filter|filters|refine|brand|airline|amenit|фильтр|фильтры|бренд|авиакомпан|удобств)/i.test(
      evidenceText
    )
  ) {
    hints.add('filter filters refine refine results brand airline amenities');
  }

  if (
    /(?:view|layout|grid|list|map|calendar view|вид|список|сетка|карта|раскладк)/i.test(
      evidenceText
    )
  ) {
    hints.add('view layout grid list map switch');
  }

  if (
    kind === 'button' &&
    role === 'button' &&
    (acceptancePolicy === 'disclosure' ||
      controlFamily === 'select' ||
      controlFamily === 'datepicker')
  ) {
    hints.add('open selector choose mode');
  }

  return hints.size > 0 ? [...hints].join(' ') : undefined;
}

function buildEntityLexicalFields(
  entityLabel: string | undefined,
  representative: ObserveInventoryTarget,
  representativeLabels: ReadonlyArray<string>
): SemanticObserveLexicalField[] {
  const representativeGoalLabel = goalLabelOf(representative);

  return [
    { value: entityLabel, weight: RETRIEVAL_FIELD_WEIGHTS.entityLabel },
    { value: representativeGoalLabel, weight: RETRIEVAL_FIELD_WEIGHTS.representativeLabel },
    ...representativeLabels.map((value) => ({
      value,
      weight: RETRIEVAL_FIELD_WEIGHTS.representativeLabels,
    })),
    { value: representative.surfaceLabel, weight: RETRIEVAL_FIELD_WEIGHTS.surfaceLabel },
    { value: representative.placeholder, weight: RETRIEVAL_FIELD_WEIGHTS.placeholder },
    { value: representative.title, weight: RETRIEVAL_FIELD_WEIGHTS.title },
    { value: representative.context?.item?.label, weight: RETRIEVAL_FIELD_WEIGHTS.itemLabel },
    { value: representative.context?.item?.text, weight: RETRIEVAL_FIELD_WEIGHTS.itemText },
    { value: representative.context?.group?.label, weight: RETRIEVAL_FIELD_WEIGHTS.groupLabel },
    { value: representative.context?.group?.text, weight: RETRIEVAL_FIELD_WEIGHTS.groupText },
    {
      value: representative.context?.container?.label,
      weight: RETRIEVAL_FIELD_WEIGHTS.containerLabel,
    },
    {
      value: representative.context?.container?.text,
      weight: RETRIEVAL_FIELD_WEIGHTS.containerText,
    },
    {
      value: representative.context?.landmark?.label,
      weight: RETRIEVAL_FIELD_WEIGHTS.landmarkLabel,
    },
    {
      value: representative.context?.landmark?.text,
      weight: RETRIEVAL_FIELD_WEIGHTS.landmarkText,
    },
    { value: representative.context?.hintText, weight: RETRIEVAL_FIELD_WEIGHTS.hintText },
    { value: representative.kind, weight: RETRIEVAL_FIELD_WEIGHTS.kind },
    { value: representative.role, weight: RETRIEVAL_FIELD_WEIGHTS.role },
    { value: representative.surfaceKind, weight: RETRIEVAL_FIELD_WEIGHTS.surfaceKind },
    {
      value: representative.controlFamily,
      weight: RETRIEVAL_FIELD_WEIGHTS.controlFamily,
    },
    {
      value: representative.acceptancePolicy,
      weight: RETRIEVAL_FIELD_WEIGHTS.acceptancePolicy,
    },
    {
      value: representative.allowedActions?.join(' '),
      weight: RETRIEVAL_FIELD_WEIGHTS.allowedActions,
    },
    {
      value: structureLexicalValue(representative.structure),
      weight: RETRIEVAL_FIELD_WEIGHTS.structure,
    },
    {
      value: latentActionHintText(representative),
      weight: RETRIEVAL_FIELD_WEIGHTS.latentIntent,
    },
  ];
}

function buildGoalRetrievalEntity<T extends ObserveInventoryTarget>(
  entityKind: GoalRetrievalEntityKind,
  entityKey: string,
  memberIndexes: ReadonlyArray<number>,
  targets: ReadonlyArray<T>
): GoalRetrievalEntity<T> {
  const orderedMembers = [...memberIndexes]
    .map((index) => ({ index, target: targets[index]! }))
    .sort((left, right) => compareEntityMembers(entityKind, left, right));
  const representative = orderedMembers[0]!.target;
  const representativeLabels = collectRepresentativeLabels(
    orderedMembers.map((entry) => entry.target)
  );
  const label = pickEntityLabel(entityKind, representative);
  const lexicalFields = buildEntityLexicalFields(label, representative, representativeLabels);
  const lexicalDocument = buildSemanticObserveLexicalDocument(lexicalFields);

  return {
    entityKind,
    entityKey,
    firstIndex: Math.min(...memberIndexes),
    memberIndexes: orderedMembers.map((entry) => entry.index),
    representative,
    label,
    kind:
      entityKind === 'form'
        ? 'form'
        : entityKind === 'item'
          ? (representative.surfaceKind ?? representative.kind)
          : representative.kind,
    surfaceKind: representative.surfaceKind,
    surfaceLabel: representative.surfaceLabel,
    surfacePriority: representative.surfacePriority,
    framePath: representative.framePath,
    frameUrl: representative.frameUrl,
    context: representative.context,
    structure: representative.structure,
    representativeLabels,
    analyzerKey: lexicalDocument.analyzerKey,
    lexicalDocument,
  };
}

function buildGoalRetrievalEntities<T extends ObserveInventoryTarget>(
  targets: ReadonlyArray<T>
): GoalRetrievalEntity<T>[] {
  const entities: GoalRetrievalEntity<T>[] = [];
  const groupedTargetIndexes = new Set<number>();
  const nonScopeTargetsBySurface = new Map<string, number[]>();

  for (const [index, target] of targets.entries()) {
    if (isScopeLikeCandidate(target)) {
      continue;
    }

    const surfaceIdentity = surfaceIdentityOf(target);
    if (!surfaceIdentity) {
      continue;
    }

    const linked = nonScopeTargetsBySurface.get(surfaceIdentity) ?? [];
    linked.push(index);
    nonScopeTargetsBySurface.set(surfaceIdentity, linked);
  }

  const formGroups = new Map<string, number[]>();
  for (const [index, target] of targets.entries()) {
    if (isScopeLikeCandidate(target)) {
      continue;
    }

    const bucketKey = formBucketKey(target);
    if (!bucketKey) {
      continue;
    }

    const members = formGroups.get(bucketKey) ?? [];
    members.push(index);
    formGroups.set(bucketKey, members);
  }
  for (const [key, memberIndexes] of formGroups.entries()) {
    entities.push(buildGoalRetrievalEntity('form', `form:${key}`, memberIndexes, targets));
    memberIndexes.forEach((index) => {
      if (shouldPreserveStandaloneFormActionEntity(targets[index]!)) {
        return;
      }
      groupedTargetIndexes.add(index);
    });
  }

  const itemGroups = new Map<string, number[]>();
  for (const [index, target] of targets.entries()) {
    const bucketKey = contentItemBucketKey(target);
    if (!bucketKey) {
      continue;
    }

    const members = itemGroups.get(bucketKey) ?? [];
    members.push(index);
    itemGroups.set(bucketKey, members);
  }
  for (const [key, memberIndexes] of itemGroups.entries()) {
    entities.push(buildGoalRetrievalEntity('item', `item:${key}`, memberIndexes, targets));
    memberIndexes.forEach((index) => groupedTargetIndexes.add(index));
  }

  for (const [index, target] of targets.entries()) {
    if (!isHighSignalScopeCandidate(target)) {
      continue;
    }

    const kind = (target.kind ?? '').trim().toLowerCase();
    const surfaceIdentity = surfaceIdentityOf(target);
    if (!surfaceIdentity) {
      continue;
    }
    if (kind === 'form') {
      continue;
    }
    if (kind === 'card' && itemGroups.has(`surface:${surfaceIdentity}`)) {
      continue;
    }

    const linkedTargets = nonScopeTargetsBySurface.get(surfaceIdentity) ?? [];
    const memberIndexes = [index, ...linkedTargets];
    entities.push(
      buildGoalRetrievalEntity('scope', `scope:${surfaceIdentity}`, memberIndexes, targets)
    );
    linkedTargets.forEach((targetIndex) => groupedTargetIndexes.add(targetIndex));
  }

  for (const [index, target] of targets.entries()) {
    if (isScopeLikeCandidate(target) || groupedTargetIndexes.has(index)) {
      continue;
    }
    if (
      !isActionLikeTargetCandidate(target) &&
      !isFieldLikeTarget(target) &&
      !isPrimaryFormControlTarget(target)
    ) {
      continue;
    }

    entities.push(buildGoalRetrievalEntity('standalone', `target:${index}`, [index], targets));
  }

  return entities.sort((left, right) => left.firstIndex - right.firstIndex);
}

function retrievalEntityPriority(entity: GoalRetrievalEntity<ObserveInventoryTarget>): number {
  let score = (entity.surfacePriority ?? 0) * 10;

  switch (entity.entityKind) {
    case 'form':
      score += 900;
      break;
    case 'item':
      score += 820;
      break;
    case 'scope':
      score += 720;
      break;
    case 'standalone':
      score += 600;
      break;
  }

  score += Math.min(entity.memberIndexes.length, 6) * 25;
  score += representativeCandidateScore(entity.representative);
  return score;
}

function scoreRetrievalEntityAgainstGoal(
  analyzedGoal: ReturnType<typeof analyzeSemanticObserveText>,
  entity: GoalRetrievalEntity<ObserveInventoryTarget>,
  corpusStats: ReturnType<typeof buildSemanticObserveBm25CorpusStats>
): number {
  if (!analyzedGoal.normalizedText) {
    return 0;
  }

  if (entity.lexicalDocument.weightedLength <= 0) {
    return 0;
  }

  const bm25Score = scoreSemanticObserveBm25(analyzedGoal, entity.lexicalDocument, corpusStats);
  const analyzerAlignmentScore =
    analyzedGoal.analyzerKey !== 'neutral' && analyzedGoal.analyzerKey === entity.analyzerKey
      ? 15
      : 0;
  return bm25Score * 100 + analyzerAlignmentScore;
}

function preselectRetrievalEntities<T extends ObserveInventoryTarget>(
  goal: string,
  entities: ReadonlyArray<GoalRetrievalEntity<T>>
): GoalRetrievalEntity<T>[] {
  if (entities.length <= GOAL_RETRIEVAL_ENTITY_LIMIT) {
    return [...entities];
  }

  const analyzedGoal = analyzeSemanticObserveText(goal);
  const corpusStats = buildSemanticObserveBm25CorpusStats(
    entities.map((entity) => entity.lexicalDocument)
  );
  const scored = entities.map((entity) => ({
    entity,
    lexicalScore: scoreRetrievalEntityAgainstGoal(analyzedGoal, entity, corpusStats),
    priority: retrievalEntityPriority(entity),
  }));
  const selected: GoalRetrievalEntity<T>[] = [];
  const seenKeys = new Set<string>();

  for (const entry of scored
    .filter((candidate) => candidate.lexicalScore > 0)
    .sort(
      (left, right) =>
        right.lexicalScore - left.lexicalScore ||
        right.priority - left.priority ||
        left.entity.firstIndex - right.entity.firstIndex
    )) {
    if (seenKeys.has(entry.entity.entityKey)) {
      continue;
    }
    seenKeys.add(entry.entity.entityKey);
    selected.push(entry.entity);
    if (selected.length >= GOAL_RETRIEVAL_ENTITY_LIMIT) {
      return selected;
    }
  }

  for (const entry of scored.sort(
    (left, right) =>
      right.priority - left.priority || left.entity.firstIndex - right.entity.firstIndex
  )) {
    if (seenKeys.has(entry.entity.entityKey)) {
      continue;
    }
    seenKeys.add(entry.entity.entityKey);
    selected.push(entry.entity);
    if (selected.length >= GOAL_RETRIEVAL_ENTITY_LIMIT) {
      break;
    }
  }

  return selected;
}

function expandRetrievalEntitiesToCandidates<T extends ObserveInventoryTarget>(
  targets: ReadonlyArray<T>,
  entities: ReadonlyArray<GoalRetrievalEntity<T>>
): T[] {
  const orderedIndexes: number[] = [];
  const seenIndexes = new Set<number>();

  for (const entity of entities) {
    for (const index of entity.memberIndexes) {
      if (seenIndexes.has(index)) {
        continue;
      }
      seenIndexes.add(index);
      orderedIndexes.push(index);
    }
  }

  return orderedIndexes.map((index) => targets[index]!).filter(Boolean);
}

function collectBucketedCandidateIndexes<T extends ObserveInventoryTarget>(
  targets: ReadonlyArray<T>,
  options: {
    totalLimit: number;
    perBucketLimit: number;
    bucketKeyOf: (target: T) => string | undefined;
    predicate: (target: T) => boolean;
    priorityOf?: (target: T) => number;
  }
): number[] {
  const bucketEntries = new Map<string, Array<{ index: number; target: T }>>();

  for (const [index, target] of targets.entries()) {
    if (!options.predicate(target)) {
      continue;
    }

    const bucketKey = options.bucketKeyOf(target);
    if (!bucketKey) {
      continue;
    }

    const entries = bucketEntries.get(bucketKey) ?? [];
    entries.push({ index, target });
    bucketEntries.set(bucketKey, entries);
  }

  const bucketQueues = [...bucketEntries.values()]
    .map((entries) =>
      entries
        .sort((left, right) => {
          const leftPriority = options.priorityOf?.(left.target) ?? 0;
          const rightPriority = options.priorityOf?.(right.target) ?? 0;
          if (leftPriority !== rightPriority) {
            return leftPriority - rightPriority;
          }
          return left.index - right.index;
        })
        .slice(0, options.perBucketLimit)
    )
    .sort((left, right) => left[0]!.index - right[0]!.index);

  const selectedIndexes: number[] = [];
  while (selectedIndexes.length < options.totalLimit) {
    let progressed = false;
    for (const queue of bucketQueues) {
      const next = queue.shift();
      if (!next) {
        continue;
      }
      selectedIndexes.push(next.index);
      progressed = true;
      if (selectedIndexes.length >= options.totalLimit) {
        break;
      }
    }
    if (!progressed) {
      break;
    }
  }

  return selectedIndexes;
}

function diversifyCandidates<T extends ObserveInventoryTarget>(targets: ReadonlyArray<T>): T[] {
  if (targets.length <= RERANK_CANDIDATE_LIMIT) {
    return [...targets];
  }

  const orderedIndexes: number[] = [];
  const selectedIndexes = new Set<number>();
  const pushSelectedIndexes = (indexes: ReadonlyArray<number>) => {
    for (const index of indexes) {
      if (selectedIndexes.has(index)) {
        continue;
      }
      selectedIndexes.add(index);
      orderedIndexes.push(index);
      if (orderedIndexes.length >= RERANK_CANDIDATE_LIMIT) {
        break;
      }
    }
  };

  pushSelectedIndexes(
    collectBucketedCandidateIndexes(targets, {
      totalLimit: FORM_BUCKET_RESERVE_LIMIT,
      perBucketLimit: FORM_BUCKET_RESERVE_PER_BUCKET,
      bucketKeyOf: (target) => candidateBucketKey(target, { preferFormBucket: true }),
      predicate: (target) => Boolean(formBucketKey(target)) && isPrimaryFormControlTarget(target),
      priorityOf: primaryFormTargetPriority,
    })
  );
  pushSelectedIndexes(
    collectBucketedCandidateIndexes(targets, {
      totalLimit: SCOPE_BUCKET_RESERVE_LIMIT,
      perBucketLimit: SCOPE_BUCKET_RESERVE_PER_BUCKET,
      bucketKeyOf: (target) => candidateBucketKey(target),
      predicate: isHighSignalScopeCandidate,
      priorityOf: scopeCandidatePriority,
    })
  );
  pushSelectedIndexes(
    collectBucketedCandidateIndexes(targets, {
      totalLimit: IFRAME_BUCKET_RESERVE_LIMIT,
      perBucketLimit: IFRAME_BUCKET_RESERVE_PER_BUCKET,
      bucketKeyOf: (target) => candidateBucketKey(target),
      predicate: (target) => Boolean(target.framePath?.length) && isFieldLikeTarget(target),
    })
  );

  for (
    let index = 0;
    index < targets.length && orderedIndexes.length < RERANK_CANDIDATE_LIMIT;
    index += 1
  ) {
    if (selectedIndexes.has(index)) {
      continue;
    }
    selectedIndexes.add(index);
    orderedIndexes.push(index);
  }

  return orderedIndexes.map((index) => targets[index]!).slice(0, RERANK_CANDIDATE_LIMIT);
}

function compactContextValue(value: string | undefined, maxLength = 80): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function compactCandidateContext(
  target: ObserveInventoryTarget
): Record<string, string> | undefined {
  const context = target.context;
  if (!context) {
    return undefined;
  }

  const compacted: Record<string, string> = {};
  const push = (key: string, value: string | undefined) => {
    const compactedValue = compactContextValue(value);
    if (!compactedValue) {
      return;
    }
    compacted[key] = compactedValue;
  };

  push('item', context.item?.label ?? context.item?.text);
  push('group', context.group?.label ?? context.group?.text);
  push('container', context.container?.label ?? context.container?.text);
  push('landmark', context.landmark?.label ?? context.landmark?.text);
  push('hint', context.hintText);

  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function normalizedGoalText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function goalNeedsScopeCandidates(goal: string): boolean {
  const normalizedGoal = normalizedGoalText(goal);
  if (!normalizedGoal) {
    return true;
  }

  const scopeHints = [
    'form',
    'forms',
    'field',
    'fields',
    'control',
    'controls',
    'dialog',
    'modal',
    'popup',
    'widget',
    'section',
    'panel',
    'menu',
    'listbox',
    'dropdown',
    'calendar',
    'datepicker',
    'card',
    'results',
    'scope',
    'region',
    'surface',
    'форма',
    'форму',
    'поля',
    'поля ввода',
    'контрол',
    'диалог',
    'модал',
    'попап',
    'виджет',
    'секци',
    'панел',
    'меню',
    'список',
    'выпада',
    'календар',
    'карточ',
    'результат',
    'область',
    'регион',
  ];

  return scopeHints.some((hint) => normalizedGoal.includes(hint));
}

function relevantTargetsForGoal<T extends ObserveInventoryTarget>(
  goal: string,
  targets: ReadonlyArray<T>
): T[] {
  if (goalNeedsScopeCandidates(goal)) {
    return [...targets];
  }

  const directTargets = targets.filter((target) => !isScopeLikeCandidate(target));
  return directTargets.length > 0 ? directTargets : [...targets];
}

function buildSurfaceSummaryLine(target: ObserveInventoryTarget, id: string): string {
  const parts = [`${id}`];
  const context = compactCandidateContext(target);
  const surfaceKind =
    target.surfaceKind ??
    target.context?.container?.kind ??
    target.context?.group?.kind ??
    target.kind;
  const surfaceLabel =
    target.surfaceLabel ??
    target.context?.container?.label ??
    target.context?.group?.label ??
    target.context?.landmark?.label ??
    target.label;

  if (surfaceKind) {
    parts.push(`kind=${JSON.stringify(surfaceKind)}`);
  }
  if (surfaceLabel) {
    parts.push(`label=${JSON.stringify(surfaceLabel)}`);
  }
  if (typeof target.surfacePriority === 'number') {
    parts.push(`priority=${JSON.stringify(target.surfacePriority)}`);
  }
  if (target.framePath?.length) {
    parts.push(`framePath=${JSON.stringify(target.framePath)}`);
  }
  if (context) {
    parts.push(`context=${JSON.stringify(context)}`);
  }

  return parts.join(' | ');
}

function buildSurfaceSummaries<T extends ObserveInventoryTarget>(
  targets: ReadonlyArray<T>
): {
  summaries: SurfaceSummaryEntry[];
  summaryIdBySurfaceKey: Map<string, string>;
} {
  const summaries: SurfaceSummaryEntry[] = [];
  const summaryIdBySurfaceKey = new Map<string, string>();

  for (const target of targets) {
    const surfaceKey = surfaceIdentityOf(target);
    if (!surfaceKey || summaryIdBySurfaceKey.has(surfaceKey)) {
      continue;
    }

    const id = `s${summaries.length + 1}`;
    summaryIdBySurfaceKey.set(surfaceKey, id);
    summaries.push({
      id,
      line: buildSurfaceSummaryLine(target, id),
    });
  }

  return { summaries, summaryIdBySurfaceKey };
}

function buildCompactCandidateSummary(
  target: ObserveInventoryTarget,
  index: number,
  surfaceSummaryIdBySurfaceKey?: ReadonlyMap<string, string>
): string {
  const parts = [`id=c${index + 1}`];
  const compactContext = compactCandidateContext(target);
  const goalLabel = goalLabelOf(target);
  const goalAliases = goalAliasesOf(target).map(
    (value) => compactContextValue(value, 120) ?? value
  );
  const surfaceSummaryId = surfaceIdentityOf(target)
    ? surfaceSummaryIdBySurfaceKey?.get(surfaceIdentityOf(target)!)
    : undefined;

  if (target.kind) parts.push(`kind=${JSON.stringify(target.kind)}`);
  if (target.role) parts.push(`role=${JSON.stringify(target.role)}`);
  if (goalLabel) parts.push(`label=${JSON.stringify(goalLabel)}`);
  if (goalAliases.length) parts.push(`aliases=${JSON.stringify(goalAliases)}`);
  if (target.allowedActions?.length) {
    parts.push(`actions=${JSON.stringify(target.allowedActions)}`);
  }
  if (target.acceptancePolicy) {
    parts.push(`policy=${JSON.stringify(target.acceptancePolicy)}`);
  }
  if (target.controlFamily) {
    parts.push(`family=${JSON.stringify(target.controlFamily)}`);
  }
  if (target.controlsSurfaceSelector) {
    parts.push('controlsPopup=true');
  }
  if (target.capability && target.capability !== 'actionable') {
    parts.push(`capability=${JSON.stringify(target.capability)}`);
  }
  if (surfaceSummaryId) {
    parts.push(`surface=${surfaceSummaryId}`);
  }
  if (target.structure) parts.push(`structure=${JSON.stringify(target.structure)}`);
  if (target.placeholder) parts.push(`placeholder=${JSON.stringify(target.placeholder)}`);
  if (target.states) parts.push(`state=${JSON.stringify(target.states)}`);
  if (target.framePath?.length) parts.push(`framePath=${JSON.stringify(target.framePath)}`);
  if (compactContext) parts.push(`context=${JSON.stringify(compactContext)}`);

  return parts.join(' | ');
}

function normalizeCandidateId(value: string): string {
  return value.trim().toLowerCase();
}

export async function rerankDomTargetsForGoal<T extends ObserveInventoryTarget>(
  instruction: string,
  targets: ReadonlyArray<T>,
  options: { session?: BrowserSessionState } = {}
): Promise<T[]> {
  if (targets.length === 0) {
    return [];
  }

  const relevantTargets = relevantTargetsForGoal(instruction, targets);
  options.session &&
    recordPayloadBudget(options.session, {
      observeRerankCandidatesSeen: targets.length,
    });

  const snapshotKey = options.session ? semanticObserveSnapshotKey(relevantTargets) : undefined;
  const goalKey = snapshotKey ? semanticObserveGoalKey(instruction) : undefined;
  const cachedCandidates =
    snapshotKey && goalKey
      ? loadCachedGoalShortlist(options.session, snapshotKey, goalKey, relevantTargets)
      : null;

  let retrievedCandidates: T[];
  if (cachedCandidates) {
    retrievedCandidates = cachedCandidates;
  } else if (relevantTargets.length > RERANK_CANDIDATE_LIMIT) {
    let retrievalEntities = snapshotKey
      ? loadCachedRetrievalEntities(options.session, snapshotKey, relevantTargets)
      : null;
    if (!retrievalEntities) {
      retrievalEntities = buildGoalRetrievalEntities(relevantTargets);
      if (snapshotKey) {
        saveCachedRetrievalEntities(
          options.session,
          snapshotKey,
          relevantTargets,
          retrievalEntities
        );
      }
    }

    retrievedCandidates = expandRetrievalEntitiesToCandidates(
      relevantTargets,
      preselectRetrievalEntities(instruction, retrievalEntities)
    );
  } else {
    retrievedCandidates = [...relevantTargets];
  }

  const candidates = diversifyCandidates(
    retrievedCandidates.length > 0 ? retrievedCandidates : [...relevantTargets]
  );
  if (!cachedCandidates && snapshotKey && goalKey) {
    saveCachedGoalShortlist(options.session, snapshotKey, goalKey, relevantTargets, candidates);
  }
  const { summaries: surfaceSummaries, summaryIdBySurfaceKey } = buildSurfaceSummaries(candidates);

  options.session &&
    recordPayloadBudget(options.session, {
      observeRerankCandidatesSent: candidates.length,
    });

  let client = null;
  try {
    client = tryCreateAgentbrowseAssistiveLlmClient({ session: options.session });
  } catch {
    client = null;
  }
  if (!client) {
    return candidates.slice(0, Math.min(8, candidates.length));
  }

  const prompt = [
    'You are choosing from already discovered visible webpage candidates.',
    'Select only candidate IDs that directly satisfy the goal.',
    'A disclosure trigger with a current-state label can still directly satisfy sort, filter, view-switch, or picker goals when opening it is the immediate next step.',
    'Prefer direct actionable controls over surrounding regions unless the goal explicitly asks for a form, region, widget, or set of controls.',
    'Use owning surface, compact context, explicit state, and structure metadata to disambiguate similar labels.',
    'For input/value goals, prefer the directly editable field or primary picker trigger over wrappers or mirrored summary content.',
    'For structured-grid targets such as dates or seats, use row/column/zone/cell metadata and state.',
    'An exact disabled or readonly field can still be relevant when the goal refers to that specific field.',
    'Do not invent IDs. Return an empty list if nothing clearly matches.',
    '',
    `Goal: ${instruction}`,
    '',
    ...(surfaceSummaries.length > 0
      ? ['Surfaces:', ...surfaceSummaries.map((entry) => entry.line), '']
      : []),
    'Candidates:',
    ...candidates.map((target, index) =>
      buildCompactCandidateSummary(target, index, summaryIdBySurfaceKey)
    ),
  ].join('\n');

  const result = await client.createChatCompletion<z.infer<typeof rerankSchema>>({
    logger: () => {},
    options: {
      messages: [{ role: 'user', content: prompt }],
      response_model: {
        name: 'Observation',
        schema: rerankSchema,
      },
    },
  });

  if (options.session) {
    recordLlmUsage(options.session, {
      purpose: 'browse.observe',
      usage: result.usage,
      inputChars: prompt.length,
    });
  }

  const selectedIds = new Set(
    result.data.matches.map((match) => normalizeCandidateId(match.candidateId))
  );

  return candidates.filter((_, index) => selectedIds.has(`c${index + 1}`));
}
