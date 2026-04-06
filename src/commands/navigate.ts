/**
 * browse navigate <url> — Navigate the current tab to a URL.
 */

import { bumpPageScopeEpoch, setCurrentPage } from '../runtime-page-state.js';
import type { BrowserCommandSession } from '../browser-session-state.js';
import { clearProtectedExposure } from '../runtime-protected-state.js';
import { saveSession } from '../session.js';
import { outputContractFailure, outputJSON, info } from '../output.js';
import {
  captureDiagnosticSnapshotBestEffort,
  finishDiagnosticStepBestEffort,
  recordCommandLifecycleEventBestEffort,
  startDiagnosticStep,
} from '../diagnostics.js';
import {
  connectPlaywright,
  disconnectPlaywright,
  resolveCurrentPageContext,
  syncSessionPage,
} from '../playwright-runtime.js';
import { withApiTraceContext } from '../command-api-tracing.js';

/** Stable top-level error codes returned by `navigate(...)`. */
export const NAVIGATE_ERROR_CODES = ['browser_connection_failed', 'navigation_failed'] as const;

/** Stable outcome categories emitted by `navigate(...)`. */
export const NAVIGATE_OUTCOME_TYPES = ['blocked', 'navigation_completed'] as const;

export type NavigateErrorCode = (typeof NAVIGATE_ERROR_CODES)[number];
export type NavigateOutcomeType = (typeof NAVIGATE_OUTCOME_TYPES)[number];

/** Successful navigation result for the current page. */
export type NavigateSuccessResult = {
  success: true;
  pageRef: string;
  url: string;
  title: string;
};

/** Failed navigation result with a stable top-level error code. */
export type NavigateFailureResult = {
  success: false;
  error: NavigateErrorCode;
  outcomeType: Extract<NavigateOutcomeType, 'blocked'>;
  message: string;
  reason: string;
};

export type NavigateResult = NavigateSuccessResult | NavigateFailureResult;

async function buildNavigateSuccessResult(params: {
  step: ReturnType<typeof startDiagnosticStep>;
  runId?: string;
  stepId?: string;
  pageRef: string;
  url: string;
  title: string;
}): Promise<NavigateSuccessResult> {
  await finishDiagnosticStepBestEffort({
    step: params.step,
    success: true,
    outcomeType: 'navigation_completed',
    message: 'Navigation completed.',
  });
  return {
    success: true,
    pageRef: params.pageRef,
    url: params.url,
    title: params.title,
  };
}

async function buildNavigateFailureResult(params: {
  step: ReturnType<typeof startDiagnosticStep>;
  error: NavigateFailureResult['error'];
  outcomeType: NavigateFailureResult['outcomeType'];
  message: string;
  reason: string;
  runId?: string;
  stepId?: string;
}): Promise<NavigateFailureResult> {
  await finishDiagnosticStepBestEffort({
    step: params.step,
    success: false,
    outcomeType: params.outcomeType,
    message: params.message,
    reason: params.reason,
  });
  return {
    success: false,
    error: params.error,
    outcomeType: params.outcomeType,
    message: params.message,
    reason: params.reason,
  };
}

