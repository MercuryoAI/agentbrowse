/**
 * browse act <targetRef> <action> [value] — Perform a deterministic action on a stored target.
 */

import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import type { BrowserCommandSession } from '../browser-session-state.js';
import { saveSession } from '../session.js';
import {
  getSurface,
  getTarget,
  markTargetLifecycle,
  setTargetAvailability,
  updateTarget,
} from '../runtime-state.js';
import { incrementMetric, recordActionResult } from '../runtime-metrics.js';
import { bumpPageScopeEpoch, registerPage, setCurrentPage } from '../runtime-page-state.js';
import { clearProtectedExposure, getProtectedExposure } from '../runtime-protected-state.js';
import {
  outputContractFailure,
  outputFailure,
  outputJSON,
  type BrowseContractFailure,
  type BrowseResult,
} from '../output.js';
import {
  captureDiagnosticSnapshotBestEffort,
  finishDiagnosticStepBestEffort,
  recordDiagnosticArtifactManifestBestEffort,
  recordCommandLifecycleEventBestEffort,
  startDiagnosticStep,
  type DiagnosticArtifactManifest,
} from '../diagnostics.js';
import {
  capturePageObservation,
  captureLocatorContextHash,
  captureLocatorState,
  createAcceptanceProbe,
  diagnoseNoObservableProgress,
  genericClickObservationChanged,
  locatorStateChanged,
  pageObservationChanged,
  shouldVerifyObservableProgress,
  waitForAcceptanceProbe,
  type AcceptanceProbe,
  type NoObservableProgressObservations,
} from './action-acceptance.js';
import { captureActionFailureArtifacts, startActionTrace } from './action-artifacts.js';
import type { LocatorRoot } from './action-fallbacks.js';
import { clickActivationStrategyForTarget } from './click-activation-policy.js';
import { resolveSubmitResult } from './action-result-resolution.js';
import { projectActionValue } from './action-value-projection.js';
import { applyActionWithFallbacks } from './action-executor.js';
import { BROWSE_ACTIONS, type BrowseAction, isBrowseAction } from './browse-actions.js';
import {
  isCompatibleMutableFieldBinding,
  normalizePageSignature,
  readLocatorBindingSnapshot,
  readLocatorDomSignature,
} from './descriptor-validation.js';
import {
  assertStoredBindingStillValid,
  resolvePreparedLocatorCandidates,
  resolveInteractionRoots,
  targetUsesSurfaceAsPrimaryLocator,
} from './interaction-kernel.js';
import { isLocatorUserActionable } from './user-actionable.js';
import { resolveSurfaceScopeRoot } from './target-resolution.js';
import { buildProtectedArtifactsSuppressed } from '../secrets/protected-artifact-guard.js';
import { scrubProtectedExactValues } from '../secrets/protected-exact-value-redaction.js';
import {
  connectPlaywright,
  disconnectPlaywright,
  listPages,
  resolvePageByRef,
  syncSessionPage,
} from '../playwright-runtime.js';
import type { TargetDescriptor } from '../runtime-state.js';
import { withApiTraceContext } from '../command-api-tracing.js';

function ensureValue(action: BrowseAction, value: string | undefined): string | undefined {
  if (action === 'click') return undefined;
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`Act value is required for action: ${action}`);
}

const MUTABLE_FIELD_REBIND_RETRY_DELAYS_MS = [0, 25, 50, 100] as const;
const PARTIAL_SELECTION_PROGRESS_MESSAGE =
  'Text was entered and the related choice list remained open.';
const NO_OBSERVABLE_PROGRESS_MESSAGE = 'The action ran, but no visible page change was detected.';
const NO_OBSERVABLE_PROGRESS_REASON =
  'No visible page or control state change was detected within the wait window.';
const VALIDATION_BLOCKED_MESSAGE =
  'The action surfaced validation errors that must be fixed before continuing.';
const VALIDATION_BLOCKED_REASON =
  'The submit action was processed, but the page surfaced validation errors that block progress.';

/** Stable top-level error codes returned by `act(...)`. */
export const ACT_ERROR_CODES = [
  'act_failed',
  'action_not_allowed_for_target',
  'browser_connection_failed',
  'no_observable_progress',
  'stale_target',
  'stale_target_ref',
  'target_disabled',
  'target_gated',
  'target_not_actionable',
  'target_readonly',
  'target_surface_inactive',
  'target_surface_not_live',
  'target_surface_unavailable',
  'unknown_target_ref',
  'validation_blocked',
] as const;

/** Stable outcome categories emitted by `act(...)`. */
export const ACT_OUTCOME_TYPES = [
  'action_completed',
  'binding_stale',
  'blocked',
  'partial_progress',
  'unsupported',
] as const;

export type ActErrorCode = (typeof ACT_ERROR_CODES)[number];
export type ActOutcomeType = (typeof ACT_OUTCOME_TYPES)[number];

/** Successful deterministic action result. */
export type ActSuccessResult = BrowseResult & {
  success: true;
  targetRef: string;
  action: BrowseAction;
};

/** Contract-time failure raised before a browser action is attempted. */
export type ActPreflightFailureResult = BrowseContractFailure & {
  success: false;
  failureSurface: 'contract';
  error: ActErrorCode;
  outcomeType: Extract<ActOutcomeType, 'binding_stale' | 'blocked' | 'unsupported'>;
  targetRef: string;
  action: BrowseAction;
};

/** Runtime failure raised after AgentBrowse attempted the browser action. */
export type ActExecutionFailureResult = BrowseResult & {
  success: false;
  failureSurface: 'output';
  error: ActErrorCode;
  outcomeType: Extract<ActOutcomeType, 'binding_stale' | 'blocked'>;
  targetRef: string;
  action: BrowseAction;
};

export type ActFailureResult = ActPreflightFailureResult | ActExecutionFailureResult;

export type ActResult = ActSuccessResult | ActFailureResult;

async function readExpandedState(locator: Locator | null): Promise<boolean | null> {
  if (!locator) {
    return null;
  }

  const state = await captureLocatorState(locator, ['expanded']).catch(() => null);
  return typeof state?.expanded === 'boolean' ? state.expanded : null;
}

