import { getSessionPort, type BrowserSessionState } from './browser-session-state.js';
import { connectPlaywright } from './playwright-runtime.js';
import { cleanupManagedBrowserPids, terminateOwnedPid } from './owned-process.js';
import { getUserDataDir } from './solver/config.js';

const ENDPOINT_WAIT_ATTEMPTS = 10;
const ENDPOINT_WAIT_MS = 100;

export type CloseOwnedBrowserResult =
  | {
      success: true;
      method: 'already_closed' | 'cdp' | 'signal' | 'cleanup';
    }
  | {
      success: false;
      reason: string;
    };

export async function closeOwnedBrowser(
  session: BrowserSessionState & { pid: number }
): Promise<CloseOwnedBrowserResult> {
  const port = getSessionPort(session);
  const endpointAliveBeforeClose = await isBrowserEndpointAlive(port);

  if (endpointAliveBeforeClose) {
    await tryCloseBrowserViaCdp(session.cdpUrl);
    if (await waitForBrowserEndpointToClose(port)) {
      return { success: true, method: 'cdp' };
    }
  }

  const termination = await terminateOwnedPid(session.pid);
  if (await waitForBrowserEndpointToClose(port)) {
    return {
      success: true,
      method: endpointAliveBeforeClose ? 'signal' : 'already_closed',
    };
  }

  if (session.profile) {
    const cleanup = await cleanupManagedBrowserPids({
      userDataDir: getUserDataDir(session.profile),
    });
    if (await waitForBrowserEndpointToClose(port)) {
      return {
        success: true,
        method: cleanup.terminated.length > 0 ? 'cleanup' : 'already_closed',
      };
    }
  }

  if (!endpointAliveBeforeClose && termination === 'not_found') {
    return { success: true, method: 'already_closed' };
  }

  return {
    success: false,
    reason: `Owned browser endpoint on port ${port} remained reachable after close attempts (termination=${termination}).`,
  };
}

async function tryCloseBrowserViaCdp(cdpUrl: string): Promise<void> {
  try {
    const browser = await connectPlaywright(cdpUrl);
    await browser.close();
  } catch {}
}

async function isBrowserEndpointAlive(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForBrowserEndpointToClose(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < ENDPOINT_WAIT_ATTEMPTS; attempt++) {
    if (!(await isBrowserEndpointAlive(port))) {
      return true;
    }
    await sleep(ENDPOINT_WAIT_MS);
  }

  return !(await isBrowserEndpointAlive(port));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
