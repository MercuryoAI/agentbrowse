import type { Locator, Page } from 'playwright-core';
import type { LocatorCandidate } from '../runtime-state.js';
import { buildLocator, resolveLocatorRoot } from './action-fallbacks.js';
import { readLocatorDomSignature, readLocatorOuterHtml } from './descriptor-validation.js';

const LIVE_SCOPE_ATTRIBUTE = 'data-agentbrowse-scope';

export type ScopedExtractTarget = {
  framePath?: string[];
  locatorCandidates: LocatorCandidate[];
  domSignature?: string;
};

export type ScopedExtractResolution = {
  page: Page;
  selector: string;
  cleanup: () => Promise<void>;
  degraded: boolean;
  degradationReason?: 'iframe-scope-mirror';
};

async function materializeScopedExtractPage(
  page: Page,
  scopedLocator: Locator
): Promise<{
  page: Page;
  selector: string;
  cleanup: () => Promise<void>;
}> {
  let scopedHtml = await readLocatorOuterHtml(scopedLocator);
  if (!scopedHtml) {
    // Some iframe-backed payment forms are live and visible but fail the richer
    // serializer path. Fall back to the native element.outerHTML snapshot
    // instead of reporting the scope as unresolvable.
    scopedHtml = await scopedLocator
      .first()
      .evaluate((element) => (element instanceof Element ? element.outerHTML : null))
      .catch(() => null);
  }
  if (!scopedHtml) {
    throw new Error('scope_target_unresolvable');
  }

  const scratchPage = await page.context().newPage();
  await scratchPage.setContent(
    `<!doctype html><html lang="en"><body><div id="agentbrowse-scope">${scopedHtml}</div></body></html>`
  );

  return {
    page: scratchPage,
    selector: '#agentbrowse-scope',
    cleanup: async () => {
      await scratchPage.close().catch(() => undefined);
    },
  };
}

async function firstVisibleLocator(locator: Locator | null): Promise<Locator | null> {
  if (!locator) {
    return null;
  }

  const first = typeof locator.first === 'function' ? locator.first() : locator;
  const count = typeof first.count === 'function' ? await first.count().catch(() => 0) : 1;
  if (count === 0) {
    return null;
  }

  const visible =
    typeof first.isVisible === 'function' ? await first.isVisible().catch(() => false) : true;
  return visible ? first : null;
}

async function materializeLiveScopedExtract(
  page: Page,
  scopedLocator: Locator
): Promise<{
  page: Page;
  selector: string;
  cleanup: () => Promise<void>;
}> {
  const scopeId = `agentbrowse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await scopedLocator.evaluate(
    (element, payload) => {
      if (!(element instanceof HTMLElement)) {
        throw new Error('unsupported_extract_scope_element');
      }
      element.setAttribute(payload.attribute, payload.value);
    },
    {
      attribute: LIVE_SCOPE_ATTRIBUTE,
      value: scopeId,
    }
  );

  return {
    page,
    selector: `[${LIVE_SCOPE_ATTRIBUTE}="${scopeId}"]`,
    cleanup: async () => {
      await scopedLocator
        .evaluate((element, attribute) => {
          if (element instanceof HTMLElement) {
            element.removeAttribute(attribute);
          }
        }, LIVE_SCOPE_ATTRIBUTE)
        .catch(() => undefined);
    },
  };
}

async function resolveScopedLocator(
  page: Page,
  scopeTarget: ScopedExtractTarget,
  options?: { validateDomSignature?: boolean }
): Promise<Locator> {
  const locatorRoot = resolveLocatorRoot(page, scopeTarget.framePath);
  let sawDomSignatureMismatch = false;
  const validateDomSignature = options?.validateDomSignature ?? true;

  for (const candidate of scopeTarget.locatorCandidates) {
    const locator = buildLocator(locatorRoot, candidate);
    const first = await firstVisibleLocator(locator);
    if (!first) {
      continue;
    }

    if (validateDomSignature && scopeTarget.domSignature) {
      const liveSignature = await readLocatorDomSignature(first);
      if (!liveSignature) {
        continue;
      }
      if (liveSignature !== scopeTarget.domSignature) {
        sawDomSignatureMismatch = true;
        continue;
      }
    }

    return first;
  }

  if (sawDomSignatureMismatch) {
    throw new Error('stale_scope_target_dom_signature_changed');
  }

  throw new Error('scope_target_unresolvable');
}

export async function resolveScopedExtractContext(args: {
  page: Page;
  scopeTarget: ScopedExtractTarget;
  validateDomSignature?: boolean;
}): Promise<ScopedExtractResolution> {
  const scopedLocator = await resolveScopedLocator(args.page, args.scopeTarget, {
    validateDomSignature: args.validateDomSignature,
  });

  if (args.scopeTarget.framePath?.length) {
    const mirrored = await materializeScopedExtractPage(args.page, scopedLocator);
    return {
      ...mirrored,
      degraded: true,
      degradationReason: 'iframe-scope-mirror',
    };
  }

  const liveScoped = await materializeLiveScopedExtract(args.page, scopedLocator);
  return {
    ...liveScoped,
    degraded: false,
  };
}
