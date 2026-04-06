/**
 * browse observe ["<instruction>"] — Discover available actions on the page.
 */

import type { BrowserCommandSession } from '../browser-session-state.js';
import { canUseAgentbrowseAssistiveLlmClient } from '../assistive-runtime.js';
import { saveSession } from '../session.js';
import type { SurfaceDescriptor, TargetDescriptor } from '../runtime-state.js';
import { ensureRuntimeState, replaceTargetsForPage } from '../runtime-state.js';
import { incrementMetric } from '../runtime-metrics.js';
import { bumpPageScopeEpoch, setCurrentPage } from '../runtime-page-state.js';
import { getProtectedExposure } from '../runtime-protected-state.js';
import {
  connectPlaywright,
  disconnectPlaywright,
  resolveCurrentPageContext,
  syncSessionPage,
} from '../playwright-runtime.js';
import { tracedStepOperation, withApiTraceContext } from '../command-api-tracing.js';
import {
  captureDiagnosticSnapshotBestEffort,
  finishDiagnosticStepBestEffort,
  recordCommandLifecycleEventBestEffort,
  startDiagnosticStep,
} from '../diagnostics.js';
import {
  outputContractFailure,
  outputJSON,
  type BrowseContractFailure,
  type BrowseResult,
} from '../output.js';
import { domRuntimeResolution, stagehandRuntimeResolution } from '../runtime-resolution.js';
import { withStagehand } from '../stagehand-runtime.js';
import { buildProtectedObserveBlockedResult } from '../secrets/protected-artifact-guard.js';
import { scrubProtectedExactValues } from '../secrets/protected-exact-value-redaction.js';
import { normalizePageSignature } from './descriptor-validation.js';
import {
  collectDomTargets,
  __testDomTargetCollection as inventoryDomTargetCollection,
  __testStagehandDescriptor as inventoryStagehandDescriptor,
} from './observe-inventory.js';
import { enrichDomTargetsWithAccessibility } from './observe-accessibility.js';
import { collectPageSignals } from './observe-signals.js';
import {
  attachObservedTargetOwners,
  linkObservedSurfaceGraph,
  reconcileObservedTargetsForPage,
  persistObservedSurfacesForPage,
  toDomDescriptor,
} from './observe-persistence.js';
import {
  clearProtectedFillableFormsForPage,
  markProtectedFillableFormsUnknownForPage,
  persistProtectedFillableFormsForPage,
} from './observe-protected.js';
import {
  classifyObservePageState,
  shouldSuppressFillableFormsForObserve,
} from './observe-page-state.js';
import {
  annotateDomTargets,
  compressSemanticallyDuplicateTargets,
  orderBySurfaceCompetition,
  prioritizeGoalActionTargets,
} from './observe-semantics.js';
import {
  buildGroupedObserveScopes,
  buildGoalProjectionScopeRefs,
  buildGoalObserveInventoryCandidates,
  type CompactObservedFillableForm,
  type CompactObservedScope,
  type CompactObservedSignal,
  type CompactObservedTarget,
  compactFillableForms,
  compactSignals,
  expandWorkflowGraphTargets,
  projectPersistedTargetsForGoal,
  selectTargetsForGoalMatches,
} from './observe-projection.js';
import { collectSurfaceDescriptors, selectScopesForOutput } from './observe-surfaces.js';
import { toStagehandDescriptor } from './observe-stagehand.js';
import { rerankDomTargetsForGoal } from './semantic-observe.js';

type StagehandObserveAction = {
  description?: string;
  selector?: string;
  method?: string;
  arguments?: unknown[];
};

type ObserveOutputScopeLike = {
  targets?: CompactObservedTarget[];
};

/** Stable top-level error codes returned by `observe(...)`. */
export const OBSERVE_ERROR_CODES = [
  'browser_connection_failed',
  'observe_failed',
  'protected_observe_blocked',
] as const;

