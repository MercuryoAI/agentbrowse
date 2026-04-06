import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BrowseRuntimeState } from './runtime-state.js';
import { scrubProtectedExactValues } from './secrets/protected-exact-value-redaction.js';
import type { ProxyConfig } from './solver/types.js';

/** Browser capabilities discovered or provisioned for the session. */
export interface BrowserSessionCapabilities {
  captchaSolve?: boolean;
}

/** Persisted browser session state shared across AgentBrowse commands. */
export interface BrowserSessionState {
  cdpUrl: string;
  pid?: number;
  launchedAt: string;
  port?: number;
  profile?: string;
  identity?: BrowseSessionIdentity;
  transport?: BrowseSessionTransport;
  capabilities?: BrowserSessionCapabilities;
  runtime?: BrowseRuntimeState;
}

/** Browser session state plus transient run-scoped metadata. */
export interface BrowserCommandSession extends BrowserSessionState {
  activeRunId?: string;
}

/** Stable identity metadata for an attached or owned browser session. */
export interface BrowseSessionIdentity {
  browserInstanceRef: string;
  endpoint: string;
  pid?: number;
  profile?: string;
  provider?: string;
  launchedAt: string;
  ownership: 'agentbrowse' | 'external';
}

/** Transport metadata for the attached browser connection. */
export interface BrowseSessionTransport {
  proxyMode: 'direct' | 'proxy';
  proxy?: ProxyConfig;
}

/** Filesystem-backed session store used by the CLI and local wrappers. */
export interface BrowserSessionStore {
  readonly rootDir: string;
  readonly sessionPath: string;
  serialize(session: BrowserSessionState): string;
  save(session: BrowserSessionState): void;
  load(): BrowserSessionState | null;
  delete(): void;
}

const BLOCKED_SESSION_KEYS = new Set([
  'rawValue',
  'rawValues',
  'secretValue',
  'secretValues',
  'resolvedValues',
  'protectedValues',
]);

type BrowserVersionResponse = {
  webSocketDebuggerUrl?: string;
};

type ManagedSessionIdentityInput = {
  cdpUrl: string;
  pid: number;
  profile?: string;
  launchedAt: string;
};

type AttachedSessionIdentityInput = {
  cdpUrl: string;
  launchedAt: string;
  browserInstanceRef?: string;
  provider?: string;
};

type ManagedBrowserSessionInput = Omit<
  BrowserSessionState,
  'port' | 'identity' | 'pid' | 'capabilities'
> & {
  pid: number;
  capabilities?: BrowserSessionCapabilities;
};

type AttachedBrowserSessionInput = Omit<
  BrowserSessionState,
  'port' | 'identity' | 'pid' | 'profile' | 'capabilities'
> & {
  capabilities?: BrowserSessionCapabilities;
  browserInstanceRef?: string;
  provider?: string;
};

function getDefaultAgentbrowseStateDir(): string {
  return join(homedir(), '.agentbrowse');
}

function getBrowserSessionPath(stateDir: string, sessionFileName: string): string {
  return join(stateDir, sessionFileName);
}

