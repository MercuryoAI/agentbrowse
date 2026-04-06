/**
 * browse browser-status — Check live browser/page/runtime state.
 */

import {
  buildCdpHttpEndpointUrl,
  getSessionPort,
  supportsCaptchaSolve,
  type BrowserSessionState,
} from '../browser-session-state.js';
import {
  connectPlaywright,
  disconnectPlaywright,
  resolveCurrentPageContext,
} from '../playwright-runtime.js';
import {
  captureDiagnosticSnapshotBestEffort,
  finishDiagnosticStepBestEffort,
  recordCommandLifecycleEventBestEffort,
  startDiagnosticStep,
} from '../diagnostics.js';
import { scrubProtectedExactValues } from '../secrets/protected-exact-value-redaction.js';

type LiveStatusPage = {
  url: string;
  title: string;
  type: string;
};

type CurrentPageMismatch = {
  persistedPageRef: string;
  livePageRef?: string;
  recoveredVia?: 'opener' | 'sole-live-page';
};

/** Stable outcome categories exposed by `status(...)`. */
export const BROWSER_STATUS_OUTCOME_TYPES = [
  'browser_alive',
  'browser_not_running',
  'protected_exposure_active',
] as const;

export type BrowserStatusOutcomeType = (typeof BROWSER_STATUS_OUTCOME_TYPES)[number];
export type BrowserStatusRuntimeSummary = Record<string, unknown>;
export type BrowserStatusCurrentPageMismatch = CurrentPageMismatch;

/** Success result when the current page is sensitive because protected values may still be visible. */
export type BrowserStatusProtectedExposureResult = {
  success: true;
  alive: true;
  outcomeType: Extract<BrowserStatusOutcomeType, 'protected_exposure_active'>;
  runtime?: BrowserStatusRuntimeSummary;
  currentPageMismatch?: BrowserStatusCurrentPageMismatch;
  protectedExposureActive: true;
  pageRef: string;
  url: string;
  title: string;
  host?: string;
  fillRef: string;
  activatedAt: string;
  exposureReason: string;
  message: string;
  reason: string;
  captchaSolveCapable?: boolean;
};

/** Success result when the browser is alive and a current page could be resolved or approximated. */
export type BrowserStatusAliveResult = {
  success: true;
  alive: true;
  captchaSolveCapable?: boolean;
  pageRef?: string;
  url?: string;
  title?: string;
  runtime?: BrowserStatusRuntimeSummary;
  currentPageMismatch?: BrowserStatusCurrentPageMismatch;
  currentPageUnresolved?: true;
};

/** Success result when the browser is not currently reachable. */
export type BrowserStatusNotRunningResult = {
  success: true;
  alive: false;
  runtime?: BrowserStatusRuntimeSummary;
  currentPageUnresolved?: true;
};

export type BrowserStatusResult =
  | BrowserStatusProtectedExposureResult
  | BrowserStatusAliveResult
  | BrowserStatusNotRunningResult;

