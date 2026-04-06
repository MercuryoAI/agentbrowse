/**
 * Standalone library persistence adapter for `~/.agentbrowse`.
 *
 * Product CLIs override this through their own shared-home wiring. The library
 * keeps this adapter only for direct `@mercuryo-ai/agentbrowse` usage outside the
 * product shells.
 */

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
import {
  buildAttachedSession,
  buildOwnedSession,
  deleteBrowserSession,
  getSessionPort,
  isAttachedSession,
  isOwnedSession,
  isSessionAlive,
  loadBrowserSession,
  resolveBrowserSessionId,
  saveBrowserSession,
  serializeBrowserSession,
  supportsCaptchaSolve,
  type BrowserSessionState,
  type BrowserSessionCapabilities,
  type BrowseSessionIdentity,
  type BrowseSessionTransport,
} from './browser-session-state.js';
import {
  buildWorkflowContextForPersistence,
  cacheTransientSecret,
  canHydrateWorkflowContext,
  cleanupTransientSecretCache,
  deleteCachedTransientSecret,
  getCachedTransientSecret,
  type BrowseWorkflowContext,
  type CachedTransientSecretEntry,
} from './workflow-session-state.js';

function getSessionDir(): string {
  return join(homedir(), '.agentbrowse');
}
function getWorkflowContextPath(): string {
  return join(getSessionDir(), 'browse-workflow.json');
}

export interface BrowseSession extends BrowserSessionState, BrowseWorkflowContext {}

export {
  buildAttachedSession,
  buildOwnedSession,
  buildWorkflowContextForPersistence,
  cacheTransientSecret,
  canHydrateWorkflowContext,
  cleanupTransientSecretCache,
  deleteCachedTransientSecret,
  getCachedTransientSecret,
  getSessionPort,
  isAttachedSession,
  isOwnedSession,
  isSessionAlive,
  resolveBrowserSessionId,
  serializeBrowserSession,
  supportsCaptchaSolve,
};
export type {
  BrowserSessionCapabilities,
  BrowserSessionState,
  BrowseSessionIdentity,
  BrowseSessionTransport,
  BrowseWorkflowContext,
  CachedTransientSecretEntry,
};

function ensureDir(): void {
  const sessionDir = getSessionDir();
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
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

function splitSessionForPersistence(session: BrowseSession): {
  browserSession: BrowserSessionState;
  workflowContext: BrowseWorkflowContext | null;
} {
  const {
    browserSessionId,
    activeRunId,
    intentSessionId,
    currentRequestId,
    lastKnownStatus,
    lastEventSeq,
    transientSecretCache,
    ...browserSession
  } = session;
  const resolvedBrowserSessionId = browserSessionId ?? resolveBrowserSessionId(browserSession);
  const workflowContext = buildWorkflowContextForPersistence(
    {
      browserSessionId,
      activeRunId,
      intentSessionId,
      currentRequestId,
      lastKnownStatus,
      lastEventSeq,
      transientSecretCache,
    },
    resolvedBrowserSessionId
  );

  return {
    browserSession: browserSession as BrowserSessionState,
    workflowContext,
  };
}

function serializeWorkflowContext(context: BrowseWorkflowContext): string {
  return JSON.stringify(context, null, 2);
}

function loadWorkflowContext(): BrowseWorkflowContext | null {
  const workflowContextPath = getWorkflowContextPath();
  if (!existsSync(workflowContextPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(workflowContextPath, 'utf-8')) as BrowseWorkflowContext;
  } catch {
    return null;
  }
}

export function deleteWorkflowContext(): void {
  const workflowContextPath = getWorkflowContextPath();
  if (existsSync(workflowContextPath)) {
    unlinkSync(workflowContextPath);
  }
}

export function serializeSession(session: BrowseSession): string {
  return serializeBrowserSession(splitSessionForPersistence(session).browserSession);
}

export function saveSession(session: BrowseSession): void {
  ensureDir();
  const { browserSession, workflowContext } = splitSessionForPersistence(session);
  const workflowContextPath = getWorkflowContextPath();
  saveBrowserSession(browserSession);
  if (workflowContext) {
    atomicWriteJson(workflowContextPath, serializeWorkflowContext(workflowContext));
  } else if (existsSync(workflowContextPath)) {
    unlinkSync(workflowContextPath);
  }
}

export function loadSession(): BrowseSession | null {
  const browserSession = loadBrowserSession();
  if (!browserSession) {
    return null;
  }

  try {
    const workflowContext = loadWorkflowContext();
    const resolvedBrowserSessionId = resolveBrowserSessionId(browserSession);
    const session = {
      ...browserSession,
      ...(workflowContext && canHydrateWorkflowContext(resolvedBrowserSessionId, workflowContext)
        ? workflowContext
        : {}),
    } as BrowseSession;
    if (workflowContext && !canHydrateWorkflowContext(resolvedBrowserSessionId, workflowContext)) {
      saveSession(browserSession);
    }
    const changed = cleanupTransientSecretCache(session);
    if (changed) {
      saveSession(session);
    }
    return session;
  } catch {
    return null;
  }
}

export function deleteSession(): void {
  deleteBrowserSession();
  deleteWorkflowContext();
}
