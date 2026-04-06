import type { Frame } from 'playwright-core';
import { readFrameHostDescriptor } from './observe-inventory.js';

export type ObservedPageSignal = {
  kind: 'status' | 'alert' | 'dialog' | 'notice' | 'outcome';
  text: string;
  framePath?: string[];
  frameUrl?: string;
  source: 'dom';
};

type SignalCollectionContext = {
  evaluate<T>(pageFunction: string): Promise<T>;
};

const DOM_SIGNAL_COLLECTION_LIMIT = 24;

function normalizeObservedSignalTextValue(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export function inferObservedSignalKindFromFacts(facts: {
  role?: string;
  ariaLive?: string;
  ariaModal?: boolean;
  ariaBusy?: boolean;
  progressLike?: boolean;
  classBlob?: string;
}): ObservedPageSignal['kind'] {
  const role = (facts.role ?? '').trim().toLowerCase();
  const ariaLive = (facts.ariaLive ?? '').trim().toLowerCase();
  const classBlob = (facts.classBlob ?? '').toLowerCase();

  if (role === 'dialog' || facts.ariaModal === true) {
    return 'dialog';
  }
  if (role === 'alert' || ariaLive === 'assertive') {
    return 'alert';
  }
  if (
    role === 'status' ||
    ariaLive === 'polite' ||
    facts.ariaBusy === true ||
    facts.progressLike === true
  ) {
    return 'status';
  }
  if (/toast|snackbar|banner|notice|warning|error|success/.test(classBlob)) {
    return 'notice';
  }
  return 'notice';
}

export function isObservedSignalOutcomeText(text: string | undefined): boolean {
  const normalized = normalizeObservedSignalTextValue(text);
  return (
    normalized.length > 0 &&
    /(?:thanks|thank you|success(?:ful|fully)?|receipt|order\s+(?:confirmed|complete(?:d)?|successful)|payment\s+(?:successful|complete(?:d)?|confirmed)|purchase\s+(?:complete(?:d)?|successful)|declin(?:e|ed)|fail(?:ed|ure)|error|unable|try again|verification|verify|challenge|captcha|processing|pending|approved|denied)/i.test(
      normalized
    )
  );
}

export function shouldUseObservedDecoratedNoticeSurface(facts: {
  hasVisibleInteractiveDescendant?: boolean;
  directSemanticTextCount?: number;
}): boolean {
  if (facts.hasVisibleInteractiveDescendant === true) {
    return false;
  }
  if ((facts.directSemanticTextCount ?? 0) > 0) {
    return false;
  }
  return true;
}

export function shouldUseStandaloneOutcomeCandidate(facts: {
  text?: string;
  withinKnownSignalSurface?: boolean;
  hasVisibleInteractiveDescendant?: boolean;
  hasNestedOutcomeCandidate?: boolean;
  maxLength?: number;
}): boolean {
  const normalized = normalizeObservedSignalTextValue(facts.text);
  const maxLength = Math.max(24, facts.maxLength ?? 160);

  if (!normalized || normalized.length < 12 || normalized.length > maxLength) {
    return false;
  }
  if (!isObservedSignalOutcomeText(normalized)) {
    return false;
  }
  if (facts.withinKnownSignalSurface === true) {
    return false;
  }
  if (facts.hasVisibleInteractiveDescendant === true) {
    return false;
  }
  if (facts.hasNestedOutcomeCandidate === true) {
    return false;
  }
  return true;
}

const OBSERVE_SIGNAL_HELPER_SCRIPT = `
  const normalizeObservedSignalTextValue = ${normalizeObservedSignalTextValue.toString()};
  const inferObservedSignalKindFromFacts = ${inferObservedSignalKindFromFacts.toString()};
  const isObservedSignalOutcomeText = ${isObservedSignalOutcomeText.toString()};
  const shouldUseObservedDecoratedNoticeSurface = ${shouldUseObservedDecoratedNoticeSurface.toString()};
  const shouldUseStandaloneOutcomeCandidate = ${shouldUseStandaloneOutcomeCandidate.toString()};
`;

function normalizeInheritedFramePath(framePath?: string[]): string[] | undefined {
  return Array.isArray(framePath) && framePath.length > 0 ? [...framePath] : undefined;
}

function normalizeInheritedFrameUrl(frameUrl?: string): string | undefined {
  return typeof frameUrl === 'string' && frameUrl.trim().length > 0 ? frameUrl : undefined;
}

function applyInheritedSignalMetadata(
  signal: ObservedPageSignal,
  options?: {
    framePath?: string[];
    frameUrl?: string;
  }
): ObservedPageSignal {
  const normalizedFramePath =
    normalizeInheritedFramePath(options?.framePath) ??
    normalizeInheritedFramePath(signal.framePath);
  const normalizedFrameUrl = normalizeInheritedFrameUrl(options?.frameUrl) ?? signal.frameUrl;

  return {
    ...signal,
    framePath: normalizedFramePath,
    frameUrl: normalizedFrameUrl,
  };
}

async function collectPageSignalsFromDocument(
  context: SignalCollectionContext,
  options?: {
    framePath?: string[];
    frameUrl?: string;
  }
): Promise<ObservedPageSignal[]> {
  const inheritedFramePath = JSON.stringify(options?.framePath ?? []);
  const inheritedFrameUrl = JSON.stringify(options?.frameUrl ?? '');
  const observedSignals = await context.evaluate<ObservedPageSignal[]>(String.raw`(() => {
    const inheritedFramePath = ${inheritedFramePath};
    const inheritedFrameUrl = ${inheritedFrameUrl};
    const limit = ${DOM_SIGNAL_COLLECTION_LIMIT};
    ${OBSERVE_SIGNAL_HELPER_SCRIPT}
    const interactiveSelector =
      'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="option"], [role="gridcell"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
    const semanticSurfaceSelector = [
      '[role="alert"]',
      '[role="status"]',
      '[aria-live="assertive"]',
      '[aria-live="polite"]',
      '[role="dialog"]',
      '[aria-modal="true"]',
      '[aria-busy="true"]',
      '[role="progressbar"]',
    ].join(', ');
    const decoratedNoticeSelector = [
      '[class*="toast"]',
      '[class*="snackbar"]',
      '[class*="banner"]',
      '[class*="notice"]',
      '[class*="success"]',
      '[class*="error"]',
      '[class*="warning"]',
      '[data-testid*="toast"]',
      '[data-testid*="banner"]',
      '[data-testid*="alert"]',
      '[data-testid*="success"]',
      '[data-testid*="error"]',
    ].join(', ');
    const directSemanticTextSelector =
      'h1, h2, h3, h4, h5, h6, [role="heading"], legend, p, [role="alert"], [role="status"]';
    const standaloneOutcomeSelector = 'h1, h2, h3, [role="heading"], p';

    const normalizeText = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const sampleText = (value, maxLength) => {
      const normalized = normalizeText(value);
      if (!normalized) {
        return '';
      }
      if (normalized.length <= maxLength) {
        return normalized;
      }
      return normalized.slice(0, maxLength - 1).trimEnd() + '…';
    };
    const joinUniqueText = (values, maxLength = 240) => {
      const seen = new Set();
      const accepted = [];
      for (const value of values) {
        const normalized = sampleText(value, maxLength);
        if (!normalized) {
          continue;
        }
        const key = normalized.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        accepted.push(normalized);
      }
      return sampleText(accepted.join(' '), maxLength);
    };
    const visibleTextOf = (element, maxLength = 160) => {
      if (!(element instanceof HTMLElement)) {
        return '';
      }
      const rawInnerText = typeof element.innerText === 'string' ? element.innerText : undefined;
      const preferredText = rawInnerText !== undefined ? rawInnerText : element.textContent || '';
      return sampleText(preferredText, maxLength);
    };
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = element.ownerDocument?.defaultView?.getComputedStyle(element);
      if (!style || style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const relationTextOf = (element, attribute) => {
      if (!(element instanceof HTMLElement)) {
        return '';
      }
      const relation = element.getAttribute(attribute)?.trim();
      if (!relation) {
        return '';
      }
      return sampleText(
        relation
          .split(/\s+/)
          .map((id) => {
            const relatedElement = document.getElementById(id);
            return relatedElement instanceof HTMLElement
              ? relatedElement.innerText || relatedElement.textContent || ''
              : '';
          })
          .join(' '),
        240
      );
    };
    const hasVisibleInteractiveDescendant = (element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      return Array.from(element.querySelectorAll(interactiveSelector)).some(
        (candidate) => candidate !== element && candidate instanceof HTMLElement && isVisible(candidate)
      );
    };
    const textOf = (element) => visibleTextOf(element, 160);
    const directSemanticTextsOf = (element) => {
      if (!(element instanceof HTMLElement)) {
        return [];
      }

      if (element.matches(directSemanticTextSelector)) {
        return [textOf(element)];
      }

      const directChildren = Array.from(element.children)
        .filter(
          (candidate) =>
            candidate instanceof HTMLElement &&
            candidate.matches(directSemanticTextSelector) &&
            isVisible(candidate)
        )
        .slice(0, 3);

      return directChildren.map((candidate) => textOf(candidate));
    };
    const nonInteractiveSurfaceTextOf = (element) => {
      if (!(element instanceof HTMLElement)) {
        return '';
      }

      const clone = element.cloneNode(true);
      if (!(clone instanceof HTMLElement)) {
        return '';
      }

      for (const nested of Array.from(
        clone.querySelectorAll(
          [
            interactiveSelector,
            semanticSurfaceSelector,
            decoratedNoticeSelector,
            '[hidden]',
            '[aria-hidden="true"]',
          ].join(', ')
        )
      )) {
        if (nested instanceof HTMLElement) {
          nested.remove();
        }
      }

      return visibleTextOf(clone, 160);
    };
    const signalTextOf = (element) => {
      if (!(element instanceof HTMLElement)) {
        return '';
      }

      return (
        joinUniqueText(
          [
            element.getAttribute('aria-label'),
            relationTextOf(element, 'aria-labelledby'),
            element.getAttribute('title'),
            relationTextOf(element, 'aria-describedby'),
            ...directSemanticTextsOf(element),
            nonInteractiveSurfaceTextOf(element),
          ],
          240
        ) || ''
      );
    };
    const isKnownDecoratedNoticeSurface = (element) => {
      if (!(element instanceof HTMLElement) || !element.matches(decoratedNoticeSelector) || !isVisible(element)) {
        return false;
      }
      return shouldUseObservedDecoratedNoticeSurface({
        hasVisibleInteractiveDescendant: hasVisibleInteractiveDescendant(element),
        directSemanticTextCount: directSemanticTextsOf(element).length,
      });
    };
    const isWithinKnownSignalSurface = (element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      let current = element.parentElement;
      while (current instanceof HTMLElement) {
        if (current.matches(semanticSurfaceSelector) && isVisible(current)) {
          return true;
        }
        if (isKnownDecoratedNoticeSurface(current)) {
          return true;
        }
        current = current.parentElement;
      }
      return false;
    };

    const seen = new Set();
    const signals = [];
    const pushSignal = (kind, text) => {
      const normalized = sampleText(text, 240);
      if (!normalized) {
        return;
      }
      const key = kind + '|' + normalized.toLowerCase();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      signals.push({
        kind,
        text: normalized,
        framePath: inheritedFramePath.length > 0 ? inheritedFramePath : undefined,
        frameUrl: inheritedFrameUrl || undefined,
        source: 'dom',
      });
      if (signals.length > limit) {
        signals.length = limit;
      }
    };

    for (const element of Array.from(document.querySelectorAll(semanticSurfaceSelector))) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        continue;
      }
      const text = signalTextOf(element);
      if (!text) {
        continue;
      }
      const classBlob =
        ((element.getAttribute('class') || '') + ' ' + Object.values(element.dataset || {}).join(' ')).toLowerCase();
      pushSignal(
        inferObservedSignalKindFromFacts({
          role: element.getAttribute('role') || undefined,
          ariaLive: element.getAttribute('aria-live') || undefined,
          ariaModal: element.getAttribute('aria-modal') === 'true',
          ariaBusy: element.hasAttribute('aria-busy'),
          progressLike: element.matches('[role="progressbar"]'),
          classBlob,
        }),
        text
      );
      if (signals.length >= limit) {
        return signals;
      }
    }

    for (const element of Array.from(document.querySelectorAll(decoratedNoticeSelector))) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        continue;
      }
      if (element.matches(semanticSurfaceSelector)) {
        continue;
      }
      if (
        !shouldUseObservedDecoratedNoticeSurface({
          hasVisibleInteractiveDescendant: hasVisibleInteractiveDescendant(element),
          directSemanticTextCount: directSemanticTextsOf(element).length,
        })
      ) {
        continue;
      }
      const text = signalTextOf(element);
      if (!text) {
        continue;
      }
      pushSignal('notice', text);
      if (signals.length >= limit) {
        break;
      }
    }

    for (const element of Array.from(document.querySelectorAll(standaloneOutcomeSelector))) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        continue;
      }
      const text = signalTextOf(element);
      if (
        !shouldUseStandaloneOutcomeCandidate({
          text,
          withinKnownSignalSurface: isWithinKnownSignalSurface(element),
          hasVisibleInteractiveDescendant: hasVisibleInteractiveDescendant(element),
          hasNestedOutcomeCandidate: false,
          maxLength: 160,
        })
      ) {
        continue;
      }
      pushSignal('notice', text);
      if (signals.length >= limit) {
        break;
      }
    }

    return signals;
  })()`);

  if (!Array.isArray(observedSignals)) {
    return [];
  }

  return observedSignals
    .filter((signal): signal is ObservedPageSignal =>
      Boolean(
        signal &&
          typeof signal === 'object' &&
          typeof (signal as ObservedPageSignal).kind === 'string' &&
          typeof (signal as ObservedPageSignal).text === 'string' &&
          (signal as ObservedPageSignal).text.length > 0
      )
    )
    .map((signal) =>
      applyInheritedSignalMetadata(signal, {
        framePath: options?.framePath,
        frameUrl: options?.frameUrl,
      })
    );
}

export async function collectPageSignals(page: {
  evaluate<T>(pageFunction: string): Promise<T>;
  mainFrame?: () => Frame;
}): Promise<ObservedPageSignal[]> {
  if (typeof page.mainFrame !== 'function') {
    return collectPageSignalsFromDocument(page);
  }

  const collected: ObservedPageSignal[] = [];
  const seen = new Set<string>();

  const pushSignals = (signals: ReadonlyArray<ObservedPageSignal>) => {
    for (const signal of signals) {
      const key = [
        signal.kind,
        signal.text.toLowerCase(),
        signal.framePath?.join('>') ?? 'top',
      ].join('|');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      collected.push(signal);
      if (collected.length >= DOM_SIGNAL_COLLECTION_LIMIT) {
        break;
      }
    }
  };

  const walk = async (frame: Frame, framePath?: string[]): Promise<void> => {
    if (collected.length >= DOM_SIGNAL_COLLECTION_LIMIT) {
      return;
    }

    const frameUrl = frame.url().trim() || undefined;
    const signals = await collectPageSignalsFromDocument(frame, {
      framePath,
      frameUrl,
    }).catch(() => []);
    pushSignals(signals);

    if (collected.length >= DOM_SIGNAL_COLLECTION_LIMIT) {
      return;
    }

    for (const childFrame of frame.childFrames().slice(0, 20)) {
      if (collected.length >= DOM_SIGNAL_COLLECTION_LIMIT) {
        break;
      }

      const frameHost = await readFrameHostDescriptor(childFrame);
      if (!frameHost?.selector || !frameHost.userVisible) {
        continue;
      }

      await walk(childFrame, [...(framePath ?? []), frameHost.selector]);
    }
  };

  await walk(page.mainFrame());
  return collected;
}

export const __testObserveSignals = {
  collectPageSignalsFromDocument,
  inferObservedSignalKindFromFacts,
  isObservedSignalOutcomeText,
  shouldUseObservedDecoratedNoticeSurface,
  shouldUseStandaloneOutcomeCandidate,
};
