/**
 * browse close — Close the browser and clean up session.
 */

import { isOwnedSession, type BrowserSessionState } from '../browser-session-state.js';
import {
  captureDiagnosticSnapshotBestEffort,
  finishDiagnosticStepBestEffort,
  recordCommandLifecycleEventBestEffort,
  startDiagnosticStep,
} from '../diagnostics.js';
import { info } from '../output.js';
import { closeOwnedBrowser } from '../owned-browser.js';
import { isManagedBrowserPid } from '../owned-process.js';

/** Stable top-level error codes returned by `close(...)`. */
export const CLOSE_ERROR_CODES = ['browser_close_failed'] as const;

/** Stable outcome categories emitted by `close(...)`. */
export const CLOSE_OUTCOME_TYPES = ['blocked', 'browser_closed', 'browser_close_failed'] as const;

export type CloseErrorCode = (typeof CLOSE_ERROR_CODES)[number];
export type CloseOutcomeType = (typeof CLOSE_OUTCOME_TYPES)[number];

/** Successful browser close result. */
export type CloseSuccessResult = {
  success: true;
};

/** Failed browser close result. */
export type CloseFailureResult = {
  success: false;
  error: CloseErrorCode;
  outcomeType: Extract<CloseOutcomeType, 'blocked'>;
  message: 'Browser close failed.';
  reason: string;
};

export type CloseResult = CloseSuccessResult | CloseFailureResult;

function isCloseableManagedSession(
  session: BrowserSessionState | null
): session is BrowserSessionState & { pid: number } {
  if (!session) {
    return false;
  }

  if (isOwnedSession(session)) {
    return true;
  }

  return (
    !session.identity &&
    typeof session.pid === 'number' &&
    Number.isFinite(session.pid) &&
    isManagedBrowserPid(session.pid)
  );
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}

/** Closes an AgentBrowse-managed browser session when the current session owns it. */
export async function close(session: BrowserSessionState | null): Promise<CloseResult> {
  const closeStep = startDiagnosticStep(
    {
      command: 'close',
      input: {
        hadSession: session !== null,
        closeableManagedSession: isCloseableManagedSession(session),
      },
    },
    { session }
  );
  if (session) {
    captureDiagnosticSnapshotBestEffort({
      session,
      step: closeStep,
      phase: 'before',
    });
  }
  recordCommandLifecycleEventBestEffort({
    step: closeStep,
    phase: 'started',
    attributes: {
      hadSession: session !== null,
      closeableManagedSession: isCloseableManagedSession(session),
    },
  });

  if (isCloseableManagedSession(session)) {
    const closeResult = await closeOwnedBrowser(session);
    if (!closeResult.success) {
      recordCommandLifecycleEventBestEffort({
        step: closeStep,
        phase: 'failed',
        attributes: {
          outcomeType: 'browser_close_failed',
          reason: closeResult.reason,
        },
      });
      await finishStepBestEffort(closeStep, {
        success: false,
        outcomeType: 'browser_close_failed',
        message: 'Browser close failed.',
        reason: closeResult.reason,
      });
      info(`Owned browser close failed; keeping session record: ${closeResult.reason}`);
      return {
        success: false,
        error: 'browser_close_failed',
        outcomeType: 'blocked',
        message: 'Browser close failed.',
        reason: closeResult.reason,
      };
    }
  }

  recordCommandLifecycleEventBestEffort({
    step: closeStep,
    phase: 'completed',
    attributes: {
      outcomeType: 'browser_closed',
    },
  });

  await finishStepBestEffort(closeStep, {
    success: true,
    outcomeType: 'browser_closed',
    message: 'Browser session closed.',
  });

  return { success: true };
}

async function finishStepBestEffort(
  step: ReturnType<typeof startDiagnosticStep>,
  options: {
    success: boolean;
    outcomeType?: string;
    message?: string;
    reason?: string;
  }
): Promise<void> {
  if (!step?.stepId) {
    return;
  }

  try {
    await finishDiagnosticStepBestEffort({
      step,
      success: options.success,
      outcomeType: options.outcomeType,
      message: options.message,
      reason: options.reason,
    });
  } catch (error) {
    info(`[close] failed to finalize diagnostic step ${step.stepId}: ${formatUnknownError(error)}`);
  }
}
