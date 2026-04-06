import type { StoredSecretFieldKey } from './secrets/types.js';

export interface CachedTransientSecretEntry {
  requestId: string;
  fillRef: string;
  storedSecretRef: string;
  cachedAt: string;
  approvedAt?: string;
  expiresAt?: string;
  values: Partial<Record<StoredSecretFieldKey, string>>;
}

export interface BrowseWorkflowContext {
  browserSessionId?: string;
  activeRunId?: string;
  intentSessionId?: string;
  currentRequestId?: string;
  lastKnownStatus?: string;
  lastEventSeq?: number;
  transientSecretCache?: Record<string, CachedTransientSecretEntry>;
}

function isExpired(expiresAt: string | undefined, now: string): boolean {
  if (!expiresAt) {
    return false;
  }

  return new Date(expiresAt).getTime() <= new Date(now).getTime();
}

export function cleanupTransientSecretCache(
  session: BrowseWorkflowContext,
  options: { now?: string } = {}
): boolean {
  const cache = session.transientSecretCache;
  if (!cache) {
    return false;
  }

  const now = options.now ?? new Date().toISOString();
  let changed = false;
  for (const [requestId, entry] of Object.entries(cache)) {
    if (isExpired(entry.expiresAt, now)) {
      delete cache[requestId];
      changed = true;
    }
  }

  if (Object.keys(cache).length === 0) {
    delete session.transientSecretCache;
    changed = true;
  }

  return changed;
}

export function cacheTransientSecret(
  session: BrowseWorkflowContext,
  entry: CachedTransientSecretEntry
): CachedTransientSecretEntry {
  cleanupTransientSecretCache(session);
  const cache = (session.transientSecretCache ??= {});
  cache[entry.requestId] = {
    ...entry,
    values: { ...entry.values },
  };
  return cache[entry.requestId]!;
}

export function getCachedTransientSecret(
  session: BrowseWorkflowContext,
  requestId: string,
  options: { now?: string } = {}
): CachedTransientSecretEntry | null {
  if (cleanupTransientSecretCache(session, options)) {
    // Keep the in-memory workflow context sanitized for callers that save immediately after load.
  }

  return session.transientSecretCache?.[requestId] ?? null;
}

export function deleteCachedTransientSecret(
  session: BrowseWorkflowContext,
  requestId: string
): boolean {
  const cache = session.transientSecretCache;
  if (!cache?.[requestId]) {
    return false;
  }

  delete cache[requestId];
  if (Object.keys(cache).length === 0) {
    delete session.transientSecretCache;
  }
  return true;
}

export function buildWorkflowContextForPersistence(
  session: BrowseWorkflowContext,
  resolvedBrowserSessionId: string
): BrowseWorkflowContext | null {
  const workflowContext: BrowseWorkflowContext = {
    ...((session.activeRunId ||
      session.intentSessionId ||
      session.currentRequestId ||
      session.lastKnownStatus ||
      session.transientSecretCache) &&
    resolvedBrowserSessionId
      ? { browserSessionId: resolvedBrowserSessionId }
      : {}),
    ...(session.activeRunId ? { activeRunId: session.activeRunId } : {}),
    ...(session.intentSessionId ? { intentSessionId: session.intentSessionId } : {}),
    ...(session.currentRequestId ? { currentRequestId: session.currentRequestId } : {}),
    ...(session.lastKnownStatus ? { lastKnownStatus: session.lastKnownStatus } : {}),
    ...(typeof session.lastEventSeq === 'number' ? { lastEventSeq: session.lastEventSeq } : {}),
    ...(session.transientSecretCache ? { transientSecretCache: session.transientSecretCache } : {}),
  };

  return Object.keys(workflowContext).length > 0 ? workflowContext : null;
}

export function canHydrateWorkflowContext(
  resolvedBrowserSessionId: string,
  workflowContext: BrowseWorkflowContext
): boolean {
  return (
    !workflowContext.browserSessionId ||
    workflowContext.browserSessionId === resolvedBrowserSessionId
  );
}