async function partialProgressForAliasedSelection(args: {
  requestedAction: BrowseAction;
  probe: AcceptanceProbe | null;
}): Promise<{ outcomeType: 'partial_progress'; message: string } | null> {
  const { requestedAction, probe } = args;
  if ((requestedAction !== 'fill' && requestedAction !== 'type') || probe?.policy !== 'selection') {
    return null;
  }

  const readExpanded = await readExpandedState(probe.readLocator);
  if (readExpanded === true) {
    return {
      outcomeType: 'partial_progress',
      message: PARTIAL_SELECTION_PROGRESS_MESSAGE,
    };
  }

  const fallbackExpanded =
    probe.readLocator === probe.locator ? readExpanded : await readExpandedState(probe.locator);
  if (fallbackExpanded === true) {
    return {
      outcomeType: 'partial_progress',
      message: PARTIAL_SELECTION_PROGRESS_MESSAGE,
    };
  }

  return null;
}

async function buildActPreflightFailureResult(params: {
  session: BrowserCommandSession;
  step: ReturnType<typeof startDiagnosticStep>;
  error: ActErrorCode;
  outcomeType: Extract<ActOutcomeType, 'binding_stale' | 'blocked' | 'unsupported'>;
  message: string;
  reason: string;
  targetRef: string;
  action: BrowseAction;
}): Promise<ActPreflightFailureResult> {
  await finishDiagnosticStepBestEffort({
    step: params.step,
    success: false,
    outcomeType: params.outcomeType,
    message: params.message,
    reason: params.reason,
  });
  captureDiagnosticSnapshotBestEffort({
    session: params.session,
    step: params.step,
    phase: 'point-in-time',
    pageRef: params.session.runtime?.currentPageRef,
  });
  recordCommandLifecycleEventBestEffort({
    step: params.step,
    phase: 'failed',
    attributes: {
      outcomeType: params.outcomeType,
      targetRef: params.targetRef,
      reason: params.reason,
    },
  });
  return {
    success: false,
    failureSurface: 'contract',
    error: params.error,
    outcomeType: params.outcomeType,
    message: params.message,
    reason: params.reason,
    targetRef: params.targetRef,
    action: params.action,
  };
}

function describeActFailure(params: {
  failureMessage: string;
  staleReason:
    | 'page-signature-mismatch'
    | 'dom-signature-mismatch'
    | 'locator-resolution-failed'
    | null;
}): {
  error: ActErrorCode;
  outcomeType: Extract<ActOutcomeType, 'binding_stale' | 'blocked'>;
  message: string;
  reason: string;
} {
  if (params.staleReason) {
    const reason =
      params.staleReason === 'page-signature-mismatch'
        ? 'The page changed after the target was observed.'
        : params.staleReason === 'dom-signature-mismatch'
          ? 'The element changed after the target was observed.'
          : 'The saved target no longer points to a live element on the page.';
    return {
      error: 'stale_target',
      outcomeType: 'binding_stale',
      message: 'The saved target is outdated.',
      reason,
    };
  }

  if (params.failureMessage === 'Act failed: no_observable_progress') {
    return {
      error: 'no_observable_progress',
      outcomeType: 'blocked',
      message: NO_OBSERVABLE_PROGRESS_MESSAGE,
      reason: NO_OBSERVABLE_PROGRESS_REASON,
    };
  }
  if (params.failureMessage === 'Act failed: validation_blocked') {
    return {
      error: 'validation_blocked',
      outcomeType: 'blocked',
      message: VALIDATION_BLOCKED_MESSAGE,
      reason: VALIDATION_BLOCKED_REASON,
    };
  }

  const rawReason = params.failureMessage.replace(/^Act failed:\s*/, '');
  if (rawReason === 'target_disabled') {
    return {
      error: 'target_disabled',
      outcomeType: 'blocked',
      message: 'The requested action cannot continue because the target is disabled.',
      reason: 'The runtime resolved the target, but the browser marked it as disabled.',
    };
  }
  if (rawReason === 'target_readonly') {
    return {
      error: 'target_readonly',
      outcomeType: 'blocked',
      message: 'The requested action cannot continue because the target is read-only.',
      reason: 'The runtime resolved the target, but the browser marked it as read-only.',
    };
  }
  if (rawReason === 'target_surface_inactive') {
    return {
      error: 'target_surface_inactive',
      outcomeType: 'blocked',
      message: 'The requested action cannot continue because the target surface is inactive.',
      reason: 'The target belongs to a surface that is no longer active or available.',
    };
  }

  return {
    error: 'act_failed',
    outcomeType: 'blocked',
    message: 'The requested action could not be completed.',
    reason: rawReason,
  };
}

export { BROWSE_ACTIONS, isBrowseAction };
export type { BrowseAction };

function hasMeaningfulNoObservableProgressObservations(
  observations: NoObservableProgressObservations | null
): observations is NoObservableProgressObservations {
  return Boolean(
    observations &&
      (observations.visibleMessages.length > 0 ||
        observations.invalidFields.length > 0 ||
        observations.targetState)
  );
}

function hasValidationBlockedObservations(
  observations: NoObservableProgressObservations | null
): observations is NoObservableProgressObservations {
  return Boolean(observations && observations.invalidFields.length > 0);
}

function sanitizePublicAttempts(attempts: readonly string[]): string[] {
  return attempts.filter(
    (attempt) =>
      !attempt.startsWith('stale.') &&
      !attempt.startsWith('no-progress.diagnosis:') &&
      attempt !== 'outcome.partial-progress:selection-not-complete'
  );
}

