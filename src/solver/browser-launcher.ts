import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect as connectPuppeteer, type Browser, type Page } from 'puppeteer';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserFingerprint, LaunchOptions, ProfileInfo } from './types.js';
import { buildTurnstileApiShimSource, isTurnstileApiRequest } from './turnstile-challenge.js';

type PuppeteerConnectOptions = Parameters<typeof import('puppeteer')['connect']>[0];
type RunningChromeProcess = ChildProcess & { pid: number };

const enhancedPuppeteer = puppeteerExtra as unknown as {
  use: (plugin: unknown) => unknown;
  connect: (options: PuppeteerConnectOptions) => Promise<Browser>;
};
const solverStealthPlugin = StealthPlugin();

// Some iframe-backed checkout flows break when this evasion runs on a connected real Chrome.
solverStealthPlugin.enabledEvasions.delete('iframe.contentWindow');
// We already pin the browser UA at launch time; this evasion races popup teardown on CI.
solverStealthPlugin.enabledEvasions.delete('user-agent-override');
enhancedPuppeteer.use(solverStealthPlugin);

export type SolverSession = {
  browser: Browser;
  page: Page;
  cdpUrl: string;
  pid: number;
  profile: ProfileInfo;
  close: () => Promise<void>;
  disconnect: () => Promise<void>;
};

const AUTO_CDP_PORT = 0;
const CDP_DISCOVERY_TIMEOUT_MS = 30_000;
const CDP_DISCOVERY_INTERVAL_MS = 500;
const BROWSER_CLOSE_TIMEOUT_MS = 1_000;
const EXTRA_PAGE_CLOSE_TIMEOUT_MS = 250;
const INTERCEPTED_PAGES = new WeakSet<Page>();
const LINUX_CI_CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
];
const MAC_CHROME_ARGS = ['--use-mock-keychain'];
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
];

export async function launchSolver(
  profile: ProfileInfo,
  opts?: LaunchOptions
): Promise<SolverSession> {
  const fp = withWindowSize(profile.fingerprint, opts?.windowSize);
  const cdpPort = opts?.cdpPort ?? AUTO_CDP_PORT;
  const executablePath = resolveChromeExecutable(opts?.executablePath);
  const chromeProcess = spawnChromeProcess(
    executablePath,
    profile,
    fp,
    cdpPort,
    opts?.windowSize,
    opts?.headless,
    undefined
  );

  try {
    const cdpUrl = await discoverCdpUrl({
      requestedPort: opts?.cdpPort,
      userDataDir: profile.userDataDir,
      chromeProcess,
    });
    if (!cdpUrl) {
      throw buildCdpDiscoveryError(chromeProcess, opts?.cdpPort, profile.userDataDir);
    }

    const browser = await connectToBrowser(cdpUrl, opts?.stealth);

    let page: Page;
    if (opts?.url) {
      page = await createConfiguredPage(browser, fp);
      page = await navigateConfiguredPage(browser, page, fp, opts.url);
    } else {
      page = await createConfiguredPage(browser, fp);
    }

    await closeLaunchLeftoverPages(browser, page);

    return {
      browser,
      page,
      cdpUrl,
      pid: chromeProcess.pid,
      profile,
      close: async () => {
        try {
          await closeBrowserWithinTimeout(browser, BROWSER_CLOSE_TIMEOUT_MS);
        } finally {
          terminateProcessGroup(chromeProcess.pid);
        }
      },
      disconnect: async () => {
        await browser.disconnect();
      },
    };
  } catch (error) {
    terminateProcessGroup(chromeProcess.pid);
    throw error;
  }
}

async function connectToBrowser(
  browserWSEndpoint: string,
  stealth: boolean | undefined
): Promise<Browser> {
  if (stealth === false) {
    return connectPuppeteer({ browserWSEndpoint });
  }

  return enhancedPuppeteer.connect({ browserWSEndpoint });
}

