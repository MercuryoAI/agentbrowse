/**
 * browse screenshot [--path <file>] — Capture a screenshot of the current page.
 */

import { setCurrentPage } from '../runtime-page-state.js';
import type { BrowserCommandSession } from '../browser-session-state.js';
import { getProtectedExposure } from '../runtime-protected-state.js';
import { saveSession } from '../session.js';
import { outputFailure, outputJSON, outputContractFailure, info } from '../output.js';
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
import {
  buildProtectedScreenshotBlockedResult,
  type ProtectedScreenshotBlockedResult,
} from '../secrets/protected-artifact-guard.js';

/** Stable top-level error codes returned by `screenshot(...)`. */
export const SCREENSHOT_ERROR_CODES = [
  'browser_connection_failed',
  'protected_screenshot_blocked',
  'screenshot_failed',
] as const;

/** Stable outcome categories emitted by `screenshot(...)`. */
export const SCREENSHOT_OUTCOME_TYPES = [
  'blocked',
  'protected_exposure_active',
  'screenshot_captured',
] as const;

export type ScreenshotErrorCode = (typeof SCREENSHOT_ERROR_CODES)[number];
export type ScreenshotOutcomeType = (typeof SCREENSHOT_OUTCOME_TYPES)[number];

/** Successful screenshot capture result. */
export type ScreenshotSuccessResult = {
  success: true;
  pageRef: string;
  path: string;
  url: string;
  title: string;
};

/** Failed screenshot capture result. */
export type ScreenshotFailureResult = {
  success: false;
  error: ScreenshotErrorCode;
  outcomeType: Extract<ScreenshotOutcomeType, 'blocked' | 'protected_exposure_active'>;
  message: string;
  reason: string;
  pageRef?: string;
  fillRef?: string;
  requestId?: string;
  activatedAt?: string;
  exposureReason?: string;
};

export type ScreenshotResult = ScreenshotSuccessResult | ScreenshotFailureResult;

type ScreenshotFailurePayload = Omit<ScreenshotFailureResult, 'success'>;

async function buildScreenshotSuccessResult(params: {
  session: BrowserCommandSession;
  step: ReturnType<typeof startDiagnosticStep>;
  runId?: string;
  stepId?: string;
  pageRef: string;
  path: string;
  url: string;
  title: string;
}): Promise<ScreenshotSuccessResult> {
  const step =
    params.runId && params.stepId
      ? { runId: params.runId, stepId: params.stepId, command: 'screenshot' as const }
      : null;
  captureDiagnosticSnapshotBestEffort({
    session: params.session,
    step,
    phase: 'after',
    pageRef: params.pageRef,
    url: params.url,
    title: params.title,
    artifactRefs: {
      screenshotPath: params.path,
    },
  });
  recordCommandLifecycleEventBestEffort({
    step,
    phase: 'completed',
    attributes: {
      outcomeType: 'screenshot_captured',
      pageRef: params.pageRef,
      outputPath: params.path,
    },
  });
  await finishDiagnosticStepBestEffort({
    step: params.step,
    success: true,
    outcomeType: 'screenshot_captured',
    message: 'Screenshot captured.',
  });
  return {
    success: true,
    pageRef: params.pageRef,
    path: params.path,
    url: params.url,
    title: params.title,
  };
}

async function buildScreenshotFailureResult(
  session: BrowserCommandSession,
  params: ProtectedScreenshotBlockedResult & {
    step: ReturnType<typeof startDiagnosticStep>;
    runId?: string;
    stepId?: string;
  }
): Promise<ScreenshotFailureResult> {
  const step =
    params.runId && params.stepId
      ? { runId: params.runId, stepId: params.stepId, command: 'screenshot' as const }
      : null;
  captureDiagnosticSnapshotBestEffort({
    session,
    step,
    phase: 'point-in-time',
    pageRef: typeof params.pageRef === 'string' ? params.pageRef : session.runtime?.currentPageRef,
  });
  recordCommandLifecycleEventBestEffort({
    step,
    phase: 'failed',
    attributes: {
      outcomeType: typeof params.outcomeType === 'string' ? params.outcomeType : params.error,
      pageRef: typeof params.pageRef === 'string' ? params.pageRef : undefined,
      reason: typeof params.reason === 'string' ? params.reason : params.error,
    },
  });
  await finishDiagnosticStepBestEffort({
    step: params.step,
    success: false,
    outcomeType: typeof params.outcomeType === 'string' ? params.outcomeType : params.error,
    message: typeof params.message === 'string' ? params.message : params.error,
    reason: typeof params.reason === 'string' ? params.reason : params.error,
  });
  const { runId: _runId, stepId: _stepId, ...result } = params;
  const normalizedResult: ScreenshotFailurePayload = {
    error: result.error,
    outcomeType: result.outcomeType,
    reason: result.reason,
    ...(typeof result.pageRef === 'string' ? { pageRef: result.pageRef } : {}),
    ...(typeof result.fillRef === 'string' ? { fillRef: result.fillRef } : {}),
    ...(typeof result.requestId === 'string' ? { requestId: result.requestId } : {}),
    ...(typeof result.activatedAt === 'string' ? { activatedAt: result.activatedAt } : {}),
    ...(typeof result.exposureReason === 'string' ? { exposureReason: result.exposureReason } : {}),
    message: result.message,
  };
  return {
    success: false,
    ...normalizedResult,
  };
}

