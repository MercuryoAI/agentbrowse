/**
 * browse launch [url] — Start browser session, optionally navigate.
 */

import type { Browser } from 'playwright-core';
import { buildOwnedSession, type BrowserSessionState } from '../browser-session-state.js';
import { getConfigPath, readConfig } from '../solver/config.js';
import { launchSolver } from '../solver/browser-launcher.js';
import { ensureProfile } from '../solver/profile-manager.js';
import { connectPlaywright, disconnectPlaywright, syncLaunchPage } from '../playwright-runtime.js';
import { info } from '../output.js';
import type { ProfileInfo, ProxyConfig, ProxySetting } from '../solver/types.js';

const DEFAULT_PROFILE = 'default';
const COMPACT_WINDOW = {
  width: 1280,
  height: 900,
};

/** Stable top-level error codes returned by `launch(...)`. */
export const LAUNCH_ERROR_CODES = ['browser_launch_failed'] as const;

/** Stable outcome categories emitted by `launch(...)`. */
export const LAUNCH_OUTCOME_TYPES = ['blocked'] as const;

export type LaunchErrorCode = (typeof LAUNCH_ERROR_CODES)[number];
export type LaunchOutcomeType = (typeof LAUNCH_OUTCOME_TYPES)[number];

/** Browser launch options for AgentBrowse-managed sessions. */
export type LaunchOptions = {
  compact?: boolean;
  profile?: string;
  headless?: boolean;
  useProxy?: boolean;
  proxy?: string;
};

/** Successful managed launch result. */
export type LaunchSuccessResult = {
  success: true;
  runtime: 'managed';
  captchaSolveCapable: true;
  profile: string;
  session: BrowserSessionState;
  cdpUrl: string;
  url: string;
  title: string;
};

/** Failed managed launch result with a stable error code. */
export type LaunchFailureResult = {
  success: false;
  error: LaunchErrorCode;
  outcomeType: LaunchOutcomeType;
  message: 'Browser launch failed.';
  reason: string;
};

export type LaunchResult = LaunchSuccessResult | LaunchFailureResult;

/** Launches a managed browser session and optionally navigates to `url`. */
export async function launch(url?: string, opts?: LaunchOptions): Promise<LaunchResult> {
  const compact = opts?.compact ?? true;
  const profileName = opts?.profile ?? DEFAULT_PROFILE;
  const headless = opts?.headless;
  const useProxy = opts?.useProxy ?? false;
  const proxyOverride = opts?.proxy;

  return launchManaged(url, profileName, headless, compact, useProxy, proxyOverride);
}

function buildLaunchFailure(err: unknown): LaunchFailureResult {
  return {
    success: false,
    error: 'browser_launch_failed',
    outcomeType: 'blocked',
    message: 'Browser launch failed.',
    reason: formatUnknownError(err),
  };
}

async function launchManaged(
  url: string | undefined,
  profileName: string,
  headless: boolean | undefined,
  compact: boolean,
  useProxy = false,
  proxyOverride?: string
): Promise<LaunchResult> {
  let session;
  let browser: Browser | null = null;
  let runtimeProxy: ProxyConfig | undefined;

  try {
    const baseProfile = ensureProfile(profileName);
    const config = readConfig();
    runtimeProxy = resolveLaunchProxy({
      configProxy: config.defaults?.proxy,
      useProxy,
      cliProxy: proxyOverride,
    });
    const profile = withLaunchProxy(baseProfile, runtimeProxy);
    if (runtimeProxy) {
      info(`[launch] starting browser with proxy ${runtimeProxy.server}`);
    }

    const resolvedHeadless = headless ?? config.defaults?.headless ?? false;
    session = await launchSolver(profile, {
      headless: resolvedHeadless,
      url,
      cdpPort: undefined,
      windowSize: compact ? COMPACT_WINDOW : undefined,
    });
  } catch (err) {
    return buildLaunchFailure(err);
  }

  const persistedSession = buildOwnedSession({
    cdpUrl: session!.cdpUrl,
    pid: session!.pid,
    profile: profileName,
    launchedAt: new Date().toISOString(),
    transport: runtimeProxy
      ? {
          proxyMode: 'proxy',
          proxy: runtimeProxy,
        }
      : {
          proxyMode: 'direct',
        },
    capabilities: {
      captchaSolve: true,
    },
  });

  let currentUrl = session!.page.url();
  let title = await session!.page.title().catch(() => '');
  try {
    browser = await connectPlaywright(session!.cdpUrl);
    const syncedPage = await syncLaunchPage(persistedSession, browser, {
      requestedUrl: url,
      fallbackUrl: currentUrl,
      fallbackTitle: title,
    });
    currentUrl = syncedPage.url;
    title = syncedPage.title;
  } catch {
    // Preserve the successful launch and fall back to the launcher snapshot.
  } finally {
    if (browser) {
      await disconnectPlaywright(browser);
    }
    await session!.disconnect();
  }
  return {
    success: true,
    runtime: 'managed',
    captchaSolveCapable: true,
    profile: profileName,
    session: persistedSession,
    cdpUrl: session!.cdpUrl,
    url: currentUrl,
    title,
  };
}

function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

function resolveLaunchProxy(options: {
  configProxy?: ProxySetting;
  useProxy: boolean;
  cliProxy?: string;
}): ProxyConfig | undefined {
  if (!options.useProxy) {
    return undefined;
  }

  if (options.cliProxy) {
    return normalizeProxySetting(options.cliProxy);
  }

  if (options.configProxy) {
    return normalizeProxySetting(options.configProxy);
  }

  throw new Error(
    `Proxy launch requested but no proxy is configured. Pass \`--proxy <url>\` or set defaults.proxy in ${getConfigPath()}.`
  );
}

function withLaunchProxy(profile: ProfileInfo, proxy?: ProxyConfig): ProfileInfo {
  return {
    ...profile,
    fingerprint: {
      ...profile.fingerprint,
      proxy,
    },
  };
}

function normalizeProxySetting(value: ProxySetting): ProxyConfig {
  if (typeof value === 'string') {
    return parseProxyString(value);
  }

  const normalized = parseProxyString(value.server);
  const username = value.username?.trim() || normalized.username;
  const password = value.password ?? normalized.password;

  return {
    server: normalized.server,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

function parseProxyString(value: string): ProxyConfig {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Proxy value must not be empty.');
  }

  try {
    const parsed = new URL(trimmed);
    const server = `${parsed.protocol}//${parsed.host}`;
    if (!parsed.hostname) {
      throw new Error('missing hostname');
    }

    return {
      server,
      ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
      ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    };
  } catch {
    return { server: trimmed };
  }
}