async function discoverCdpUrl(options: {
  requestedPort?: number;
  userDataDir: string;
  chromeProcess?: ChildProcess;
}): Promise<string | null> {
  const deadline = Date.now() + CDP_DISCOVERY_TIMEOUT_MS;
  const activePortPath = path.join(options.userDataDir, 'DevToolsActivePort');

  while (Date.now() < deadline) {
    if (typeof options.requestedPort === 'number') {
      const cdpUrl = await discoverCdpUrlOnPort(options.requestedPort);
      if (cdpUrl) {
        return cdpUrl;
      }
    } else {
      const activePort = readDevToolsActivePort(activePortPath);
      const discoveredViaActivePort = await discoverCdpUrlFromActivePort(activePort);
      if (discoveredViaActivePort) {
        return discoveredViaActivePort;
      }
    }

    if (typeof options.chromeProcess?.exitCode === 'number' || options.chromeProcess?.signalCode) {
      break;
    }

    await sleep(CDP_DISCOVERY_INTERVAL_MS);
  }

  return null;
}

async function closeBrowserWithinTimeout(browser: Browser, timeoutMs: number): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  await Promise.race([
    // Prefer Browser.close so puppeteer-extra can finish target shutdown hooks
    // before we force-kill the owned Chrome process on slow CI runners.
    browser
      .close()
      .catch(() => {}),
    new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, timeoutMs);
    }),
  ]);

  if (timeoutId) {
    clearTimeout(timeoutId);
  }
}

async function closeLaunchLeftoverPages(browser: Browser, activePage: Page): Promise<void> {
  const allPages = await browser.pages();
  for (const candidate of allPages) {
    if (candidate === activePage || !isCloseableLaunchLeftover(candidate.url())) {
      continue;
    }

    await closePageWithinTimeout(candidate, EXTRA_PAGE_CLOSE_TIMEOUT_MS);
  }
}

function isCloseableLaunchLeftover(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === 'about:blank' ||
    normalized === 'chrome://newtab/' ||
    normalized === 'chrome://new-tab-page/' ||
    normalized === 'chrome://newtab'
  );
}

async function closePageWithinTimeout(page: Page, timeoutMs: number): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  await Promise.race([
    page.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, timeoutMs);
    }),
  ]);

  if (timeoutId) {
    clearTimeout(timeoutId);
  }
}

async function discoverCdpUrlOnPort(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!res.ok) {
      return null;
    }
    const json = (await res.json()) as { webSocketDebuggerUrl?: string };
    return json.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

async function discoverCdpUrlFromActivePort(
  activePort: ReturnType<typeof readDevToolsActivePort>
): Promise<string | null> {
  if (!activePort) {
    return null;
  }

  const candidatePorts = new Set<number>();
  if (activePort.browserWSEndpoint) {
    const wsPort = portFromBrowserWSEndpoint(activePort.browserWSEndpoint);
    if (wsPort) {
      candidatePorts.add(wsPort);
    }
  }
  if (activePort.port > 0) {
    candidatePorts.add(activePort.port);
  }

  for (const port of candidatePorts) {
    const cdpUrl = await discoverCdpUrlOnPort(port);
    if (cdpUrl) {
      return cdpUrl;
    }
  }

  return null;
}

