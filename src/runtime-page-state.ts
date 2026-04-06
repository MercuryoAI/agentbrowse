import type { BrowserSessionState } from './browser-session-state.js';
import { ensureRuntimeState, type BrowsePageState } from './runtime-state.js';

export function registerPage(
  session: BrowserSessionState,
  page: Partial<Omit<BrowsePageState, 'pageRef' | 'createdAt' | 'updatedAt'>> & {
    pageRef?: string;
    makeCurrent?: boolean;
  } = {}
): BrowsePageState {
  const runtime = ensureRuntimeState(session);
  const pageRef = page.pageRef ?? `p${runtime.counters.nextPage++}`;
  const now = new Date().toISOString();
  const existing = runtime.pages[pageRef];

  const nextPage: BrowsePageState = {
    pageRef,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    url: page.url ?? existing?.url,
    title: page.title ?? existing?.title,
    targetId: page.targetId ?? existing?.targetId,
    openerPageRef: page.openerPageRef ?? existing?.openerPageRef,
    scopeEpoch: existing?.scopeEpoch ?? 0,
  };

  runtime.pages[pageRef] = nextPage;
  if (page.makeCurrent !== false) {
    runtime.currentPageRef = pageRef;
  }
  return nextPage;
}

export function updatePage(
  session: BrowserSessionState,
  pageRef: string,
  patch: Partial<Omit<BrowsePageState, 'pageRef' | 'createdAt' | 'updatedAt'>>
): BrowsePageState {
  const runtime = ensureRuntimeState(session);
  const current = runtime.pages[pageRef];
  if (!current) {
    throw new Error(`unknown_page_ref: ${pageRef}`);
  }

  const nextPage: BrowsePageState = {
    ...current,
    ...patch,
    scopeEpoch: patch.scopeEpoch ?? current.scopeEpoch ?? 0,
    updatedAt: new Date().toISOString(),
  };
  runtime.pages[pageRef] = nextPage;
  return nextPage;
}

export function getPageScopeEpoch(session: BrowserSessionState, pageRef: string): number {
  const runtime = ensureRuntimeState(session);
  return runtime.pages[pageRef]?.scopeEpoch ?? 0;
}

export function bumpPageScopeEpoch(session: BrowserSessionState, pageRef: string): number {
  const runtime = ensureRuntimeState(session);
  const current = runtime.pages[pageRef];
  if (!current) {
    throw new Error(`unknown_page_ref: ${pageRef}`);
  }

  const nextEpoch = (current.scopeEpoch ?? 0) + 1;
  runtime.pages[pageRef] = {
    ...current,
    scopeEpoch: nextEpoch,
    updatedAt: new Date().toISOString(),
  };
  return nextEpoch;
}

export function setCurrentPage(session: BrowserSessionState, pageRef: string): void {
  const runtime = ensureRuntimeState(session);
  if (!runtime.pages[pageRef]) {
    throw new Error(`unknown_page_ref: ${pageRef}`);
  }
  runtime.currentPageRef = pageRef;
}