/** Stable outcome categories emitted by `observe(...)`. */
export const OBSERVE_OUTCOME_TYPES = [
  'blocked',
  'observation_completed',
  'protected_exposure_active',
] as const;

export type ObserveErrorCode = (typeof OBSERVE_ERROR_CODES)[number];
export type ObserveOutcomeType = (typeof OBSERVE_OUTCOME_TYPES)[number];

export type ObserveExecutionMode =
  | 'deterministic_dom'
  | 'goal_heuristic_shortlist'
  | 'goal_assistive_rerank'
  | 'goal_assistive_stagehand';

/** Flat target entry returned from `observe(...)`. */
export type ObserveTarget = CompactObservedTarget;

/** Grouped scope entry returned from `observe(...)`. */
export type ObserveScope = CompactObservedScope;

/** Protected-fill form binding returned from `observe(...)`. */
export type ObserveFillableForm = CompactObservedFillableForm;

/** Page-level signal entry returned from `observe(...)`. */
export type ObserveSignal = CompactObservedSignal;

type ObserveSuccessPayload = BrowseResult & {
  success: true;
  observationMode: ObserveExecutionMode;
  scopes?: ObserveScope[];
  targets?: ObserveTarget[];
  signals?: ObserveSignal[];
  fillableForms?: ObserveFillableForm[];
};

type ObserveFailurePayload = {
  error: ObserveErrorCode;
  outcomeType: Extract<ObserveOutcomeType, 'blocked' | 'protected_exposure_active'>;
  message: string;
  reason: string;
  pageRef?: string;
  blockedPath?: 'goal-rerank' | 'stagehand-fallback';
  fallbackReason?:
    | 'deterministic-observe-empty'
    | 'deterministic-observe-failed'
    | 'dom-rerank-empty';
  deterministicObserveError?: string;
  fillRef?: string;
  requestId?: string;
  activatedAt?: string;
  exposureReason?: string;
};

export type ObserveSuccessResult = ObserveSuccessPayload & {
  success: true;
  observationMode: ObserveExecutionMode;
  scopes: ObserveScope[];
  targets: ObserveTarget[];
  signals: ObserveSignal[];
  fillableForms: ObserveFillableForm[];
  targetCount: number;
  scopeCount: number;
  projectedTargetCount: number;
};

/** Failed observe result with a stable top-level error code. */
export type ObserveFailureResult = { success: false } & ObserveFailurePayload;

export type ObserveResult = ObserveSuccessResult | ObserveFailureResult;

function flattenObserveTargets(scopes: ObserveScope[] | undefined): ObserveTarget[] {
  if (!Array.isArray(scopes)) {
    return [];
  }

  return scopes.flatMap((scope) => {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
      return [];
    }

    const typedScope = scope as ObserveOutputScopeLike;
    return Array.isArray(typedScope.targets) ? typedScope.targets : [];
  });
}

function normalizeObserveSuccessPayload(payload: ObserveSuccessPayload): ObserveSuccessResult {
  const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
  const explicitTargets = Array.isArray(payload.targets) ? payload.targets : [];
  const targets =
    explicitTargets.length > 0 || Array.isArray(payload.targets)
      ? explicitTargets
      : flattenObserveTargets(scopes);

  return {
    ...payload,
    scopes,
    targets,
    signals: Array.isArray(payload.signals) ? payload.signals : [],
    fillableForms: Array.isArray(payload.fillableForms) ? payload.fillableForms : [],
    targetCount: targets.length,
    scopeCount: scopes.length,
    projectedTargetCount: targets.length,
  };
}