function buildActArtifactManifest(params: {
  stepId: string;
  artifacts:
    | Awaited<ReturnType<typeof captureActionFailureArtifacts>>
    | ReturnType<typeof buildProtectedArtifactsSuppressed>;
}): DiagnosticArtifactManifest {
  if ('suppressed' in params.artifacts) {
    return {
      artifactManifestId: `${params.stepId}-artifacts`,
      stepId: params.stepId,
      screenshots: [],
      htmlSnapshots: [],
      traces: [],
      logs: [],
      suppressed: [
        { kind: 'screenshot' as const, reason: 'protected_exposure_active' as const },
        { kind: 'html' as const, reason: 'protected_exposure_active' as const },
        { kind: 'trace' as const, reason: 'protected_exposure_active' as const },
        { kind: 'log' as const, reason: 'protected_exposure_active' as const },
      ],
    };
  }

  return {
    artifactManifestId: `${params.stepId}-artifacts`,
    stepId: params.stepId,
    screenshots: params.artifacts.screenshotPath
      ? [{ path: params.artifacts.screenshotPath, purpose: 'failure_screenshot' }]
      : [],
    htmlSnapshots: params.artifacts.htmlPath
      ? [{ path: params.artifacts.htmlPath, purpose: 'failure_html_snapshot' }]
      : [],
    traces: params.artifacts.tracePath
      ? [{ path: params.artifacts.tracePath, purpose: 'failure_trace' }]
      : [],
    logs: [{ path: params.artifacts.actionLogPath, purpose: 'failure_action_log' }],
    suppressed: [],
  };
}

async function persistActArtifactManifestBestEffort(
  runId: string | undefined,
  step: ReturnType<typeof startDiagnosticStep>,
  stepId: string | undefined,
  artifacts:
    | Awaited<ReturnType<typeof captureActionFailureArtifacts>>
    | ReturnType<typeof buildProtectedArtifactsSuppressed>
    | null
): Promise<string | undefined> {
  if (!runId || !stepId || !artifacts) {
    return undefined;
  }

  try {
    const manifest = buildActArtifactManifest({
      stepId,
      artifacts,
    });
    return await recordDiagnosticArtifactManifestBestEffort({
      runId,
      step,
      manifest,
    });
  } catch {
    return undefined;
  }
}

function buildActSnapshotArtifactRefs(
  artifacts:
    | Awaited<ReturnType<typeof captureActionFailureArtifacts>>
    | ReturnType<typeof buildProtectedArtifactsSuppressed>
    | null
) {
  if (!artifacts || 'suppressed' in artifacts) {
    return undefined;
  }

  return {
    ...(artifacts.screenshotPath ? { screenshotPath: artifacts.screenshotPath } : {}),
    ...(artifacts.htmlPath ? { htmlPath: artifacts.htmlPath } : {}),
    ...(artifacts.tracePath ? { tracePath: artifacts.tracePath } : {}),
    ...(artifacts.actionLogPath ? { logPath: artifacts.actionLogPath } : {}),
  };
}

function finalizeActStepBestEffort(
  step: ReturnType<typeof startDiagnosticStep>,
  options: {
    success: boolean;
    outcomeType?: string;
    message?: string;
    reason?: string;
    artifactManifestId?: string;
  }
): Promise<void> {
  return finishDiagnosticStepBestEffort({
    step,
    success: options.success,
    outcomeType: options.outcomeType,
    message: options.message,
    reason: options.reason,
    artifactManifestId: options.artifactManifestId,
  });
}

function isEditableLikeTarget(target: TargetDescriptor): boolean {
  if (
    target.controlFamily === 'text-input' ||
    target.controlFamily === 'select' ||
    target.controlFamily === 'datepicker'
  ) {
    return true;
  }

  const kind = (target.kind ?? '').toLowerCase();
  const role = (target.semantics?.role ?? '').toLowerCase();
  return (
    ['input', 'textarea', 'select', 'combobox'].includes(kind) ||
    ['textbox', 'combobox', 'searchbox', 'spinbutton'].includes(role) ||
    target.allowedActions.includes('fill') ||
    target.allowedActions.includes('type') ||
    target.allowedActions.includes('select')
  );
}

function shouldWatchForNewPageAfterAction(target: TargetDescriptor, action: BrowseAction): boolean {
  if (action === 'click') {
    return true;
  }

  if (action !== 'press') {
    return false;
  }

  return !isEditableLikeTarget(target);
}

function shouldDeferSurfaceResolutionForEditablePress(
  target: TargetDescriptor,
  action: BrowseAction
): boolean {
  return (
    action === 'press' &&
    isEditableLikeTarget(target) &&
    !target.locatorCandidates.some((candidate) => candidate.scope === 'surface')
  );
}

async function recoverLocatorFromSurfaceRoot(
  locatorRoot: LocatorRoot,
  target: TargetDescriptor,
  action: BrowseAction,
  attempts: string[]
): Promise<Locator | null> {
  if (
    action !== 'press' ||
    !(
      target.controlFamily === 'text-input' ||
      target.controlFamily === 'select' ||
      target.controlFamily === 'datepicker'
    ) ||
    typeof (locatorRoot as Locator).locator !== 'function'
  ) {
    return null;
  }

  const descendants = locatorRoot.locator(
    'input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]'
  );
  const count = await descendants.count().catch(() => 0);
  const visibleDescendants: Locator[] = [];

  for (let index = 0; index < count; index += 1) {
    const descendant = descendants.nth(index);
    const visible = await isLocatorUserActionable(descendant);
    if (!visible) {
      continue;
    }

    visibleDescendants.push(descendant);
  }

  if (visibleDescendants.length === 1) {
    attempts.push('resolve.surface-descendant:press');
    return visibleDescendants[0] ?? null;
  }

  if (visibleDescendants.length > 1) {
    attempts.push(`resolve.skip:surface-descendant-ambiguous:${visibleDescendants.length}`);
  }

  return null;
}

async function capturePopupIfOpened(
  session: BrowserCommandSession,
  beforePages: ReadonlyArray<Page>,
  afterPages: ReadonlyArray<Page>,
  currentPageRef: string,
  attempts: string[]
) {
  const popup = afterPages.find((page) => !beforePages.includes(page));
  if (!popup) return null;

  const page = registerPage(session, {
    openerPageRef: currentPageRef,
    makeCurrent: false,
  });
  attempts.push('popup-captured');
  return {
    page,
    popup,
  };
}