/** Navigates the currently active page to `targetUrl`. */
export async function navigateBrowser(
  session: BrowserCommandSession,
  targetUrl: string
): Promise<NavigateResult> {
  const initialPageRef = session.runtime?.currentPageRef ?? 'p0';
  const navigateStep = startDiagnosticStep(
    {
      runId: session.activeRunId,
      command: 'navigate',
      input: {
        targetUrl,
      },
      refs: {
        pageRef: initialPageRef,
      },
    },
    { session }
  );
  captureDiagnosticSnapshotBestEffort({
    session,
    step: navigateStep,
    phase: 'before',
    pageRef: initialPageRef,
  });
  recordCommandLifecycleEventBestEffort({
    step: navigateStep,
    phase: 'started',
    attributes: {
      targetUrl,
      pageRef: initialPageRef,
    },
  });
  return withApiTraceContext(
    {
      runId: session.activeRunId,
      stepId: navigateStep?.stepId,
      command: 'navigate',
    },
    async () => {
      let browser = null;
      let failureMessage: string | null = null;

      try {
        browser = await connectPlaywright(session.cdpUrl);
      } catch (err) {
        captureDiagnosticSnapshotBestEffort({
          session,
          step: navigateStep,
          phase: 'point-in-time',
          pageRef: initialPageRef,
        });
        recordCommandLifecycleEventBestEffort({
          step: navigateStep,
          phase: 'failed',
          attributes: {
            outcomeType: 'blocked',
            reason: err instanceof Error ? err.message : String(err),
          },
        });
        return buildNavigateFailureResult({
          step: navigateStep,
          error: 'browser_connection_failed',
          outcomeType: 'blocked',
          message:
            'Navigation could not start because AgentBrowse failed to connect to the browser.',
          reason: err instanceof Error ? err.message : String(err),
          runId: session.activeRunId,
          stepId: navigateStep?.stepId,
        });
      }

      try {
        let pageRef = session.runtime?.currentPageRef ?? 'p0';
        const resolvedPage = await resolveCurrentPageContext(browser, session);
        pageRef = resolvedPage.pageRef;
        const page = resolvedPage.page;

        if (!page) {
          throw new Error('no_open_pages');
        }

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        const { url, title } = await syncSessionPage(session, pageRef, page);
        bumpPageScopeEpoch(session, pageRef);
        setCurrentPage(session, pageRef);
        clearProtectedExposure(session, pageRef);
        captureDiagnosticSnapshotBestEffort({
          session,
          step: navigateStep,
          phase: 'after',
          pageRef,
          url,
          title,
        });
        recordCommandLifecycleEventBestEffort({
          step: navigateStep,
          phase: 'completed',
          attributes: {
            outcomeType: 'navigation_completed',
            pageRef,
            url,
          },
        });
        return buildNavigateSuccessResult({
          step: navigateStep,
          runId: session.activeRunId,
          stepId: navigateStep?.stepId,
          pageRef,
          url,
          title,
        });
      } catch (err) {
        failureMessage = `Navigation failed: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        if (browser) {
          await disconnectPlaywright(browser);
        }
      }

      if (failureMessage) {
        captureDiagnosticSnapshotBestEffort({
          session,
          step: navigateStep,
          phase: 'point-in-time',
          pageRef: session.runtime?.currentPageRef ?? initialPageRef,
        });
        recordCommandLifecycleEventBestEffort({
          step: navigateStep,
          phase: 'failed',
          attributes: {
            outcomeType: 'blocked',
            reason: failureMessage.replace(/^Navigation failed:\s*/, ''),
          },
        });
        return buildNavigateFailureResult({
          step: navigateStep,
          error: 'navigation_failed',
          outcomeType: 'blocked',
          message: 'Navigation failed.',
          reason: failureMessage.replace(/^Navigation failed:\s*/, ''),
          runId: session.activeRunId,
          stepId: navigateStep?.stepId,
        });
      }

      return buildNavigateFailureResult({
        step: navigateStep,
        error: 'navigation_failed',
        outcomeType: 'blocked',
        message: 'Navigation failed.',
        reason: 'Navigation failed for an unknown reason.',
        runId: session.activeRunId,
        stepId: navigateStep?.stepId,
      });
    }
  );
}

/** CLI wrapper for `navigateBrowser(...)` that persists the session and writes JSON output. */
export async function navigate(session: BrowserCommandSession, targetUrl: string): Promise<void> {
  const result = await navigateBrowser(session, targetUrl);
  if (result.success) {
    saveSession(session);
  }
  if (result.success) {
    info(`Navigated to: ${targetUrl}`);
    return outputJSON(result);
  }

  const { success: _success, ...failure } = result;
  return outputContractFailure(failure);
}