function portFromBrowserWSEndpoint(browserWSEndpoint: string): number | null {
  try {
    const url = new URL(browserWSEndpoint);
    const port = Number(url.port);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function readDevToolsActivePort(activePortPath: string): {
  port: number;
  browserWSEndpoint?: string;
} | null {
  if (!existsSync(activePortPath)) {
    return null;
  }

  try {
    const raw = readFileSync(activePortPath, 'utf-8').trim();
    if (!raw) {
      return null;
    }

    const [portLine = '', wsPathLine = ''] = raw.split(/\r?\n/, 2);
    const port = Number(portLine.trim());
    if (!Number.isFinite(port) || port <= 0) {
      return null;
    }

    const wsPath = wsPathLine.trim();
    return {
      port,
      browserWSEndpoint: wsPath
        ? wsPath.startsWith('ws://')
          ? wsPath
          : `ws://127.0.0.1:${port}${wsPath.startsWith('/') ? wsPath : `/${wsPath}`}`
        : undefined,
    };
  } catch {
    return null;
  }
}

function buildCdpDiscoveryError(
  chromeProcess: ChildProcess,
  requestedPort: number | undefined,
  userDataDir: string
): Error {
  const details = [`pid ${chromeProcess.pid ?? 'unknown'}`];
  if (typeof chromeProcess.exitCode === 'number') {
    details.push(`exitCode ${chromeProcess.exitCode}`);
  }
  if (chromeProcess.signalCode) {
    details.push(`signal ${chromeProcess.signalCode}`);
  }

  if (typeof requestedPort === 'number') {
    return new Error(
      `Chrome launched but CDP not reachable on port ${requestedPort} within ${CDP_DISCOVERY_TIMEOUT_MS}ms (${details.join(', ')}).`
    );
  }

  return new Error(
    `Chrome launched but CDP not reachable via auto discovery within ${CDP_DISCOVERY_TIMEOUT_MS}ms (${details.join(', ')}). Checked ${path.join(userDataDir, 'DevToolsActivePort')}.`
  );
}

async function createConfiguredPage(browser: Browser, fp: BrowserFingerprint): Promise<Page> {
  const page = await browser.newPage();
  await installTurnstileApiInterception(page);
  await applyFingerprint(page, fp);

  if (fp.proxy?.username && fp.proxy.password) {
    await page.authenticate({
      username: fp.proxy.username,
      password: fp.proxy.password,
    });
  }

  return page;
}

async function installTurnstileApiInterception(page: Page): Promise<void> {
  if (INTERCEPTED_PAGES.has(page)) {
    return;
  }

  await page.setRequestInterception(true);
  page.on('request', (request) => {
    void (async () => {
      try {
        if (isTurnstileApiRequest(request.url())) {
          await request.respond({
            status: 200,
            contentType: 'application/javascript',
            headers: {
              'access-control-allow-origin': '*',
              'cross-origin-resource-policy': 'cross-origin',
              'cache-control': 'no-store',
            },
            body: buildTurnstileApiShimSource(request.url()),
          });
          return;
        }

        await request.continue();
      } catch {
        try {
          await request.continue();
        } catch {
          // Ignore navigations or already-handled requests.
        }
      }
    })();
  });
  INTERCEPTED_PAGES.add(page);
}

async function navigateConfiguredPage(
  browser: Browser,
  page: Page,
  fp: BrowserFingerprint,
  url: string
): Promise<Page> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return page;
  } catch (err) {
    if (!isDetachedFrameError(err)) {
      throw err;
    }
  }

  // Chrome may recycle the initial page during startup; retry on a fresh page once.
  try {
    if (!page.isClosed()) {
      await page.close({ runBeforeUnload: false });
    }
  } catch {
    // Ignore close failures for detached/closed pages.
  }

  const retryPage = await createConfiguredPage(browser, fp);
  await retryPage.goto(url, { waitUntil: 'domcontentloaded' });
  return retryPage;
}

function isDetachedFrameError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes('detached frame');
}

function resolveChromeExecutable(explicitPath?: string): string {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`Chrome executable does not exist: ${explicitPath}`);
    }
    return explicitPath;
  }

  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  for (const chromePath of CHROME_PATHS) {
    if (existsSync(chromePath)) return chromePath;
  }

  throw new Error(
    `Chrome executable not found. Set CHROME_PATH or pass executablePath explicitly. Checked: ${CHROME_PATHS.join(', ')}`
  );
}