async function waitForPopup(context: BrowserContext): Promise<Page | null> {
  try {
    return await context.waitForEvent('page', { timeout: 500 });
  } catch {
    return null;
  }
}

async function waitForLatePage(
  browser: Browser,
  beforePages: ReadonlyArray<Page>,
  timeoutMs = 2_000
): Promise<Page | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const candidate = listPages(browser).find((page) => !beforePages.includes(page));
    if (candidate) {
      return candidate;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return null;
}

export async function actBrowser(
  session: BrowserCommandSession,
  targetRef: string,
  action: BrowseAction,
  value?: string
): Promise<ActResult> {
  const requestedAction = action;
  const runId = session.activeRunId;
  const actStep = startDiagnosticStep(
    {
      runId,
      command: 'act',
      input: {
        targetRef,
        action: requestedAction,
        valueSupplied: typeof value === 'string' && value.length > 0,
      },
      refs: {
        targetRef,
      },
    },
    { session }
  );
  captureDiagnosticSnapshotBestEffort({
    session,
    step: actStep,
    phase: 'before',
    pageRef: session.runtime?.currentPageRef,
  });
  recordCommandLifecycleEventBestEffort({
    step: actStep,
    phase: 'started',
    attributes: {
      targetRef,
      action: requestedAction,
      valueSupplied: typeof value === 'string' && value.length > 0,
    },
  });
  return withApiTraceContext(
    {
      runId,
      stepId: actStep?.stepId,
      command: 'act',
    },
    async () => {
      const target = getTarget(session, targetRef);
      if (!target) {
        return buildActPreflightFailureResult({
          session,
          step: actStep,
          error: 'unknown_target_ref',
          outcomeType: 'blocked',
          message: 'The requested targetRef is unknown.',
          reason: `No stored target matches targetRef ${targetRef}.`,
          targetRef,
          action,
        });
      }
      if (target.lifecycle !== 'live') {
        return buildActPreflightFailureResult({
          session,
          step: actStep,
          error: 'stale_target_ref',
          outcomeType: 'binding_stale',
          message: 'The requested target is no longer live.',
          reason: `Target ${targetRef} is ${target.lifecycle}${target.lifecycleReason ? ` because ${target.lifecycleReason}` : ''}.`,
          targetRef,
          action,
        });
      }
      if (target.capability !== 'actionable') {
        return buildActPreflightFailureResult({
          session,
          step: actStep,
          error: 'target_not_actionable',
          outcomeType: 'unsupported',
          message: 'The requested target cannot be used for actions.',
          reason: `Target ${targetRef} has capability ${target.capability}, not actionable.`,
          targetRef,
          action: requestedAction,
        });
      }
      if (!target.allowedActions.includes(action)) {
        const canAliasFillLikeToSelect =
          (requestedAction === 'fill' || requestedAction === 'type') &&
          target.controlFamily === 'select' &&
          target.allowedActions.includes('select') &&
          typeof value === 'string' &&
          value.length > 0;
        if (canAliasFillLikeToSelect) {
          action = 'select';
        } else {
          return buildActPreflightFailureResult({
            session,
            step: actStep,
            error: 'action_not_allowed_for_target',
            outcomeType: 'unsupported',
            message: 'The requested action is not allowed for this target.',
            reason: `Target ${targetRef} allows ${target.allowedActions.join(', ')}, not ${requestedAction}.`,
            targetRef,
            action: requestedAction,
          });
        }
      }
      if (
        target.availability.state === 'gated' &&
        (target.availability.reason === 'occupied' ||
          target.availability.reason === 'not-selectable')
      ) {
        return buildActPreflightFailureResult({
          session,
          step: actStep,
          error: 'target_gated',
          outcomeType: 'blocked',
          message: 'The requested target is currently gated.',
          reason: `Target ${targetRef} is gated${target.availability.reason ? ` because ${target.availability.reason}` : ''}.`,
          targetRef,
          action: requestedAction,
        });
      }
      const surface = target.surfaceRef ? getSurface(session, target.surfaceRef) : null;
      if (surface && surface.lifecycle !== 'live') {
        setTargetAvailability(
          session,
          targetRef,
          'surface-inactive',
          surface.lifecycleReason ?? `surface-${surface.lifecycle}`
        );
        return buildActPreflightFailureResult({
          session,
          step: actStep,
          error: 'target_surface_not_live',
          outcomeType: 'blocked',
          message: 'The requested target surface is no longer live.',
          reason: `Surface ${surface.ref} is ${surface.lifecycle}${surface.lifecycleReason ? ` because ${surface.lifecycleReason}` : ''}.`,
          targetRef,
          action: requestedAction,
        });
      }
      if (surface && surface.availability.state !== 'available') {
        setTargetAvailability(
          session,
          targetRef,
          'surface-inactive',
          surface.availability.reason ?? `surface-${surface.availability.state}`
        );
        return buildActPreflightFailureResult({
          session,
          step: actStep,
          error: 'target_surface_unavailable',
          outcomeType: 'blocked',
          message: 'The requested target surface is not currently available.',
          reason: `Surface ${surface.ref} is ${surface.availability.state}${surface.availability.reason ? ` because ${surface.availability.reason}` : ''}.`,
          targetRef,
          action: requestedAction,
        });
      }

      const actionValue = ensureValue(action, value);
      const attempts: string[] = [];
      if (action !== requestedAction) {
        attempts.push(`action.alias:${requestedAction}->${action}`);
      }
      const startedAt = Date.now();
      let browser: Browser | null = null;
      let failureMessage: string | null = null;
      let failureArtifacts:
        | Awaited<ReturnType<typeof captureActionFailureArtifacts>>
        | ReturnType<typeof buildProtectedArtifactsSuppressed>
        | undefined;
      let currentPage: Page | null = null;
      let currentPageRef = target.pageRef;
      const startingPageUrl = session.runtime?.pages?.[target.pageRef]?.url ?? null;
      const protectedExposureAtStart = getProtectedExposure(session, target.pageRef);
      let locatorStrategy: string | null = null;
      let recoveredAfterError = false;
      let recoveredAcceptancePolicy: AcceptanceProbe['policy'] | null = null;
      let recoveredProgressProbe: AcceptanceProbe | null = null;
      let staleReason:
        | 'page-signature-mismatch'
        | 'dom-signature-mismatch'
        | 'locator-resolution-failed'
        | null = null;
      let progressProbe: AcceptanceProbe | null = null;
      let noProgressObservations: NoObservableProgressObservations | null = null;
      let partialProgressResult: { outcomeType: 'partial_progress'; message: string } | null = null;
      let liveTarget = target;
      let trace = {
        finishSuccess: async () => {},
        finishFailure: async (_artifactDir: string) => undefined as string | undefined,
      };

      try {
        browser = await connectPlaywright(session.cdpUrl);
      } catch (err) {
        return buildActPreflightFailureResult({
          session,
          step: actStep,
          error: 'browser_connection_failed',
          outcomeType: 'blocked',
          message:
            'The action could not start because AgentBrowse failed to connect to the browser.',
          reason: err instanceof Error ? err.message : String(err),
          targetRef,
          action,
        });
      }

      try {
        const page = await resolvePageByRef(browser, session, target.pageRef);
        currentPage = page;
        setCurrentPage(session, target.pageRef);
        const { url } = await syncSessionPage(session, target.pageRef, page);
        trace = await startActionTrace(page, {
          suppressSensitiveArtifacts: Boolean(protectedExposureAtStart),
        });

        if (liveTarget.pageSignature && normalizePageSignature(url) !== liveTarget.pageSignature) {
          staleReason = 'page-signature-mismatch';
          throw new Error('stale_target_page_signature_changed');
        }

        const tryRebindMutableFieldTarget = async (
          resolvedLocator: Locator,
          strategy: string
        ): Promise<boolean> => {
          if (!liveTarget.domSignature) {
            return false;
          }

          for (
            let attemptIndex = 0;
            attemptIndex < MUTABLE_FIELD_REBIND_RETRY_DELAYS_MS.length;
            attemptIndex += 1
          ) {
            const delayMs = MUTABLE_FIELD_REBIND_RETRY_DELAYS_MS[attemptIndex] ?? 0;
            if (attemptIndex > 0) {
              attempts.push(`domSignature.rebind.retry:${strategy}:${attemptIndex + 1}`);
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }

            const snapshot = await readLocatorBindingSnapshot(resolvedLocator).catch(() => null);
            if (!snapshot?.domSignature) {
              continue;
            }
            if (snapshot.domSignature === liveTarget.domSignature) {
              return false;
            }
            if (!isCompatibleMutableFieldBinding(liveTarget, snapshot)) {
              continue;
            }

            attempts.push(`domSignature.rebound:${strategy}`);
            const updatedTarget = updateTarget(session, targetRef, {
              domSignature: snapshot.domSignature,
              label: snapshot.label ?? liveTarget.label,
              lifecycle: 'live',
              lifecycleReason: undefined,
              availability: { state: 'available' },
              semantics: {
                ...liveTarget.semantics,
                name: snapshot.label ?? liveTarget.semantics?.name,
                role: snapshot.role ?? liveTarget.semantics?.role,
              },
            });
            if (updatedTarget) {
              liveTarget = updatedTarget;
            }
            return true;
          }

          return false;
        };

        const assertResolvedTargetStillValid = async (
          resolvedLocator: Locator,
          stage: string
        ): Promise<void> => {
          await assertStoredBindingStillValid(page, resolvedLocator, liveTarget, stage, {
            onReason: async (reason, staleStage) => {
              switch (reason) {
                case 'page_signature_mismatch':
                  attempts.push(`stale.page-signature:${staleStage}`);
                  staleReason = 'page-signature-mismatch';
                  return false;
                case 'locator_resolution_failed':
                  attempts.push(`stale.locator:${staleStage}`);
                  staleReason = 'locator-resolution-failed';
                  return false;
                case 'dom_signature_mismatch': {
                  const rebound = await tryRebindMutableFieldTarget(resolvedLocator, staleStage);
                  if (rebound) {
                    return true;
                  }
                  attempts.push(`stale.dom-signature:${staleStage}`);
                  staleReason = 'dom-signature-mismatch';
                  return false;
                }
              }
            },
            errorForReason: (reason) => {
              switch (reason) {
                case 'page_signature_mismatch':
                  return 'stale_target_page_signature_changed';
                case 'locator_resolution_failed':
                  return 'stale_target_locator_resolution_failed';
                case 'dom_signature_mismatch':
                  return 'stale_target_dom_signature_changed';
              }
            },
          });
        };

        let resolvedBy: string | null = null;
        const beforePages = listPages(browser);
        const shouldCheckProgress = shouldVerifyObservableProgress(target, action);
        const beforePageObservation = shouldCheckProgress
          ? await capturePageObservation(page)
          : null;
        const deferSurfaceResolution = shouldDeferSurfaceResolutionForEditablePress(target, action);
        let baseRoot: LocatorRoot = page;
        let locatorRoot: LocatorRoot = baseRoot;
        let surfaceRoot: Locator | null = null;
        if (!deferSurfaceResolution) {
          ({ baseRoot, locatorRoot, surfaceRoot } = await resolveInteractionRoots(
            page,
            target,
            surface,
            attempts,
            {
              recordSelfTargetReuse: true,
            }
          ));
        }
        let lastError: Error | null = null;
        let sawDomSignatureMismatch = false;
        let sawDisabledTarget = false;
        let sawReadonlyTarget = false;
        const attemptResolvedLocator = async (
          resolvedLocator: Locator,
          strategy: string,
          options?: {
            skipDomSignature?: boolean;
          }
        ): Promise<boolean> => {
          if (!options?.skipDomSignature && liveTarget.domSignature) {
            const rebound = await tryRebindMutableFieldTarget(resolvedLocator, strategy);
            if (!rebound) {
              const liveSignature = await readLocatorDomSignature(resolvedLocator);
              if (liveSignature && liveSignature !== liveTarget.domSignature) {
                attempts.push(`domSignature.mismatch:${strategy}`);
                sawDomSignatureMismatch = true;
                return false;
              }
            }
          }

          let acceptanceProbe: AcceptanceProbe | null = null;
          const tryRecoverActionErrorAcceptance = async (): Promise<boolean> => {
            if (!acceptanceProbe) {
              return false;
            }

            const acceptance = await waitForAcceptanceProbe(acceptanceProbe).catch(() => null);
            if (acceptance?.polls && acceptance.polls > 1) {
              attempts.push(`acceptance.polled:${acceptance.polls}`);
            }
            if (!acceptance?.accepted) {
              return false;
            }

            if (acceptanceProbe.policy === 'submit') {
              const submitResolution = await resolveSubmitResult(
                acceptanceProbe,
                acceptance.afterPageObservation
              );
              if (!submitResolution.acceptAsProgress) {
                return false;
              }
              attempts.push(`submit-resolution:${submitResolution.finalVerdict}`);
              if (submitResolution.claims.some((claim) => claim.kind === 'soft_result_candidate')) {
                attempts.push('submit-resolution:soft-result-candidate');
              }
            }

            attempts.push(`acceptance.recovered:${acceptanceProbe.policy}`);
            incrementMetric(session, 'fallbackActions');
            resolvedBy = 'playwright-locator';
            locatorStrategy = strategy;
            recoveredProgressProbe = acceptanceProbe;
            progressProbe = null;
            lastError = null;
            recoveredAfterError = true;
            recoveredAcceptancePolicy = acceptanceProbe.policy;
            setTargetAvailability(session, targetRef, 'available');
            return true;
          };
          try {
            const valueProjection = await projectActionValue({
              target,
              action,
              actionValue,
              locator: resolvedLocator,
              attempts,
            });
            const executionValue = valueProjection?.executionValue ?? actionValue;
            const acceptanceValue = valueProjection?.acceptanceValue ?? actionValue;
            acceptanceProbe = await createAcceptanceProbe({
              session,
              page,
              target,
              action,
              actionValue: acceptanceValue,
              locator: resolvedLocator,
              beforePageObservation,
            });
            attempts.push(`resolve:${strategy}`);
            const usedFallback = await applyActionWithFallbacks(
              page,
              locatorRoot,
              resolvedLocator,
              action,
              executionValue,
              attempts,
              target.controlFamily,
              {
                clickActivationStrategy: clickActivationStrategyForTarget(target, action),
                guards: {
                  assertStillValid: async (stage: string) => {
                    await assertResolvedTargetStillValid(resolvedLocator, stage);
                  },
                },
              }
            );
            if (usedFallback) {
              incrementMetric(session, 'fallbackActions');
            }
            resolvedBy = 'playwright-locator';
            locatorStrategy = strategy;
            progressProbe = acceptanceProbe;
            setTargetAvailability(session, targetRef, 'available');
            return true;
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            const shouldAttemptAcceptanceRecovery =
              acceptanceProbe !== null &&
              (acceptanceProbe.policy === 'value-change' ||
                acceptanceProbe.policy === 'selection' ||
                acceptanceProbe.policy === 'date-selection' ||
                acceptanceProbe.policy === 'navigation' ||
                acceptanceProbe.policy === 'submit');
            if (shouldAttemptAcceptanceRecovery && (await tryRecoverActionErrorAcceptance())) {
              return true;
            }
            if (staleReason) {
              throw lastError;
            }

            try {
              await assertResolvedTargetStillValid(resolvedLocator, `after-error:${strategy}`);
            } catch (validationError) {
              if (
                (acceptanceProbe?.policy === 'navigation' ||
                  acceptanceProbe?.policy === 'submit') &&
                validationError instanceof Error &&
                validationError.message === 'stale_target_page_signature_changed' &&
                (await tryRecoverActionErrorAcceptance())
              ) {
                return true;
              }
              throw validationError;
            }
            return false;
          }
        };
        const watchForNewPage = shouldWatchForNewPageAfterAction(target, action);
        const popupPromise = watchForNewPage
          ? waitForPopup(page.context())
          : Promise.resolve<Page | null>(null);

        const tryRankedCandidates = async (): Promise<void> => {
          const resolution = await resolvePreparedLocatorCandidates({
            target,
            action,
            baseRoot,
            locatorRoot,
            surfaceRoot,
            attempts,
            prepareOptions: {
              allowReadonlyFallback: action === 'fill' && target.controlFamily === 'datepicker',
              allowDescendantPressFallback:
                action === 'press' &&
                (target.controlFamily === 'text-input' ||
                  target.controlFamily === 'select' ||
                  target.controlFamily === 'datepicker'),
              isUserActionable: isLocatorUserActionable,
            },
            onPreparedLocator: async (resolvedLocator, strategy) =>
              attemptResolvedLocator(resolvedLocator, strategy),
          });
          if (resolution.sawDisabledTarget) {
            sawDisabledTarget = true;
          }
          if (resolution.sawReadonlyTarget) {
            sawReadonlyTarget = true;
          }
        };

        await tryRankedCandidates();

        if (!resolvedBy && !lastError && deferSurfaceResolution && surface) {
          const deferredSurfaceRoot = await resolveSurfaceScopeRoot(page, surface, attempts);
          if (deferredSurfaceRoot) {
            surfaceRoot = deferredSurfaceRoot;
            locatorRoot = targetUsesSurfaceAsPrimaryLocator(target, surface)
              ? baseRoot
              : surfaceRoot;
            await tryRankedCandidates();
          }
        }

        if (!resolvedBy && !lastError && surfaceRoot) {
          const recoveredLocator = await recoverLocatorFromSurfaceRoot(
            surfaceRoot,
            target,
            action,
            attempts
          );
          if (recoveredLocator) {
            await attemptResolvedLocator(recoveredLocator, 'surface-descendant', {
              skipDomSignature: true,
            });
          }
        }

        if (!resolvedBy) {
          if (sawDomSignatureMismatch) {
            staleReason = 'dom-signature-mismatch';
            throw new Error('stale_target_dom_signature_changed');
          }
          if (sawDisabledTarget) {
            setTargetAvailability(session, targetRef, 'gated', 'disabled');
            throw new Error('target_disabled');
          }
          if (sawReadonlyTarget && (action === 'fill' || action === 'type')) {
            setTargetAvailability(session, targetRef, 'gated', 'readonly');
            throw new Error('target_readonly');
          }
          if (
            !lastError &&
            target.surfaceRef &&
            (target.acceptancePolicy === 'selection' ||
              target.acceptancePolicy === 'date-selection')
          ) {
            setTargetAvailability(session, targetRef, 'surface-inactive', 'surface-not-active');
            throw new Error('target_surface_inactive');
          }

          if (!resolvedBy) {
            if (
              !lastError &&
              (target.controlFamily === 'text-input' ||
                target.controlFamily === 'select' ||
                target.controlFamily === 'datepicker')
            ) {
              staleReason = 'locator-resolution-failed';
              throw new Error('stale_target_locator_resolution_failed');
            }
            if (lastError) {
              throw lastError;
            }
            throw new Error('deterministic_target_resolution_failed');
          }
        }

        const popup = await popupPromise;
        const latePage =
          !popup && watchForNewPage ? await waitForLatePage(browser, beforePages) : null;
        if (latePage) {
          attempts.push('late-page-captured');
        }
        const discoveredPage = popup ?? latePage;
        const afterPages = discoveredPage ? [...beforePages, discoveredPage] : listPages(browser);
        const capturedPopup = await capturePopupIfOpened(
          session,
          beforePages,
          afterPages,
          target.pageRef,
          attempts
        );
        let finalPageRef = target.pageRef;
        if (capturedPopup) {
          await syncSessionPage(session, capturedPopup.page.pageRef, capturedPopup.popup, {
            settleTimeoutMs: 1_500,
          });
          setCurrentPage(session, capturedPopup.page.pageRef);
          finalPageRef = capturedPopup.page.pageRef;
          currentPageRef = finalPageRef;
        } else {
          const syncedPage = await syncSessionPage(session, target.pageRef, page);
          currentPageRef = target.pageRef;
          if (startingPageUrl && syncedPage.url && syncedPage.url !== startingPageUrl) {
            clearProtectedExposure(session, target.pageRef);
          }

          const progressProbeForVerification = progressProbe as AcceptanceProbe | null;
          if (progressProbeForVerification) {
            const finalProgressProbe = progressProbeForVerification;
            const acceptance = await waitForAcceptanceProbe(finalProgressProbe);
            const afterPageObservation = acceptance.afterPageObservation;
            const accepted = acceptance.accepted;
            if (acceptance.polls > 1) {
              attempts.push(`acceptance.polled:${acceptance.polls}`);
            }
            if (!accepted) {
              if (finalProgressProbe.policy === 'value-change') {
                attempts.push(`acceptance.failed:${finalProgressProbe.policy}`);
                throw new Error('action_postcondition_failed:value-change');
              }

              if (
                (finalProgressProbe.policy === 'selection' ||
                  finalProgressProbe.policy === 'date-selection') &&
                finalProgressProbe.expectedValue !== null
              ) {
                attempts.push(`acceptance.failed:${finalProgressProbe.policy}`);
                throw new Error(`action_postcondition_failed:${finalProgressProbe.policy}`);
              }

              if (finalProgressProbe.policy === 'submit') {
                const submitResolution = await resolveSubmitResult(
                  finalProgressProbe,
                  afterPageObservation
                );
                if (submitResolution.acceptAsProgress) {
                  attempts.push(`submit-resolution:${submitResolution.finalVerdict}`);
                  if (
                    submitResolution.claims.some((claim) => claim.kind === 'soft_result_candidate')
                  ) {
                    attempts.push('submit-resolution:soft-result-candidate');
                  }
                } else {
                  attempts.push(`acceptance.failed:${finalProgressProbe.policy}`);
                  noProgressObservations = await diagnoseNoObservableProgress(
                    page,
                    finalProgressProbe.locator
                  );
                  if (
                    submitResolution.finalVerdict === 'blocked' ||
                    hasValidationBlockedObservations(noProgressObservations)
                  ) {
                    attempts.push('submit-resolution:blocked');
                    throw new Error('validation_blocked');
                  }

                  attempts.push('no-progress.detected');
                  throw new Error('no_observable_progress');
                }
              } else {
                const afterLocatorObservation =
                  finalProgressProbe.trackedStateKeys.length > 0
                    ? await captureLocatorState(
                        finalProgressProbe.locator,
                        finalProgressProbe.trackedStateKeys
                      )
                    : null;
                const afterContextHash = await captureLocatorContextHash(
                  finalProgressProbe.locator
                );
                const hasComparableSignal =
                  finalProgressProbe.trackedStateKeys.length > 0 ||
                  Boolean(finalProgressProbe.beforeContextHash || afterContextHash) ||
                  Boolean(finalProgressProbe.beforePage || afterPageObservation);
                const pageProgressChanged =
                  finalProgressProbe.policy === 'generic-click'
                    ? genericClickObservationChanged(
                        finalProgressProbe.beforePage,
                        afterPageObservation
                      )
                    : pageObservationChanged(finalProgressProbe.beforePage, afterPageObservation);

                if (
                  hasComparableSignal &&
                  !pageProgressChanged &&
                  finalProgressProbe.beforeContextHash === afterContextHash &&
                  !locatorStateChanged(finalProgressProbe.beforeLocator, afterLocatorObservation)
                ) {
                  attempts.push('no-progress.detected');
                  noProgressObservations = await diagnoseNoObservableProgress(
                    page,
                    finalProgressProbe.locator
                  );
                  throw new Error('no_observable_progress');
                }
              }
            } else {
              partialProgressResult = await partialProgressForAliasedSelection({
                requestedAction,
                probe: finalProgressProbe,
              });
            }
          } else if (recoveredProgressProbe) {
            partialProgressResult = await partialProgressForAliasedSelection({
              requestedAction,
              probe: recoveredProgressProbe,
            });
          }
        }

        if (resolvedBy === 'playwright-locator') {
          incrementMetric(session, 'deterministicActions');
        }
        bumpPageScopeEpoch(session, target.pageRef);
        recordActionResult(session, true, Date.now() - startedAt);
        await trace.finishSuccess();
        captureDiagnosticSnapshotBestEffort({
          session,
          step: actStep,
          phase: 'after',
          pageRef: finalPageRef,
        });
        recordCommandLifecycleEventBestEffort({
          step: actStep,
          phase: 'completed',
          attributes: {
            outcomeType: partialProgressResult?.outcomeType ?? 'action_completed',
            targetRef,
            action: requestedAction,
            pageRef: finalPageRef,
          },
        });
        await finalizeActStepBestEffort(actStep, {
          success: true,
          outcomeType: partialProgressResult?.outcomeType ?? 'action_completed',
          message: partialProgressResult?.message ?? 'The requested action completed successfully.',
        });
        return scrubProtectedExactValues(session, {
          success: true,
          targetRef,
          action: requestedAction,
          ...(action !== requestedAction ? { executedAs: action } : {}),
          value: actionValue,
          resolvedBy,
          locatorStrategy,
          pageRef: finalPageRef,
          attempts: sanitizePublicAttempts(attempts),
          popup: Boolean(capturedPopup),
          overlayHandled: attempts.includes('overlay.dismissed'),
          iframe: Boolean(target.framePath?.length),
          jsFallback: attempts.some((attempt) => attempt.startsWith('locator.evaluate.')),
          ...(recoveredAfterError
            ? {
                recoveredAfterError: true,
                recoveredAcceptancePolicy: recoveredAcceptancePolicy ?? undefined,
              }
            : {}),
          ...(partialProgressResult ?? {}),
          durationMs: Date.now() - startedAt,
          metrics: session.runtime?.metrics,
        });
      } catch (err) {
        failureMessage = `Act failed: ${err instanceof Error ? err.message : String(err)}`;
        recordActionResult(session, false, Date.now() - startedAt);
        if (staleReason) {
          markTargetLifecycle(session, targetRef, 'stale', staleReason);
        }
        if (currentPage) {
          try {
            const protectedExposure = getProtectedExposure(session, currentPageRef);
            if (protectedExposure) {
              await trace.finishSuccess();
              failureArtifacts = buildProtectedArtifactsSuppressed(protectedExposure);
            } else {
              failureArtifacts = await captureActionFailureArtifacts({
                page: currentPage,
                targetRef,
                action: requestedAction,
                pageRef: currentPageRef,
                attempts,
                locatorStrategy,
                popup: attempts.includes('popup-captured'),
                overlayHandled: attempts.includes('overlay.dismissed'),
                iframe: Boolean(target.framePath?.length),
                jsFallback: attempts.some((attempt) => attempt.startsWith('locator.evaluate.')),
                durationMs: Date.now() - startedAt,
                error: failureMessage,
                finishTrace: (artifactDir) => trace.finishFailure(artifactDir),
              });
            }
          } catch {
            // Best effort only. Preserve the original action failure.
          }
        }
      } finally {
        if (browser) {
          await disconnectPlaywright(browser);
        }
      }

      if (!failureMessage) {
        throw new Error('unreachable_action_completion_state');
      }

      const failureContract = describeActFailure({
        failureMessage,
        staleReason,
      });
      const outputObservations = hasMeaningfulNoObservableProgressObservations(
        noProgressObservations
      )
        ? noProgressObservations
        : undefined;
      const artifactManifestId = await persistActArtifactManifestBestEffort(
        runId,
        actStep,
        actStep?.stepId,
        failureArtifacts ?? null
      );
      captureDiagnosticSnapshotBestEffort({
        session,
        step: actStep,
        phase: 'point-in-time',
        pageRef: currentPageRef,
        artifactRefs: buildActSnapshotArtifactRefs(failureArtifacts ?? null),
      });
      recordCommandLifecycleEventBestEffort({
        step: actStep,
        phase: 'failed',
        attributes: {
          outcomeType: failureContract.outcomeType,
          targetRef,
          action: requestedAction,
          pageRef: currentPageRef,
          ...(artifactManifestId ? { artifactManifestId } : {}),
        },
      });
      await finalizeActStepBestEffort(actStep, {
        success: false,
        outcomeType: failureContract.outcomeType,
        message: failureContract.message,
        reason: failureContract.reason,
        artifactManifestId,
      });
      return scrubProtectedExactValues(session, {
        success: false,
        failureSurface: 'output',
        error: failureContract.error,
        outcomeType: failureContract.outcomeType,
        message: failureContract.message,
        reason: failureContract.reason,
        targetRef,
        action: requestedAction,
        ...(action !== requestedAction ? { executedAs: action } : {}),
        value: actionValue,
        pageRef: currentPageRef,
        locatorStrategy,
        attempts: sanitizePublicAttempts(attempts),
        popup: attempts.includes('popup-captured'),
        overlayHandled: attempts.includes('overlay.dismissed'),
        iframe: Boolean(target.framePath?.length),
        jsFallback: attempts.some((attempt) => attempt.startsWith('locator.evaluate.')),
        durationMs: Date.now() - startedAt,
        staleTarget: Boolean(staleReason),
        observations: outputObservations,
        artifacts: failureArtifacts,
        metrics: session.runtime?.metrics,
      });
    }
  );
}

export async function act(
  session: BrowserCommandSession,
  targetRef: string,
  action: BrowseAction,
  value?: string
): Promise<void> {
  const result = await actBrowser(session, targetRef, action, value);
  saveSession(session);
  if (result.success) {
    return outputJSON(result);
  }

  const { success: _success, failureSurface, ...failure } = result;
  if (failureSurface === 'contract') {
    return outputContractFailure(failure as BrowseContractFailure);
  }

  return outputFailure(failure);
}