async function buildScreenshotContractFailureResult(
  session: BrowserCommandSession,
  params: ScreenshotFailurePayload & {
    step: ReturnType<typeof startDiagnosticStep>;
    runId?: string;
    stepId?: string;
  }
): Promise<ScreenshotFailureResult> {
  const step =
    params.runId && params.stepId
      ? { runId: params.runId, stepId: params.stepId, command: 'screenshot' as const }
      : null;
  captureDiagnosticSnapshotBestEffort({
    session,
    step,
    phase: 'point-in-time',
    pageRef: typeof params.pageRef === 'string' ? params.pageRef : session.runtime?.currentPageRef,
  });
  recordCommandLifecycleEventBestEffort({
    step,
    phase: 'failed',
    attributes: {
      outcomeType: params.outcomeType,
      pageRef: typeof params.pageRef === 'string' ? params.pageRef : undefined,
      reason: params.reason,
    },
  });
  await finishDiagnosticStepBestEffort({
    step: params.step,
    success: false,
    outcomeType: params.outcomeType,
    message: params.message,
    reason: params.reason,
  });
  const { runId: _runId, stepId: _stepId, ...result } = params;
  return {
    success: false,
    ...result,
  };
}

/** Captures a screenshot of the currently active page. */
export async function screenshotBrowser(
  session: BrowserCommandSession,
  filePath?: string
): Promise<ScreenshotResult> {
  const outputPath = filePath ?? `/tmp/browse-screenshot-${Date.now()}.png`;
  const initialPageRef = session.runtime?.currentPageRef ?? 'p0';
  let pageRef = initialPageRef;
  const initialProtectedExposure = getProtectedExposure(session, initialPageRef);
  const screenshotStep = startDiagnosticStep(
    {
      runId: session.activeRunId,
      command: 'screenshot',
      input: {
        outputPath,
      },
      refs: {
        pageRef: initialPageRef,
      },
      protectedStep: Boolean(initialProtectedExposure),
    },
    { session }
  );
  const screenshotStepHandle =
    session.activeRunId && screenshotStep?.stepId
      ? {
          runId: session.activeRunId,
          stepId: screenshotStep.stepId,
          command: 'screenshot' as const,
        }
      : null;
  captureDiagnosticSnapshotBestEffort({
    session,
    step: screenshotStepHandle,
    phase: 'before',
    pageRef: initialPageRef,
  });
  recordCommandLifecycleEventBestEffort({
    step: screenshotStepHandle,
    phase: 'started',
    attributes: {
      outputPath,
      pageRef: initialPageRef,
      protectedStep: Boolean(initialProtectedExposure),
    },
  });
  let browser = null;
  let failureMessage: string | null = null;
  let page = null;

  try {
    browser = await connectPlaywright(session.cdpUrl);
  } catch (err) {
    return buildScreenshotContractFailureResult(session, {
      step: screenshotStepHandle,
      error: 'browser_connection_failed',
      outcomeType: 'blocked',
      message:
        'Screenshot capture could not start because AgentBrowse failed to connect to the browser.',
      reason: err instanceof Error ? err.message : String(err),
      runId: session.activeRunId,
      stepId: screenshotStep?.stepId,
    });
  }

  try {
    const resolvedPage = await resolveCurrentPageContext(browser, session);
    pageRef = resolvedPage.pageRef;
    page = resolvedPage.page;
  } catch (err) {
    failureMessage = `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const recoveredProtectedExposure =
    getProtectedExposure(session, pageRef) ?? (!page ? initialProtectedExposure : null);
  if (recoveredProtectedExposure) {
    if (page && pageRef !== initialPageRef) {
      setCurrentPage(session, pageRef);
    }
    if (browser) {
      await disconnectPlaywright(browser);
      browser = null;
    }
    return buildScreenshotFailureResult(session, {
      step: screenshotStepHandle,
      ...buildProtectedScreenshotBlockedResult(recoveredProtectedExposure),
      runId: session.activeRunId,
      stepId: screenshotStep?.stepId,
    });
  }

  try {
    if (!page) {
      throw new Error(failureMessage?.replace(/^Screenshot failed:\s*/, '') ?? 'no_open_pages');
    }

    await page.screenshot({ path: outputPath });
    const { url, title } = await syncSessionPage(session, pageRef, page);
    setCurrentPage(session, pageRef);
    return buildScreenshotSuccessResult({
      session,
      step: screenshotStepHandle,
      runId: session.activeRunId,
      stepId: screenshotStep?.stepId,
      pageRef,
      path: outputPath,
      url,
      title,
    });
  } catch (err) {
    return buildScreenshotContractFailureResult(session, {
      step: screenshotStepHandle,
      error: 'screenshot_failed',
      outcomeType: 'blocked',
      message: 'Screenshot capture failed.',
      reason: err instanceof Error ? err.message : String(err),
      runId: session.activeRunId,
      stepId: screenshotStep?.stepId,
    });
  } finally {
    if (browser) {
      await disconnectPlaywright(browser);
    }
  }
}

/** CLI wrapper for `screenshotBrowser(...)` that persists session changes and writes JSON output. */
export async function screenshot(session: BrowserCommandSession, filePath?: string): Promise<void> {
  const initialPageRef = session.runtime?.currentPageRef;
  const result = await screenshotBrowser(session, filePath);
  const currentPageRef = session.runtime?.currentPageRef;
  if (result.success || currentPageRef !== initialPageRef) {
    saveSession(session);
  }
  if (result.success) {
    info(`Screenshot saved: ${result.path}`);
    return outputJSON(result);
  }

  if (result.error === 'protected_screenshot_blocked') {
    const { success: _success, ...failure } = result as ScreenshotFailureResult;
    return outputFailure(failure);
  }

  const { success: _success, ...failure } = result as ScreenshotFailureResult;
  return outputContractFailure(failure);
}
