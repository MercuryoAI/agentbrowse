/**
 * attach <cdp-url> — Attach AgentBrowse to an existing browser session.
 */

import {
  buildAttachedSession,
  buildCdpHttpEndpointUrl,
  type BrowserSessionState,
  type BrowserSessionCapabilities,
} from '../browser-session-state.js';
import { connectPlaywright, disconnectPlaywright, syncLaunchPage } from '../playwright-runtime.js';
import type { BrowseSessionTransport } from '../browser-session-state.js';

/** Stable top-level error codes returned by `attach(...)`. */
export const ATTACH_ERROR_CODES = ['browser_attach_failed'] as const;

/** Stable outcome categories emitted by `attach(...)`. */
export const ATTACH_OUTCOME_TYPES = ['blocked'] as const;

export type AttachErrorCode = (typeof ATTACH_ERROR_CODES)[number];
export type AttachOutcomeType = (typeof ATTACH_OUTCOME_TYPES)[number];

/** Metadata used when attaching to an already running browser. */
export type AttachOptions = {
  launchedAt?: string;
  provider?: string;
  capabilities?: BrowserSessionCapabilities;
  transport?: BrowseSessionTransport;
};

/** Successful attach result for an existing CDP browser session. */
export type AttachSuccessResult = {
  success: true;
  runtime: 'attached';
  session: BrowserSessionState;
  cdpUrl: string;
  url: string;
  title: string;
  provider?: string;
  captchaSolveCapable: boolean;
};

/** Failed attach result with a stable top-level error code. */
export type AttachFailureResult = {
  success: false;
  error: AttachErrorCode;
  outcomeType: AttachOutcomeType;
  message: 'Browser attach failed.';
  reason: string;
};

export type AttachResult = AttachSuccessResult | AttachFailureResult;

/** Attaches AgentBrowse to an existing browser via a CDP websocket or HTTP endpoint. */
export async function attach(cdpUrl: string, options: AttachOptions = {}): Promise<AttachResult> {
  let browser: Awaited<ReturnType<typeof connectPlaywright>> | null = null;

  try {
    const normalizedCdpUrl = await resolveAttachEndpoint(cdpUrl);

    const session = buildAttachedSession({
      cdpUrl: normalizedCdpUrl,
      launchedAt: options.launchedAt ?? new Date().toISOString(),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      ...(options.transport ? { transport: options.transport } : {}),
    });

    browser = await connectPlaywright(normalizedCdpUrl);
    const syncedPage = await syncLaunchPage(session, browser, {
      fallbackUrl: '',
      fallbackTitle: '',
    });

    return {
      success: true,
      runtime: 'attached',
      session,
      cdpUrl: normalizedCdpUrl,
      url: syncedPage.url,
      title: syncedPage.title,
      ...(options.provider ? { provider: options.provider } : {}),
      captchaSolveCapable: options.capabilities?.captchaSolve === true,
    };
  } catch (error) {
    return {
      success: false,
      error: 'browser_attach_failed',
      outcomeType: 'blocked',
      message: 'Browser attach failed.',
      reason: formatUnknownError(error),
    };
  } finally {
    if (browser) {
      await disconnectPlaywright(browser);
    }
  }
}

async function resolveAttachEndpoint(input: string): Promise<string> {
  const normalized = input.trim();
  if (!normalized) {
    throw new Error('CDP URL must not be empty.');
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
      return normalized;
    }

    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const versionUrl = buildCdpHttpEndpointUrl(normalized, '/json/version');
      if (!versionUrl) {
        throw new Error('The provided DevTools endpoint could not be normalized.');
      }

      const response = await fetch(versionUrl);
      if (!response.ok) {
        throw new Error(`DevTools version endpoint returned HTTP ${response.status}.`);
      }

      const payload = (await response.json()) as { webSocketDebuggerUrl?: string };
      const webSocketDebuggerUrl = payload.webSocketDebuggerUrl?.trim();
      if (!webSocketDebuggerUrl) {
        throw new Error('DevTools version endpoint did not return a webSocketDebuggerUrl.');
      }

      return webSocketDebuggerUrl;
    }
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
  }

  return normalized;
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