function tryResolveHost(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function buildObservePageMetadata(params: {
  url: string;
  title: string;
  protectedExposure: ReturnType<typeof getProtectedExposure>;
}): Record<string, unknown> {
  return {
    url: params.url,
    title: params.title,
    ...(params.protectedExposure && tryResolveHost(params.url)
      ? { host: tryResolveHost(params.url) }
      : {}),
  };
}

function finalizeObserveStepBestEffort(
  step: ReturnType<typeof startDiagnosticStep>,
  options: {
    success: boolean;
    outcomeType?: string;
    message?: string;
    reason?: string;
  }
): Promise<void> {
  return finishDiagnosticStepBestEffort({
    step,
    ...options,
  });
}

async function buildObserveSuccessResult(
  session: BrowserCommandSession,
  step: ReturnType<typeof startDiagnosticStep>,
  payload: ObserveSuccessPayload
): Promise<ObserveSuccessResult> {
  const normalizedPayload = scrubProtectedExactValues(
    session,
    normalizeObserveSuccessPayload(payload)
  );
  captureDiagnosticSnapshotBestEffort({
    session,
    step,
    phase: 'after',
    pageRef:
      typeof normalizedPayload.pageRef === 'string'
        ? normalizedPayload.pageRef
        : session.runtime?.currentPageRef,
    url: typeof normalizedPayload.url === 'string' ? normalizedPayload.url : undefined,
    title: typeof normalizedPayload.title === 'string' ? normalizedPayload.title : undefined,
  });
  recordCommandLifecycleEventBestEffort({
    step,
    phase: 'completed',
    attributes: {
      outcomeType: 'observation_completed',
      ...(typeof normalizedPayload.pageRef === 'string'
        ? { pageRef: normalizedPayload.pageRef }
        : {}),
      ...(typeof normalizedPayload.resolvedBy === 'string'
        ? { resolvedBy: normalizedPayload.resolvedBy }
        : {}),
    },
  });
  await finalizeObserveStepBestEffort(step, {
    success: true,
    outcomeType: 'observation_completed',
    message:
      typeof normalizedPayload.message === 'string'
        ? normalizedPayload.message
        : 'Observe completed.',
  });
  return normalizedPayload;
}

async function buildObserveContractFailureResult(
  session: BrowserCommandSession,
  params: ObserveFailurePayload & {
    step: ReturnType<typeof startDiagnosticStep>;
    runId?: string;
    stepId?: string;
  }
): Promise<ObserveFailureResult> {
  const step = params.step;
  captureDiagnosticSnapshotBestEffort({
    session,
    step,
    phase: 'point-in-time',
    pageRef: typeof params.pageRef === 'string' ? params.pageRef : undefined,
  });
  recordCommandLifecycleEventBestEffort({
    step,
    phase: 'failed',
    attributes: {
      ...(params.outcomeType ? { outcomeType: params.outcomeType } : {}),
      ...(typeof params.pageRef === 'string' ? { pageRef: params.pageRef } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
    },
  });
  await finalizeObserveStepBestEffort(step, {
    success: false,
    outcomeType: params.outcomeType,
    message: params.message,
    reason: params.reason,
  });
  const { runId: _runId, stepId: _stepId, step: _step, ...result } = params;
  return scrubProtectedExactValues(session, {
    success: false,
    ...result,
  });
}

export const __testDomTargetCollection = inventoryDomTargetCollection;
export const __testStagehandDescriptor = {
  ...inventoryStagehandDescriptor,
  toStagehandDescriptor,
};

/**
 * Observes the current page and returns the current target inventory.
 *
 * The success payload always includes a flat `targets` array for direct
 * consumption and grouped `scopes` for richer container-aware workflows.
 */
export async function observeBrowser(
  session: BrowserCommandSession,
  instruction?: string
): Promise<ObserveResult> {
  const allowAssistive = Boolean(instruction);
  const canUseAssistiveLlm = allowAssistive
    ? canUseAgentbrowseAssistiveLlmClient({ session })
    : false;
  const runtime = ensureRuntimeState(session);
  let pageRef = runtime.currentPageRef;
  let domPassError: string | null = null;
  let stagehandFallbackReason:
    | 'deterministic-observe-empty'
    | 'deterministic-observe-failed'
    | 'dom-rerank-empty'
    | null = null;
  let browser: Awaited<ReturnType<typeof connectPlaywright>> | null = null;
  let observedScopes: SurfaceDescriptor[] = [];
  const observeStep = startDiagnosticStep(
    {
      runId: session.activeRunId,
      command: 'observe',
      input: {
        ...(instruction ? { instruction } : {}),
      },
      refs: {
        pageRef,
      },
      protectedStep: Boolean(session.runtime?.protectedExposureByPage?.[pageRef]),
    },
    { session }
  );
  captureDiagnosticSnapshotBestEffort({
    session,
    step: observeStep,
    phase: 'before',
    pageRef,
  });
  recordCommandLifecycleEventBestEffort({
    step: observeStep,
    phase: 'started',
    attributes: {
      ...(instruction ? { instruction } : {}),
      pageRef,
    },
  });
  return withApiTraceContext(
    {
      runId: session.activeRunId,
      stepId: observeStep?.stepId,
      command: 'observe',
    },
    async () => {
      const observePhaseAttributes = {
        'agentbrowse.observe.goal_based': Boolean(instruction),
      };
      const initialProtectedExposure = instruction ? getProtectedExposure(session, pageRef) : null;
      if (instruction && initialProtectedExposure) {
        return buildObserveContractFailureResult(session, {
          step: observeStep,
          ...buildProtectedObserveBlockedResult(initialProtectedExposure, 'goal-rerank'),
          pageRef,
          runId: session.activeRunId,
          stepId: observeStep?.stepId,
        });
      }

      if (!instruction) {
        try {
          browser = await connectPlaywright(session.cdpUrl);
          const resolvedPage = await resolveCurrentPageContext(browser, session);
          pageRef = resolvedPage.pageRef;
          const page = resolvedPage.page;
          const { url, title } = await syncSessionPage(session, pageRef, page);
          const protectedExposure = getProtectedExposure(session, pageRef);
          bumpPageScopeEpoch(session, pageRef);
          setCurrentPage(session, pageRef);
          const collectedTargets = await collectDomTargets(page);
          let observeAccessibilityStats:
            | { axAttempts: number; axHits: number; fallbackUses: number }
            | undefined;
          const domTargets = compressSemanticallyDuplicateTargets(
            orderBySurfaceCompetition(
              annotateDomTargets(
                await enrichDomTargetsWithAccessibility(page, collectedTargets, {
                  onStats: (stats) => {
                    observeAccessibilityStats = stats;
                  },
                })
              )
            )
          );
          if (observeAccessibilityStats) {
            incrementMetric(session, 'observeAxAttempts', observeAccessibilityStats.axAttempts);
            incrementMetric(session, 'observeAxHits', observeAccessibilityStats.axHits);
            incrementMetric(session, 'observeFallbackUses', observeAccessibilityStats.fallbackUses);
          }
          const pageSignals = await collectPageSignals(page).catch(() => []);
          const pageState = classifyObservePageState(pageSignals);
          const persisted = persistObservedSurfacesForPage(session, pageRef, domTargets);
          observedScopes = persisted.observedScopes;
          const surfaceRefMap = persisted.surfaceRefMap;

          if (domTargets.length > 0) {
            const targets = replaceTargetsForPage(
              session,
              pageRef,
              domTargets.map((target) => toDomDescriptor(pageRef, target, surfaceRefMap))
            );
            reconcileObservedTargetsForPage(session, pageRef, targets);
            attachObservedTargetOwners(domTargets, targets);
            observedScopes = linkObservedSurfaceGraph(
              session,
              pageRef,
              domTargets,
              targets,
              observedScopes,
              surfaceRefMap
            );
            const fillableForms = shouldSuppressFillableFormsForObserve(pageState)
              ? clearProtectedFillableFormsForPage(session, pageRef)
              : await persistProtectedFillableFormsForPage(
                  session,
                  pageRef,
                  url,
                  targets,
                  new Date().toISOString()
                );

            await disconnectPlaywright(browser);
            browser = null;
            return buildObserveSuccessResult(session, observeStep, {
              success: true,
              observationMode: 'deterministic_dom',
              pageRef,
              resolvedBy: 'dom',
              ...domRuntimeResolution(),
              scopes: buildGroupedObserveScopes({
                pageRef,
                title,
                scopes: selectScopesForOutput(observedScopes, targets),
                targets,
              }),
              signals: compactSignals(pageSignals),
              fillableForms: compactFillableForms(fillableForms),
              metrics: session.runtime?.metrics,
              message:
                targets.length === 0 ? 'This observe pass returned zero targets.' : undefined,
              ...buildObservePageMetadata({
                url,
                title,
                protectedExposure,
              }),
            });
          }
          if (!allowAssistive) {
            await disconnectPlaywright(browser);
            browser = null;
            return buildObserveSuccessResult(session, observeStep, {
              success: true,
              observationMode: 'deterministic_dom',
              pageRef,
              resolvedBy: 'dom',
              ...domRuntimeResolution(),
              scopes: [],
              signals: compactSignals(pageSignals),
              fillableForms: [],
              metrics: session.runtime?.metrics,
              message: 'This observe pass returned zero targets.',
              ...buildObservePageMetadata({
                url,
                title,
                protectedExposure,
              }),
            });
          }
          stagehandFallbackReason = 'deterministic-observe-empty';
        } catch (err) {
          domPassError = err instanceof Error ? err.message : String(err);
          if (!allowAssistive) {
            return buildObserveContractFailureResult(session, {
              step: observeStep,
              error: 'observe_failed',
              outcomeType: 'blocked',
              message: 'Observe failed.',
              reason: domPassError,
              pageRef,
              runId: session.activeRunId,
              stepId: observeStep?.stepId,
            });
          }
          stagehandFallbackReason = 'deterministic-observe-failed';
        }
      }

      if (instruction) {
        try {
          if (!browser) {
            browser = await connectPlaywright(session.cdpUrl);
          }
          const resolvedPage = await resolveCurrentPageContext(browser, session);
          pageRef = resolvedPage.pageRef;
          const page = resolvedPage.page;
          const { url, title } = await syncSessionPage(session, pageRef, page);
          const protectedExposure = getProtectedExposure(session, pageRef);
          if (protectedExposure) {
            return buildObserveContractFailureResult(session, {
              step: observeStep,
              ...buildProtectedObserveBlockedResult(protectedExposure, 'goal-rerank'),
              pageRef,
              runId: session.activeRunId,
              stepId: observeStep?.stepId,
            });
          }
          bumpPageScopeEpoch(session, pageRef);
          setCurrentPage(session, pageRef);
          const collectedTargets = await collectDomTargets(page, {
            includeActivationAffordances: true,
          });
          let observeAccessibilityStats:
            | { axAttempts: number; axHits: number; fallbackUses: number }
            | undefined;
          const domTargets = compressSemanticallyDuplicateTargets(
            orderBySurfaceCompetition(
              annotateDomTargets(
                await enrichDomTargetsWithAccessibility(page, collectedTargets, {
                  onStats: (stats) => {
                    observeAccessibilityStats = stats;
                  },
                })
              )
            )
          );
          if (observeAccessibilityStats) {
            incrementMetric(session, 'observeAxAttempts', observeAccessibilityStats.axAttempts);
            incrementMetric(session, 'observeAxHits', observeAccessibilityStats.axHits);
            incrementMetric(session, 'observeFallbackUses', observeAccessibilityStats.fallbackUses);
          }
          const pageSignals = await collectPageSignals(page).catch(() => []);
          const pageState = classifyObservePageState(pageSignals);
          const surfaceInputs = collectSurfaceDescriptors(pageRef, domTargets);

          if (domTargets.length > 0) {
            const rerankedCandidates = await tracedStepOperation(
              () =>
                rerankDomTargetsForGoal(
                  instruction,
                  buildGoalObserveInventoryCandidates(domTargets, surfaceInputs),
                  { session }
                ),
              {
                spanName: 'agentbrowse.observe.rerank_goal_candidates',
                attributes: {
                  ...observePhaseAttributes,
                  'agentbrowse.observe.target_count': domTargets.length,
                },
              }
            );
            const { targets: goalMatchedTargets, selectedSurfaceIds } = selectTargetsForGoalMatches(
              domTargets,
              rerankedCandidates
            );
            const selectedTargets = prioritizeGoalActionTargets(
              instruction,
              expandWorkflowGraphTargets(domTargets, goalMatchedTargets, {
                selectedSurfaceIds,
              })
            );
            const persisted = persistObservedSurfacesForPage(session, pageRef, domTargets, {
              allSurfaceInputs: surfaceInputs,
              explicitSurfaceIds: selectedSurfaceIds,
            });
            observedScopes = persisted.observedScopes;
            const surfaceRefMap = persisted.surfaceRefMap;
            const targets = replaceTargetsForPage(
              session,
              pageRef,
              domTargets.map((target) => toDomDescriptor(pageRef, target, surfaceRefMap))
            );
            reconcileObservedTargetsForPage(session, pageRef, targets);
            attachObservedTargetOwners(domTargets, targets);
            observedScopes = linkObservedSurfaceGraph(
              session,
              pageRef,
              domTargets,
              targets,
              observedScopes,
              surfaceRefMap
            );
            const fillableForms = shouldSuppressFillableFormsForObserve(pageState)
              ? clearProtectedFillableFormsForPage(session, pageRef)
              : await persistProtectedFillableFormsForPage(
                  session,
                  pageRef,
                  url,
                  targets,
                  new Date().toISOString()
                );

            if (selectedTargets.length > 0 || selectedSurfaceIds.size > 0) {
              const projectedTargets = projectPersistedTargetsForGoal(
                domTargets,
                targets,
                selectedTargets
              );
              const explicitScopeRefs = buildGoalProjectionScopeRefs(
                projectedTargets,
                selectedSurfaceIds,
                surfaceRefMap
              );

              await disconnectPlaywright(browser);
              browser = null;
              return buildObserveSuccessResult(session, observeStep, {
                success: true,
                observationMode: canUseAssistiveLlm
                  ? 'goal_assistive_rerank'
                  : 'goal_heuristic_shortlist',
                pageRef,
                resolvedBy: 'dom-rerank',
                ...domRuntimeResolution(),
                scopes: buildGroupedObserveScopes({
                  pageRef,
                  title,
                  scopes: selectScopesForOutput(
                    observedScopes,
                    projectedTargets,
                    explicitScopeRefs
                  ),
                  targets: projectedTargets,
                }),
                signals: compactSignals(pageSignals),
                fillableForms: compactFillableForms(fillableForms),
                metrics: session.runtime?.metrics,
                url,
                title,
              });
            }

            await disconnectPlaywright(browser);
            browser = null;
            return buildObserveSuccessResult(session, observeStep, {
              success: true,
              observationMode: canUseAssistiveLlm
                ? 'goal_assistive_rerank'
                : 'goal_heuristic_shortlist',
              pageRef,
              resolvedBy: 'dom-rerank',
              ...domRuntimeResolution(),
              scopes: [],
              signals: compactSignals(pageSignals),
              fillableForms: compactFillableForms(fillableForms),
              metrics: session.runtime?.metrics,
              message: 'This goal-based observe pass returned zero matching targets.',
              url,
              title,
            });
          }
          stagehandFallbackReason = 'deterministic-observe-empty';
        } catch (err) {
          domPassError = err instanceof Error ? err.message : String(err);
          stagehandFallbackReason = 'deterministic-observe-failed';
        }
      }

      try {
        if (!browser) {
          browser = await connectPlaywright(session.cdpUrl);
        }
      } catch (err) {
        const domFailure =
          domPassError && domPassError.length > 0 ? `; dom observe failed: ${domPassError}` : '';
        return buildObserveContractFailureResult(session, {
          step: observeStep,
          error: 'browser_connection_failed',
          outcomeType: 'blocked',
          message: 'Observe could not start because AgentBrowse failed to connect to the browser.',
          reason: `${err instanceof Error ? err.message : String(err)}${domFailure}`,
          pageRef,
          runId: session.activeRunId,
          stepId: observeStep?.stepId,
        });
      }

      try {
        const resolvedPage = await resolveCurrentPageContext(browser!, session);
        pageRef = resolvedPage.pageRef;
        const page = resolvedPage.page;
        const { url, title } = await syncSessionPage(session, pageRef, page);
        const protectedExposure = getProtectedExposure(session, pageRef);
        if (protectedExposure) {
          return buildObserveContractFailureResult(session, {
            step: observeStep,
            ...buildProtectedObserveBlockedResult(protectedExposure, 'stagehand-fallback'),
            fallbackReason: stagehandFallbackReason ?? undefined,
            deterministicObserveError: domPassError ?? undefined,
            pageRef,
            runId: session.activeRunId,
            stepId: observeStep?.stepId,
          });
        }
        bumpPageScopeEpoch(session, pageRef);
        setCurrentPage(session, pageRef);
        const pageSignals = await collectPageSignals(page).catch(() => []);

        const actions = await withStagehand(session, async (stagehand) => {
          incrementMetric(session, 'stagehandCalls');
          return instruction
            ? ((await stagehand.observe(instruction, {
                page,
              })) as StagehandObserveAction[])
            : ((await stagehand.observe({ page })) as StagehandObserveAction[]);
        });

        const targets = replaceTargetsForPage(
          session,
          pageRef,
          await Promise.all(
            actions.map((action) =>
              toStagehandDescriptor(pageRef, action, page, normalizePageSignature(url))
            )
          )
        );
        const fillableForms = markProtectedFillableFormsUnknownForPage(session, pageRef);

        return buildObserveSuccessResult(session, observeStep, {
          success: true,
          observationMode: 'goal_assistive_stagehand',
          pageRef,
          resolvedBy: 'stagehand-observe',
          ...stagehandRuntimeResolution(stagehandFallbackReason ?? 'deterministic-observe-failed'),
          deterministicObserveError: domPassError ?? undefined,
          scopes: buildGroupedObserveScopes({
            pageRef,
            title,
            scopes: selectScopesForOutput(observedScopes, targets),
            targets,
          }),
          signals: compactSignals(pageSignals),
          fillableForms: compactFillableForms(fillableForms),
          metrics: session.runtime?.metrics,
          message: targets.length === 0 ? 'This observe pass returned zero targets.' : undefined,
          url,
          title,
        });
      } catch (err) {
        const stagehandError = err instanceof Error ? err.message : String(err);
        const details = domPassError
          ? `${stagehandError} (deterministic observe failed earlier: ${domPassError})`
          : stagehandError;
        return buildObserveContractFailureResult(session, {
          step: observeStep,
          error: 'observe_failed',
          outcomeType: 'blocked',
          message: 'Observe failed.',
          reason: details,
          pageRef,
          runId: session.activeRunId,
          stepId: observeStep?.stepId,
        });
      } finally {
        if (browser) {
          await disconnectPlaywright(browser);
        }
      }
    }
  );
}

/** CLI wrapper for `observeBrowser(...)` that persists the observed runtime state. */
export async function observe(session: BrowserCommandSession, instruction?: string): Promise<void> {
  const result = await observeBrowser(session, instruction);
  if (result.success) {
    saveSession(session);
  }
  if (result.success) {
    return outputJSON(result);
  }

  const { success: _success, ...failure } = result as ObserveFailureResult;
  return outputContractFailure(failure);
}