function spawnChromeProcess(
  executablePath: string,
  profile: ProfileInfo,
  fp: BrowserFingerprint,
  cdpPort: number,
  windowSize?: { width: number; height: number },
  headless?: boolean,
  url?: string
): RunningChromeProcess {
  mkdirSync(profile.userDataDir, { recursive: true });
  const width = windowSize?.width ?? fp.viewport.width;
  const height = windowSize?.height ?? fp.viewport.height;

  const args = [
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile.userDataDir}`,
    `--window-size=${width},${height}`,
    `--user-agent=${fp.userAgent}`,
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ];

  args.push(...chromeArgsForEnvironment());

  if (headless) {
    args.push('--headless=new');
  }

  if (fp.proxy?.server) {
    args.push(`--proxy-server=${fp.proxy.server}`);
  }

  if (url) {
    args.push(url);
  }

  const proc = spawn(executablePath, args, {
    stdio: 'ignore',
    detached: true,
    env: process.env,
    cwd: path.join(os.homedir()),
  });

  proc.unref();

  if (!proc.pid) {
    throw new Error('Failed to launch Chrome process');
  }

  return proc as RunningChromeProcess;
}

export function chromeArgsForEnvironment(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const isLinuxCi = platform === 'linux' && (env.CI === 'true' || env.GITHUB_ACTIONS === 'true');
  if (platform === 'darwin') {
    return [...MAC_CHROME_ARGS];
  }

  return isLinuxCi ? [...LINUX_CI_CHROME_ARGS] : [];
}

function terminateProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM');
    return;
  } catch {
    // Fall back to killing a single process.
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Ignore already terminated process.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withWindowSize(
  fingerprint: BrowserFingerprint,
  windowSize?: { width: number; height: number }
): BrowserFingerprint {
  if (!windowSize) return fingerprint;

  const width = Math.max(800, Math.floor(windowSize.width));
  const height = Math.max(600, Math.floor(windowSize.height));
  const viewportHeight = Math.max(500, Math.min(height - 80, height));

  return {
    ...fingerprint,
    viewport: {
      width,
      height: viewportHeight,
    },
    screen: {
      ...fingerprint.screen,
      width,
      height,
    },
  };
}

async function applyFingerprint(page: Page, fp: BrowserFingerprint): Promise<void> {
  const client = await page.createCDPSession();

  await client.send('Network.setUserAgentOverride', {
    userAgent: fp.userAgent,
    platform: fp.platform,
    acceptLanguage: fp.locale,
  });

  await page.setViewport({
    width: fp.viewport.width,
    height: fp.viewport.height,
  });

  await page.emulateTimezone(fp.timezone);

  await page.evaluateOnNewDocument(
    (fingerprint: {
      webglVendor: string;
      webglRenderer: string;
      hardwareConcurrency: number;
      deviceMemory: number;
      screen: { width: number; height: number; colorDepth: number };
    }) => {
      const win = window as unknown as Record<string, unknown>;
      const callbacksKey = '__agentbrowseTurnstileCallbacks';
      const challengesKey = '__agentbrowseTurnstileChallenges';
      const stateKey = '__agentbrowseTurnstileState';

      if (!Array.isArray(win[challengesKey])) {
        win[challengesKey] = [];
      }
      if (!win[callbacksKey] || typeof win[callbacksKey] !== 'object') {
        win[callbacksKey] = {};
      }
      if (!win[stateKey] || typeof win[stateKey] !== 'object') {
        win[stateKey] = { nextCallbackId: 1 };
      }

      let turnstileValue = win.turnstile;
      if (turnstileValue && typeof turnstileValue === 'object') {
        const turnstile = turnstileValue as {
          render?: (container: unknown, options: Record<string, unknown>) => unknown;
          __agentbrowseWrapped?: boolean;
        };
        if (typeof turnstile.render === 'function' && !turnstile.__agentbrowseWrapped) {
          const originalRender = turnstile.render.bind(turnstile);
          turnstile.render = (container: unknown, options: Record<string, unknown>) => {
            const state = win[stateKey] as { nextCallbackId?: number };
            const callbacks = win[callbacksKey] as Record<string, unknown>;
            const challenges = win[challengesKey] as Array<Record<string, string>>;

            const callbackId =
              typeof options?.callback === 'function'
                ? `cf-turnstile-callback-${state.nextCallbackId ?? 1}`
                : '';
            if (callbackId) {
              callbacks[callbackId] = options.callback;
              state.nextCallbackId = (state.nextCallbackId ?? 1) + 1;
            }

            const siteKey =
              typeof options?.sitekey === 'string'
                ? options.sitekey
                : typeof options?.siteKey === 'string'
                  ? options.siteKey
                  : '';
            if (siteKey) {
              challenges.push({
                siteKey,
                action: typeof options?.action === 'string' ? options.action : '',
                cData: typeof options?.cData === 'string' ? options.cData : '',
                chlPageData: typeof options?.chlPageData === 'string' ? options.chlPageData : '',
                callbackId,
                userAgent: navigator.userAgent,
              });
            }

            return originalRender(container, options);
          };
          turnstile.__agentbrowseWrapped = true;
        } else {
          let renderValue = turnstile.render;
          try {
            Object.defineProperty(turnstile, 'render', {
              configurable: true,
              enumerable: true,
              get: () => renderValue,
              set: (value) => {
                if (typeof value !== 'function') {
                  renderValue = value as typeof renderValue;
                  return;
                }

                const originalRender = value.bind(turnstile);
                renderValue = (container: unknown, options: Record<string, unknown>) => {
                  const state = win[stateKey] as { nextCallbackId?: number };
                  const callbacks = win[callbacksKey] as Record<string, unknown>;
                  const challenges = win[challengesKey] as Array<Record<string, string>>;

                  const callbackId =
                    typeof options?.callback === 'function'
                      ? `cf-turnstile-callback-${state.nextCallbackId ?? 1}`
                      : '';
                  if (callbackId) {
                    callbacks[callbackId] = options.callback;
                    state.nextCallbackId = (state.nextCallbackId ?? 1) + 1;
                  }

                  const siteKey =
                    typeof options?.sitekey === 'string'
                      ? options.sitekey
                      : typeof options?.siteKey === 'string'
                        ? options.siteKey
                        : '';
                  if (siteKey) {
                    challenges.push({
                      siteKey,
                      action: typeof options?.action === 'string' ? options.action : '',
                      cData: typeof options?.cData === 'string' ? options.cData : '',
                      chlPageData:
                        typeof options?.chlPageData === 'string' ? options.chlPageData : '',
                      callbackId,
                      userAgent: navigator.userAgent,
                    });
                  }

                  return originalRender(container, options);
                };
                turnstile.__agentbrowseWrapped = true;
              },
            });
          } catch {
            // Ignore non-configurable render properties.
          }
        }
      }
      try {
        Object.defineProperty(win, 'turnstile', {
          configurable: true,
          enumerable: true,
          get: () => turnstileValue,
          set: (value) => {
            turnstileValue = value;
            if (!value || typeof value !== 'object') return;
            const turnstile = value as {
              render?: (container: unknown, options: Record<string, unknown>) => unknown;
              __agentbrowseWrapped?: boolean;
            };
            if (typeof turnstile.render !== 'function' || turnstile.__agentbrowseWrapped) {
              let renderValue = turnstile.render;
              try {
                Object.defineProperty(turnstile, 'render', {
                  configurable: true,
                  enumerable: true,
                  get: () => renderValue,
                  set: (nextValue) => {
                    if (typeof nextValue !== 'function') {
                      renderValue = nextValue as typeof renderValue;
                      return;
                    }

                    const originalRender = nextValue.bind(turnstile);
                    renderValue = (container: unknown, options: Record<string, unknown>) => {
                      const state = win[stateKey] as { nextCallbackId?: number };
                      const callbacks = win[callbacksKey] as Record<string, unknown>;
                      const challenges = win[challengesKey] as Array<Record<string, string>>;

                      const callbackId =
                        typeof options?.callback === 'function'
                          ? `cf-turnstile-callback-${state.nextCallbackId ?? 1}`
                          : '';
                      if (callbackId) {
                        callbacks[callbackId] = options.callback;
                        state.nextCallbackId = (state.nextCallbackId ?? 1) + 1;
                      }

                      const siteKey =
                        typeof options?.sitekey === 'string'
                          ? options.sitekey
                          : typeof options?.siteKey === 'string'
                            ? options.siteKey
                            : '';
                      if (siteKey) {
                        challenges.push({
                          siteKey,
                          action: typeof options?.action === 'string' ? options.action : '',
                          cData: typeof options?.cData === 'string' ? options.cData : '',
                          chlPageData:
                            typeof options?.chlPageData === 'string' ? options.chlPageData : '',
                          callbackId,
                          userAgent: navigator.userAgent,
                        });
                      }

                      return originalRender(container, options);
                    };
                    turnstile.__agentbrowseWrapped = true;
                  },
                });
              } catch {
                // Ignore non-configurable render properties.
              }
              return;
            }

            const originalRender = turnstile.render.bind(turnstile);
            turnstile.render = (container: unknown, options: Record<string, unknown>) => {
              const state = win[stateKey] as { nextCallbackId?: number };
              const callbacks = win[callbacksKey] as Record<string, unknown>;
              const challenges = win[challengesKey] as Array<Record<string, string>>;

              const callbackId =
                typeof options?.callback === 'function'
                  ? `cf-turnstile-callback-${state.nextCallbackId ?? 1}`
                  : '';
              if (callbackId) {
                callbacks[callbackId] = options.callback;
                state.nextCallbackId = (state.nextCallbackId ?? 1) + 1;
              }

              const siteKey =
                typeof options?.sitekey === 'string'
                  ? options.sitekey
                  : typeof options?.siteKey === 'string'
                    ? options.siteKey
                    : '';
              if (siteKey) {
                challenges.push({
                  siteKey,
                  action: typeof options?.action === 'string' ? options.action : '',
                  cData: typeof options?.cData === 'string' ? options.cData : '',
                  chlPageData: typeof options?.chlPageData === 'string' ? options.chlPageData : '',
                  callbackId,
                  userAgent: navigator.userAgent,
                });
              }

              return originalRender(container, options);
            };
            turnstile.__agentbrowseWrapped = true;
          },
        });
      } catch {
        const fallbackTurnstile = win.turnstile;
        if (fallbackTurnstile && typeof fallbackTurnstile === 'object') {
          const turnstile = fallbackTurnstile as {
            render?: (container: unknown, options: Record<string, unknown>) => unknown;
            __agentbrowseWrapped?: boolean;
          };
          if (typeof turnstile.render === 'function' && !turnstile.__agentbrowseWrapped) {
            const originalRender = turnstile.render.bind(turnstile);
            turnstile.render = (container: unknown, options: Record<string, unknown>) => {
              const state = win[stateKey] as { nextCallbackId?: number };
              const callbacks = win[callbacksKey] as Record<string, unknown>;
              const challenges = win[challengesKey] as Array<Record<string, string>>;

              const callbackId =
                typeof options?.callback === 'function'
                  ? `cf-turnstile-callback-${state.nextCallbackId ?? 1}`
                  : '';
              if (callbackId) {
                callbacks[callbackId] = options.callback;
                state.nextCallbackId = (state.nextCallbackId ?? 1) + 1;
              }

              const siteKey =
                typeof options?.sitekey === 'string'
                  ? options.sitekey
                  : typeof options?.siteKey === 'string'
                    ? options.siteKey
                    : '';
              if (siteKey) {
                challenges.push({
                  siteKey,
                  action: typeof options?.action === 'string' ? options.action : '',
                  cData: typeof options?.cData === 'string' ? options.cData : '',
                  chlPageData: typeof options?.chlPageData === 'string' ? options.chlPageData : '',
                  callbackId,
                  userAgent: navigator.userAgent,
                });
              }

              return originalRender(container, options);
            };
            turnstile.__agentbrowseWrapped = true;
          } else if (!turnstile.__agentbrowseWrapped) {
            let renderValue = turnstile.render;
            try {
              Object.defineProperty(turnstile, 'render', {
                configurable: true,
                enumerable: true,
                get: () => renderValue,
                set: (value) => {
                  if (typeof value !== 'function') {
                    renderValue = value as typeof renderValue;
                    return;
                  }

                  const originalRender = value.bind(turnstile);
                  renderValue = (container: unknown, options: Record<string, unknown>) => {
                    const state = win[stateKey] as { nextCallbackId?: number };
                    const callbacks = win[callbacksKey] as Record<string, unknown>;
                    const challenges = win[challengesKey] as Array<Record<string, string>>;

                    const callbackId =
                      typeof options?.callback === 'function'
                        ? `cf-turnstile-callback-${state.nextCallbackId ?? 1}`
                        : '';
                    if (callbackId) {
                      callbacks[callbackId] = options.callback;
                      state.nextCallbackId = (state.nextCallbackId ?? 1) + 1;
                    }

                    const siteKey =
                      typeof options?.sitekey === 'string'
                        ? options.sitekey
                        : typeof options?.siteKey === 'string'
                          ? options.siteKey
                          : '';
                    if (siteKey) {
                      challenges.push({
                        siteKey,
                        action: typeof options?.action === 'string' ? options.action : '',
                        cData: typeof options?.cData === 'string' ? options.cData : '',
                        chlPageData:
                          typeof options?.chlPageData === 'string' ? options.chlPageData : '',
                        callbackId,
                        userAgent: navigator.userAgent,
                      });
                    }

                    return originalRender(container, options);
                  };
                  turnstile.__agentbrowseWrapped = true;
                },
              });
            } catch {
              // Ignore non-configurable render properties.
            }
          }
        }
      }

      const pollId = window.setInterval(() => {
        const candidate = (window as unknown as Record<string, unknown>).turnstile;
        if (!candidate || typeof candidate !== 'object') return;
        const turnstile = candidate as {
          render?: (container: unknown, options: Record<string, unknown>) => unknown;
          __agentbrowseWrapped?: boolean;
        };
        if (typeof turnstile.render !== 'function' || turnstile.__agentbrowseWrapped) {
          return;
        }

        const originalRender = turnstile.render.bind(turnstile);
        turnstile.render = (container: unknown, options: Record<string, unknown>) => {
          const state = win[stateKey] as { nextCallbackId?: number };
          const callbacks = win[callbacksKey] as Record<string, unknown>;
          const challenges = win[challengesKey] as Array<Record<string, string>>;

          const callbackId =
            typeof options?.callback === 'function'
              ? `cf-turnstile-callback-${state.nextCallbackId ?? 1}`
              : '';
          if (callbackId) {
            callbacks[callbackId] = options.callback;
            state.nextCallbackId = (state.nextCallbackId ?? 1) + 1;
          }

          const siteKey =
            typeof options?.sitekey === 'string'
              ? options.sitekey
              : typeof options?.siteKey === 'string'
                ? options.siteKey
                : '';
          if (siteKey) {
            challenges.push({
              siteKey,
              action: typeof options?.action === 'string' ? options.action : '',
              cData: typeof options?.cData === 'string' ? options.cData : '',
              chlPageData: typeof options?.chlPageData === 'string' ? options.chlPageData : '',
              callbackId,
              userAgent: navigator.userAgent,
            });
          }

          return originalRender(container, options);
        };
        turnstile.__agentbrowseWrapped = true;
      }, 50);
      window.setTimeout(() => {
        window.clearInterval(pollId);
      }, 30_000);

      try {
        if (typeof WebGLRenderingContext !== 'undefined') {
          const getParameter = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function (parameter: number) {
            const UNMASKED_VENDOR = 0x9245;
            const UNMASKED_RENDERER = 0x9246;
            if (parameter === UNMASKED_VENDOR) return fingerprint.webglVendor;
            if (parameter === UNMASKED_RENDERER) return fingerprint.webglRenderer;
            return getParameter.call(this, parameter);
          };
        }
      } catch {
        // Some environments block prototype patching; keep the turnstile hook alive.
      }

      try {
        Object.defineProperty(navigator, 'hardwareConcurrency', {
          get: () => fingerprint.hardwareConcurrency,
        });
      } catch {
        // Ignore non-configurable navigator fields.
      }

      try {
        Object.defineProperty(navigator, 'deviceMemory', {
          get: () => fingerprint.deviceMemory,
        });
      } catch {
        // Ignore non-configurable navigator fields.
      }

      try {
        Object.defineProperty(screen, 'width', { get: () => fingerprint.screen.width });
        Object.defineProperty(screen, 'height', { get: () => fingerprint.screen.height });
        Object.defineProperty(screen, 'colorDepth', { get: () => fingerprint.screen.colorDepth });
      } catch {
        // Ignore non-configurable screen fields.
      }
    },
    {
      webglVendor: fp.webglVendor,
      webglRenderer: fp.webglRenderer,
      hardwareConcurrency: fp.hardwareConcurrency,
      deviceMemory: fp.deviceMemory,
      screen: fp.screen,
    }
  );

  await client.detach();
}