function tryResolveHost(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function buildRuntimeSummary(
  session: BrowserSessionState | null
): BrowserStatusRuntimeSummary | undefined {
  return session?.runtime
    ? {
        currentPageRef: session.runtime.currentPageRef,
        pageCount: Object.keys(session.runtime.pages).length,
        surfaceCount: Object.keys(session.runtime.surfaces ?? {}).length,
        targetCount: Object.keys(session.runtime.targets).length,
        metrics: session.runtime.metrics,
      }
    : undefined;
}

function buildProtectedStatusPayload(params: {
  runtimeSummary: BrowserStatusRuntimeSummary | undefined;
  pageRef: string;
  pageUrl?: string;
  pageTitle?: string;
  captchaSolveCapable?: boolean;
  currentPageMismatch?: CurrentPageMismatch;
  protectedExposure: {
    pageRef: string;
    fillRef: string;
    activatedAt: string;
    reason: string;
  };
}): BrowserStatusProtectedExposureResult {
  return {
    success: true,
    alive: true,
    outcomeType: 'protected_exposure_active',
    ...(params.captchaSolveCapable !== undefined
      ? { captchaSolveCapable: params.captchaSolveCapable }
      : {}),
    runtime: params.runtimeSummary,
    ...(params.currentPageMismatch ? { currentPageMismatch: params.currentPageMismatch } : {}),
    protectedExposureActive: true,
    pageRef: params.pageRef,
    url: params.pageUrl ?? 'unknown',
    title: params.pageTitle ?? 'unknown',
    ...(tryResolveHost(params.pageUrl) ? { host: tryResolveHost(params.pageUrl) } : {}),
    fillRef: params.protectedExposure.fillRef,
    activatedAt: params.protectedExposure.activatedAt,
    exposureReason: params.protectedExposure.reason,
    message: 'Protected values may still be visible on the current page.',
    reason:
      'AgentBrowse is treating the current page as sensitive because a protected fill was executed and values may still be visible.',
  };
}

async function readCanonicalStatus(session: BrowserSessionState): Promise<{
  pageRef: string;
  url: string;
  title: string;
  currentPageMismatch?: CurrentPageMismatch;
} | null> {
  let browser: Awaited<ReturnType<typeof connectPlaywright>> | null = null;
  try {
    browser = await connectPlaywright(session.cdpUrl);
    const resolved = await resolveCurrentPageContext(browser, session);
    const persisted = session.runtime?.currentPageRef;
    const title =
      (await resolved.page
        .title()
        .catch(() => session.runtime?.pages[resolved.pageRef]?.title ?? '')) ||
      session.runtime?.pages[resolved.pageRef]?.title ||
      'unknown';
    const url = resolved.page.url() || session.runtime?.pages[resolved.pageRef]?.url || 'unknown';

    return {
      pageRef: resolved.pageRef,
      url,
      title,
      ...(persisted && (persisted !== resolved.pageRef || resolved.recoveredVia)
        ? {
            currentPageMismatch: {
              persistedPageRef: persisted,
              ...(persisted !== resolved.pageRef ? { livePageRef: resolved.pageRef } : {}),
              ...(resolved.recoveredVia ? { recoveredVia: resolved.recoveredVia } : {}),
            },
          }
        : {}),
    };
  } catch {
    return null;
  } finally {
    if (browser) {
      await disconnectPlaywright(browser);
    }
  }
}

function buildStatusEndpointUrl(
  session: BrowserSessionState | null,
  port: number,
  resourcePath: '/json/version' | '/json/list'
): string {
  if (session) {
    const endpoint =
      buildCdpHttpEndpointUrl(session.identity?.endpoint ?? session.cdpUrl, resourcePath) ??
      buildCdpHttpEndpointUrl(session.cdpUrl, resourcePath);
    if (endpoint) {
      return endpoint;
    }
  }

  return `http://127.0.0.1:${port}${resourcePath}`;
}

async function readFallbackLiveStatus(
  session: BrowserSessionState | null,
  port: number
): Promise<LiveStatusPage | undefined> {
  const res = await fetch(buildStatusEndpointUrl(session, port, '/json/version'));
  if (!res.ok) {
    return undefined;
  }

  const listRes = await fetch(buildStatusEndpointUrl(session, port, '/json/list'));
  const targets = (await listRes.json()) as LiveStatusPage[];
  return targets.find((target) => target.type === 'page' && !target.url.startsWith('devtools://'));
}

async function finishBrowserStatusStepBestEffort(
  session: BrowserSessionState | null,
  step: ReturnType<typeof startDiagnosticStep>,
  result: BrowserStatusResult
): Promise<void> {
  const pageRef = 'pageRef' in result ? result.pageRef : session?.runtime?.currentPageRef;
  const url = 'url' in result ? result.url : undefined;
  const title = 'title' in result ? result.title : undefined;
  const outcomeType: BrowserStatusOutcomeType =
    'outcomeType' in result
      ? result.outcomeType
      : result.alive === true
        ? 'browser_alive'
        : 'browser_not_running';
  const message = 'message' in result ? result.message : undefined;
  const reason = 'reason' in result ? result.reason : undefined;
  captureDiagnosticSnapshotBestEffort({
    session: session ?? {
      cdpUrl: '',
      pid: 0,
      launchedAt: new Date(0).toISOString(),
    },
    step,
    phase: 'point-in-time',
    pageRef,
    url,
    title,
  });
  recordCommandLifecycleEventBestEffort({
    step,
    phase: result.success ? 'completed' : 'failed',
    attributes: {
      alive: result.alive === true,
      outcomeType,
      ...(pageRef ? { pageRef } : {}),
    },
  });
  await finishDiagnosticStepBestEffort({
    step,
    success: result.success,
    outcomeType,
    ...(message ? { message } : {}),
    ...(reason ? { reason } : {}),
  });
}

/** Reports whether the current browser session is alive and which page is active. */
export async function browserStatus(
  session: BrowserSessionState | null
): Promise<BrowserStatusResult> {
  const port = getSessionPort(session);
  const runtimeSummary = buildRuntimeSummary(session);
  const statusStep = startDiagnosticStep(
    {
      command: 'browser-status',
      input: {
        hasSession: session !== null,
        hasRuntime: Boolean(session?.runtime),
      },
    },
    { session }
  );
  recordCommandLifecycleEventBestEffort({
    step: statusStep,
    phase: 'started',
    attributes: {
      hasSession: session !== null,
      hasRuntime: Boolean(session?.runtime),
    },
  });

  if (session) {
    const canonical = await readCanonicalStatus(session);
    if (canonical) {
      const protectedExposure = session.runtime?.protectedExposureByPage?.[canonical.pageRef];

      if (protectedExposure) {
        const result = buildProtectedStatusPayload({
          runtimeSummary,
          pageRef: canonical.pageRef,
          pageUrl: canonical.url,
          pageTitle: canonical.title,
          captchaSolveCapable: supportsCaptchaSolve(session),
          currentPageMismatch: canonical.currentPageMismatch,
          protectedExposure,
        });
        const scrubbedResult = scrubProtectedExactValues(session, result);
        await finishBrowserStatusStepBestEffort(session, statusStep, scrubbedResult);
        return scrubbedResult;
      }

      const result: BrowserStatusAliveResult = {
        success: true,
        alive: true,
        captchaSolveCapable: supportsCaptchaSolve(session),
        pageRef: canonical.pageRef,
        url: canonical.url,
        title: canonical.title,
        runtime: runtimeSummary,
        ...(canonical.currentPageMismatch
          ? { currentPageMismatch: canonical.currentPageMismatch }
          : {}),
      };
      const scrubbedResult = scrubProtectedExactValues(session, result);
      await finishBrowserStatusStepBestEffort(session, statusStep, scrubbedResult);
      return scrubbedResult;
    }
  }

  try {
    const page = await readFallbackLiveStatus(session, port);
    if (!page) {
      const result: BrowserStatusNotRunningResult = {
        success: true,
        alive: false,
        runtime: runtimeSummary,
      };
      const scrubbedResult = session ? scrubProtectedExactValues(session, result) : result;
      await finishBrowserStatusStepBestEffort(session, statusStep, scrubbedResult);
      return scrubbedResult;
    }

    const result: BrowserStatusAliveResult = {
      success: true,
      alive: true,
      ...(session ? { captchaSolveCapable: supportsCaptchaSolve(session) } : {}),
      url: page.url ?? 'unknown',
      title: page.title ?? 'unknown',
      ...(session?.runtime ? { currentPageUnresolved: true } : {}),
      runtime: runtimeSummary,
    };
    const scrubbedResult = session ? scrubProtectedExactValues(session, result) : result;
    await finishBrowserStatusStepBestEffort(session, statusStep, scrubbedResult);
    return scrubbedResult;
  } catch {
    const result: BrowserStatusNotRunningResult = {
      success: true,
      alive: false,
      ...(session?.runtime ? { currentPageUnresolved: true } : {}),
      runtime: runtimeSummary,
    };
    const scrubbedResult = session ? scrubProtectedExactValues(session, result) : result;
    await finishBrowserStatusStepBestEffort(session, statusStep, scrubbedResult);
    return scrubbedResult;
  }
}