function ensureStateDir(stateDir: string): void {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

function atomicWriteJson(path: string, contents: string): void {
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, contents);
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function parseSessionPort(cdpUrl: string): number | undefined {
  try {
    const url = new URL(cdpUrl);
    if (!url.port) {
      return undefined;
    }

    const port = Number(url.port);
    return Number.isFinite(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** Converts a CDP websocket or HTTP endpoint into the matching DevTools HTTP endpoint. */
export function buildCdpHttpEndpointUrl(
  cdpUrl: string,
  resourcePath: '/json/version' | '/json/list' = '/json/version'
): string | null {
  try {
    const url = new URL(cdpUrl);
    if (url.protocol === 'ws:') {
      url.protocol = 'http:';
    } else if (url.protocol === 'wss:') {
      url.protocol = 'https:';
    } else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    url.pathname = resourcePath;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** Extracts a stable browser instance reference from a CDP endpoint. */
export function parseBrowserInstanceRef(cdpUrl: string): string {
  try {
    const url = new URL(cdpUrl);
    const pathSegments = url.pathname.split('/').filter(Boolean);
    return pathSegments.at(-1) ?? cdpUrl;
  } catch {
    const pathSegments = cdpUrl.split('/').filter(Boolean);
    return pathSegments.at(-1) ?? cdpUrl;
  }
}

async function probeSessionEndpoint(
  session: Pick<BrowserSessionState, 'cdpUrl' | 'port' | 'identity'>
): Promise<'match' | 'mismatch' | 'unreachable'> {
  const endpoint = session.identity?.endpoint ?? session.cdpUrl;
  const versionUrl = buildCdpHttpEndpointUrl(endpoint, '/json/version');
  if (!versionUrl) {
    return 'unreachable';
  }

  try {
    const response = await fetch(versionUrl);
    if (!response.ok) {
      return 'unreachable';
    }

    const payload = (await response.json()) as BrowserVersionResponse;
    const liveEndpoint = payload.webSocketDebuggerUrl?.trim();
    if (!liveEndpoint) {
      return 'unreachable';
    }

    const expectedEndpoint = session.identity?.endpoint ?? session.cdpUrl;
    if (liveEndpoint === expectedEndpoint) {
      return 'match';
    }

    const expectedBrowserInstanceRef =
      session.identity?.browserInstanceRef ?? parseBrowserInstanceRef(expectedEndpoint);
    return parseBrowserInstanceRef(liveEndpoint) === expectedBrowserInstanceRef
      ? 'match'
      : 'mismatch';
  } catch {
    return 'unreachable';
  }
}

/** Serializes a browser session while omitting protected value payloads. */
export function serializeBrowserSession(session: BrowserSessionState): string {
  const scrubbedSession = scrubProtectedExactValues(session, session);
  return JSON.stringify(
    scrubbedSession,
    (key, value) => {
      if (BLOCKED_SESSION_KEYS.has(key)) {
        return undefined;
      }
      return value;
    },
    2
  );
}

/** Creates the default filesystem-backed session store used by AgentBrowse. */
export function createBrowserSessionStore(
  options: {
    rootDir?: string;
    sessionFileName?: string;
  } = {}
): BrowserSessionStore {
  const rootDir = options.rootDir ?? getDefaultAgentbrowseStateDir();
  const sessionPath = getBrowserSessionPath(
    rootDir,
    options.sessionFileName?.trim() || 'browse-session.json'
  );

  return {
    rootDir,
    sessionPath,
    serialize: serializeBrowserSession,
    save(session: BrowserSessionState): void {
      ensureStateDir(rootDir);
      atomicWriteJson(sessionPath, serializeBrowserSession(session));
    },
    load(): BrowserSessionState | null {
      if (!existsSync(sessionPath)) {
        return null;
      }

      try {
        const raw = JSON.parse(readFileSync(sessionPath, 'utf-8'));
        if (!raw.cdpUrl) {
          return null;
        }

        return raw as BrowserSessionState;
      } catch {
        return null;
      }
    },
    delete(): void {
      if (existsSync(sessionPath)) {
        unlinkSync(sessionPath);
      }
    },
  };
}

/** Saves the current browser session to the default local session store. */
export function saveBrowserSession(session: BrowserSessionState): void {
  createBrowserSessionStore().save(session);
}

/** Loads the current browser session from the default local session store. */
export function loadBrowserSession(): BrowserSessionState | null {
  return createBrowserSessionStore().load();
}

/** Deletes the current browser session from the default local session store. */
export function deleteBrowserSession(): void {
  createBrowserSessionStore().delete();
}

/** Resolves a stable browser identifier for logs, tracing, and local state. */
export function resolveBrowserSessionId(
  session: Pick<BrowserSessionState, 'cdpUrl' | 'identity' | 'pid'>
): string {
  if (session.identity?.browserInstanceRef) {
    return session.identity.browserInstanceRef;
  }

  if (typeof session.pid === 'number' && Number.isFinite(session.pid) && session.pid > 0) {
    return `pid-${session.pid}`;
  }

  return `cdp-${parseBrowserInstanceRef(session.cdpUrl)}`;
}

function buildManagedSessionIdentity(session: ManagedSessionIdentityInput): BrowseSessionIdentity {
  return {
    browserInstanceRef: parseBrowserInstanceRef(session.cdpUrl),
    endpoint: session.cdpUrl,
    pid: session.pid,
    profile: session.profile,
    launchedAt: session.launchedAt,
    ownership: 'agentbrowse',
  };
}

function buildAttachedSessionIdentity(
  session: AttachedSessionIdentityInput
): BrowseSessionIdentity {
  return {
    browserInstanceRef: session.browserInstanceRef ?? parseBrowserInstanceRef(session.cdpUrl),
    endpoint: session.cdpUrl,
    ...(session.provider ? { provider: session.provider } : {}),
    launchedAt: session.launchedAt,
    ownership: 'external',
  };
}

/** Builds a managed AgentBrowse-owned browser session snapshot. */
export function buildOwnedSession(session: ManagedBrowserSessionInput): BrowserSessionState {
  return {
    ...session,
    port: parseSessionPort(session.cdpUrl),
    identity: buildManagedSessionIdentity(session),
  };
}

/** Builds an attached external browser session snapshot. */
export function buildAttachedSession(session: AttachedBrowserSessionInput): BrowserSessionState {
  return {
    ...session,
    port: parseSessionPort(session.cdpUrl),
    identity: buildAttachedSessionIdentity(session),
  };
}

/** Returns the most likely DevTools port for the current session. */
export function getSessionPort(session: BrowserSessionState | null): number {
  if (session?.port) return session.port;

  if (session?.cdpUrl) {
    const parsedPort = parseSessionPort(session.cdpUrl);
    if (parsedPort) {
      return parsedPort;
    }
  }

  return 9222;
}

/** Returns `true` when the session advertises captcha-solving capability. */
export function supportsCaptchaSolve(session: BrowserSessionState | null): boolean {
  return session?.capabilities?.captchaSolve === true;
}

/** Returns `true` when the session belongs to an AgentBrowse-managed browser. */
export function isOwnedSession(
  session: BrowserSessionState | null | undefined
): session is BrowserSessionState & { identity: BrowseSessionIdentity } {
  if (!session?.identity) {
    return false;
  }

  if (session.identity.ownership !== 'agentbrowse') {
    return false;
  }

  return (
    typeof session.pid === 'number' &&
    Number.isFinite(session.pid) &&
    session.identity.endpoint === session.cdpUrl &&
    session.identity.pid === session.pid &&
    session.identity.launchedAt === session.launchedAt &&
    session.identity.browserInstanceRef.length > 0 &&
    session.identity.profile === session.profile
  );
}

/** Returns `true` when the session refers to an externally managed browser. */
export function isAttachedSession(
  session: BrowserSessionState | null | undefined
): session is BrowserSessionState & { identity: BrowseSessionIdentity } {
  if (!session?.identity) {
    return false;
  }

  return (
    session.identity.ownership === 'external' &&
    session.identity.endpoint === session.cdpUrl &&
    session.identity.launchedAt === session.launchedAt &&
    session.identity.browserInstanceRef.length > 0
  );
}

/** Checks whether the persisted browser session still points to a live browser instance. */
export async function isSessionAlive(session: BrowserSessionState): Promise<boolean> {
  const endpointProbe = await probeSessionEndpoint(session);
  if (endpointProbe === 'match') {
    return true;
  }
  if (endpointProbe === 'mismatch' || session.identity?.ownership === 'agentbrowse') {
    return false;
  }

  if (typeof session.pid !== 'number' || !Number.isFinite(session.pid) || session.pid <= 0) {
    return false;
  }

  try {
    process.kill(session.pid, 0);
    return true;
  } catch {
    return false;
  }
}
