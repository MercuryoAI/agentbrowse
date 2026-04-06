import { chromium, type Browser, type Page } from 'playwright-core';
import type { BrowserSessionState } from './browser-session-state.js';
import { ensureRuntimeState } from './runtime-state.js';
import { registerPage, updatePage } from './runtime-page-state.js';

export async function connectPlaywright(cdpUrl: string): Promise<Browser> {
  return chromium.connectOverCDP(cdpUrl);
}

export async function disconnectPlaywright(browser: Browser): Promise<void> {
  const maybeClose = (browser as Browser | { close?: () => Promise<unknown> | unknown }).close;
  if (typeof maybeClose !== 'function') {
    return;
  }

  await Promise.resolve(maybeClose.call(browser)).catch(() => undefined);
}

export function listPages(browser: Browser): Page[] {
  return browser.contexts().flatMap((context) => context.pages());
}

function buildPageResolutionError(kind: 'unknown' | 'stale', pageRef: string): Error {
  return new Error(`${kind === 'unknown' ? 'unknown_page_ref' : 'stale_page_ref'}:${pageRef}`);
}

function isPageResolutionError(
  error: unknown,
  kind: 'unknown' | 'stale',
  pageRef: string
): boolean {
  return (
    error instanceof Error &&
    error.message === `${kind === 'unknown' ? 'unknown_page_ref' : 'stale_page_ref'}:${pageRef}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeComparableUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) {
    return null;
  }

  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw;
  }
}

function isMeaningfulUrl(value: string | undefined): boolean {
  const raw = value?.trim();
  return Boolean(raw && raw !== ':' && raw !== 'about:blank');
}

function isMeaningfulTitle(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

type LaunchPageMetadata = {
  page: Page | null;
  url: string;
  title: string;
  targetId?: string;
};

type SessionPageMetadata = {
  url: string;
  title: string;
  targetId?: string;
};

export type ResolvedCurrentPageContext = {
  pageRef: string;
  page: Page;
  recoveredVia?: 'opener' | 'sole-live-page';
};

function preferMeaningfulValue(
  value: string | undefined,
  fallback: string | undefined,
  predicate: (candidate: string | undefined) => boolean
): string {
  if (predicate(value)) {
    return value ?? '';
  }
  if (predicate(fallback)) {
    return fallback ?? '';
  }
  return value ?? fallback ?? '';
}

function scoreLaunchPageMetadata(
  metadata: Pick<LaunchPageMetadata, 'url' | 'title' | 'targetId'>,
  options: {
    requestedUrl?: string;
    fallbackUrl?: string;
  }
): number {
  const normalizedUrl = normalizeComparableUrl(metadata.url);
  const requestedUrl = normalizeComparableUrl(options.requestedUrl);
  const fallbackUrl = normalizeComparableUrl(options.fallbackUrl);

  let score = 0;
  if (requestedUrl && normalizedUrl === requestedUrl) {
    score += 200;
  } else if (fallbackUrl && normalizedUrl === fallbackUrl) {
    score += 180;
  } else if (isMeaningfulUrl(metadata.url)) {
    score += 100;
  }

  if (isMeaningfulTitle(metadata.title)) {
    score += 20;
  }
  if (metadata.targetId) {
    score += 5;
  }

  return score;
}

async function readPageTargetId(page: Page): Promise<string | undefined> {
  try {
    const cdp = await page.context().newCDPSession(page);
    try {
      const result = (await cdp.send('Target.getTargetInfo')) as {
        targetInfo?: { targetId?: string };
      };
      return result.targetInfo?.targetId;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  } catch {
    return undefined;
  }
}

async function readPageMetadata(page: Page): Promise<LaunchPageMetadata> {
  const [url, title, targetId] = await Promise.all([
    Promise.resolve(page.url()),
    page.title().catch(() => ''),
    readPageTargetId(page),
  ]);

  return { page, url, title, targetId };
}

async function readSessionPageMetadata(
  session: BrowserSessionState,
  pageRef: string,
  page: Page
): Promise<SessionPageMetadata> {
  const existing = session.runtime?.pages[pageRef];
  const [url, targetId, title] = await Promise.all([
    Promise.resolve(page.url()),
    readPageTargetId(page),
    page.title().catch(() => existing?.title ?? ''),
  ]);

  return {
    url,
    title,
    targetId,
  };
}

async function readSettledSessionPageMetadata(
  session: BrowserSessionState,
  pageRef: string,
  page: Page,
  options: {
    settleTimeoutMs?: number;
  } = {}
): Promise<SessionPageMetadata> {
  const existing = session.runtime?.pages[pageRef];
  const deadline = Date.now() + (options.settleTimeoutMs ?? 0);
  let best: (SessionPageMetadata & { score: number }) | null = null;

  while (Date.now() <= deadline) {
    const metadata = await readSessionPageMetadata(session, pageRef, page);
    const score =
      (isMeaningfulUrl(metadata.url) ? 100 : 0) +
      (isMeaningfulTitle(metadata.title) ? 20 : 0) +
      (metadata.targetId ? 5 : 0);
    if (
      !best ||
      score > best.score ||
      (score === best.score && metadata.title.trim().length > best.title.trim().length)
    ) {
      best = { ...metadata, score };
    }

    if (
      best &&
      isMeaningfulUrl(best.url) &&
      (isMeaningfulTitle(best.title) || best.targetId || Date.now() >= deadline)
    ) {
      break;
    }

    if (Date.now() >= deadline) {
      break;
    }

    await sleep(100);
  }

  const metadata = best ?? (await readSessionPageMetadata(session, pageRef, page));
  return {
    url: preferMeaningfulValue(metadata.url, existing?.url, isMeaningfulUrl),
    title: preferMeaningfulValue(metadata.title, existing?.title, isMeaningfulTitle),
    targetId: metadata.targetId ?? existing?.targetId,
  };
}

export async function readLaunchPageMetadata(
  browser: Browser,
  options: {
    requestedUrl?: string;
    fallbackUrl?: string;
    fallbackTitle?: string;
    timeoutMs?: number;
  } = {}
): Promise<LaunchPageMetadata> {
  const deadline = Date.now() + (options.timeoutMs ?? 2_500);
  let best: (LaunchPageMetadata & { score: number }) | null = null;

  while (Date.now() <= deadline) {
    const pages = listPages(browser);
    for (const page of pages) {
      const metadata = await readPageMetadata(page);
      const score = scoreLaunchPageMetadata(metadata, options);
      if (
        !best ||
        score > best.score ||
        (score === best.score && metadata.title.trim().length > best.title.trim().length)
      ) {
        best = { ...metadata, score };
      }
    }

    if (
      best &&
      isMeaningfulUrl(best.url) &&
      (isMeaningfulTitle(best.title) || Date.now() >= deadline)
    ) {
      break;
    }

    if (Date.now() >= deadline) {
      break;
    }

    await sleep(100);
  }

  if (best) {
    return {
      page: best.page,
      url: isMeaningfulUrl(best.url) ? best.url : (options.fallbackUrl ?? best.url),
      title: isMeaningfulTitle(best.title) ? best.title : (options.fallbackTitle ?? best.title),
      targetId: best.targetId,
    };
  }

  return {
    page: null,
    url: options.fallbackUrl ?? '',
    title: options.fallbackTitle ?? '',
  };
}

export async function syncLaunchPage(
  session: BrowserSessionState,
  browser: Browser,
  options: {
    requestedUrl?: string;
    fallbackUrl?: string;
    fallbackTitle?: string;
    timeoutMs?: number;
  } = {}
): Promise<{ url: string; title: string; targetId?: string }> {
  const metadata = await readLaunchPageMetadata(browser, options);
  if (!metadata.page) {
    return {
      url: metadata.url,
      title: metadata.title,
      targetId: metadata.targetId,
    };
  }

  ensureRuntimeState(session);
  if (session.runtime?.pages.p0) {
    updatePage(session, 'p0', {
      url: metadata.url,
      title: metadata.title,
      targetId: metadata.targetId,
    });
  } else {
    registerPage(session, {
      pageRef: 'p0',
      url: metadata.url,
      title: metadata.title,
      targetId: metadata.targetId,
      makeCurrent: true,
    });
  }

  return {
    url: metadata.url,
    title: metadata.title,
    targetId: metadata.targetId,
  };
}

export async function resolvePageByRef(
  browser: Browser,
  session: BrowserSessionState,
  pageRef: string
): Promise<Page> {
  const pages = listPages(browser);
  if (pages.length === 0) {
    throw new Error('no_open_pages');
  }

  const pageState = session.runtime?.pages[pageRef];
  if (!pageState) {
    throw buildPageResolutionError('unknown', pageRef);
  }

  if (!pageState.targetId && !pageState.url && !pageState.title) {
    if (pages.length === 1) {
      return pages[0]!;
    }
    throw buildPageResolutionError('stale', pageRef);
  }

  if (pageState.targetId) {
    for (const page of pages) {
      if ((await readPageTargetId(page)) === pageState.targetId) {
        return page;
      }
    }
  }

  if (pageState.url && pageState.title) {
    for (const page of pages) {
      const liveTitle = await page.title().catch(() => '');
      if (page.url() === pageState.url && liveTitle === pageState.title) {
        return page;
      }
    }
  }

  if (!pageState.url) {
    throw buildPageResolutionError('stale', pageRef);
  }

  for (const page of pages) {
    if (page.url() === pageState.url) {
      return page;
    }
  }

  throw buildPageResolutionError('stale', pageRef);
}

async function findRecoverableCurrentPageRef(
  browser: Browser,
  session: BrowserSessionState,
  stalePageRef: string
): Promise<{ pageRef: string; recoveredVia: 'opener' | 'sole-live-page' } | null> {
  const runtimePages = session.runtime?.pages ?? {};
  const stalePageState = runtimePages[stalePageRef];
  const openerPageRef = stalePageState?.openerPageRef;

  if (openerPageRef && openerPageRef !== stalePageRef) {
    try {
      await resolvePageByRef(browser, session, openerPageRef);
      return {
        pageRef: openerPageRef,
        recoveredVia: 'opener',
      };
    } catch {
      // Keep recovery fail-closed unless opener or a single live alternative is provably valid.
    }
  }

  const liveCandidateRefs: string[] = [];
  for (const candidatePageRef of Object.keys(runtimePages)) {
    if (candidatePageRef === stalePageRef || candidatePageRef === openerPageRef) {
      continue;
    }

    try {
      await resolvePageByRef(browser, session, candidatePageRef);
      liveCandidateRefs.push(candidatePageRef);
    } catch {
      // Ignore stale or unknown candidates while looking for a single surviving live page.
    }
  }

  if (liveCandidateRefs.length === 1) {
    return {
      pageRef: liveCandidateRefs[0]!,
      recoveredVia: 'sole-live-page',
    };
  }

  return null;
}

export async function resolveCurrentPageContext(
  browser: Browser,
  session: BrowserSessionState
): Promise<ResolvedCurrentPageContext> {
  const currentPageRef = session.runtime?.currentPageRef ?? 'p0';

  try {
    const page = await resolvePageByRef(browser, session, currentPageRef);
    return {
      pageRef: currentPageRef,
      page,
    };
  } catch (error) {
    if (isPageResolutionError(error, 'unknown', currentPageRef)) {
      const pages = listPages(browser);
      if (pages.length === 1) {
        return {
          pageRef: currentPageRef,
          page: pages[0]!,
          recoveredVia: 'sole-live-page',
        };
      }
      throw error;
    }

    if (!isPageResolutionError(error, 'stale', currentPageRef)) {
      throw error;
    }

    const recovered = await findRecoverableCurrentPageRef(browser, session, currentPageRef);
    if (!recovered) {
      throw error;
    }

    return {
      pageRef: recovered.pageRef,
      page: await resolvePageByRef(browser, session, recovered.pageRef),
      recoveredVia: recovered.recoveredVia,
    };
  }
}

export async function syncSessionPage(
  session: BrowserSessionState,
  pageRef: string,
  page: Page,
  options: {
    settleTimeoutMs?: number;
  } = {}
): Promise<{ url: string; title: string; targetId?: string }> {
  ensureRuntimeState(session);
  const { url, title, targetId } = await readSettledSessionPageMetadata(
    session,
    pageRef,
    page,
    options
  );

  if (session.runtime?.pages[pageRef]) {
    updatePage(session, pageRef, { url, title, targetId });
  } else {
    registerPage(session, { pageRef, url, title, targetId, makeCurrent: false });
  }

  return { url, title, targetId };
}
