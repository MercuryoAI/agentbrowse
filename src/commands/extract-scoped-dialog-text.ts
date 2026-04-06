import type { Page } from 'playwright-core';

const BLOCK_MARKER = '[block]';
const ANCHOR_SELECTOR = [
  'button',
  'a[href]',
  '[role="button"]',
  '[role="link"]',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="reset"]',
].join(', ');

type ScopedDialogTextPayload = {
  marker: string;
  anchorSelector: string;
  minBlockTextLength: number;
  maxAnchorCountPerBlock: number;
};

// Build the browser callback from plain JS source so Playwright serializes
// stable code instead of tsx-transformed output.
const readScopedDialogTextInBrowser = Function(
  `return (${String.raw`(root, payload) => {
    const marker = payload.marker;
    const anchorSelector = payload.anchorSelector;
    const minBlockTextLength = payload.minBlockTextLength;
    const maxAnchorCountPerBlock = payload.maxAnchorCountPerBlock;

    function normalizeOutputText(text) {
      return text
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    function normalizeBlockText(text) {
      return normalizeOutputText(text).replace(/\n{2,}/g, '\n');
    }

    function isVisibleElement(element) {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      if (element.hidden || element.getAttribute('aria-hidden') === 'true') {
        return false;
      }

      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    }

    function visibleChildren(element) {
      return Array.from(element.children).filter((child) => isVisibleElement(child));
    }

    function collectVisibleAnchors(rootElement) {
      return Array.from(rootElement.querySelectorAll(anchorSelector)).filter((anchor) =>
        isVisibleElement(anchor)
      );
    }

    function countAnchorsWithin(element, anchors) {
      let count = 0;
      for (const anchor of anchors) {
        if (element.contains(anchor)) {
          count += 1;
        }
      }
      return count;
    }

    function pathFromRoot(rootElement, node) {
      const path = [];
      let current = node;

      while (current && current !== rootElement) {
        const parent = current.parentElement;
        if (!(parent instanceof HTMLElement)) {
          return null;
        }

        const index = Array.from(parent.children).indexOf(current);
        if (index < 0) {
          return null;
        }

        path.unshift(index);
        current = parent;
      }

      return current === rootElement ? path : null;
    }

    function max(values) {
      return values.reduce((current, value) => Math.max(current, value), 0);
    }

    function sum(values) {
      return values.reduce((current, value) => current + value, 0);
    }

    if (!(root instanceof HTMLElement)) {
      return null;
    }

    const rawText = normalizeOutputText(root.innerText);
    if (!rawText) {
      return null;
    }

    const anchors = collectVisibleAnchors(root);
    if (anchors.length < 2) {
      return rawText;
    }

    const candidates = [root, ...Array.from(root.querySelectorAll('*')).filter((element) => isVisibleElement(element))]
      .map((element) => {
        const children = visibleChildren(element);
        if (children.length < 2) {
          return null;
        }

        const tagName = children[0] && children[0].tagName;
        if (!tagName || children.some((child) => child.tagName !== tagName)) {
          return null;
        }

        const childSummaries = children.map((child) => {
          const text = normalizeBlockText(child.innerText);
          const anchorCount = countAnchorsWithin(child, anchors);
          return {
            text,
            textLength: text.length,
            anchorCount,
          };
        });

        if (
          childSummaries.some(
            (summary) => summary.anchorCount < 1 || summary.anchorCount > maxAnchorCountPerBlock
          )
        ) {
          return null;
        }

        const anchorCounts = childSummaries.map((summary) => summary.anchorCount);
        if (max(anchorCounts) - Math.min(...anchorCounts) > 1) {
          return null;
        }

        const textLengths = childSummaries.map((summary) => summary.textLength);
        if (textLengths.some((length) => length < minBlockTextLength)) {
          return null;
        }

        const parentPath = pathFromRoot(root, element);
        if (!parentPath) {
          return null;
        }

        return {
          parentPath,
          blockTexts: childSummaries.map((summary) => summary.text).filter(Boolean),
          childCount: childSummaries.length,
          totalTextLength: sum(textLengths),
          depth: parentPath.length,
          maxAnchorCount: max(anchorCounts),
        };
      })
      .filter(Boolean);

    const bestCandidate = candidates.sort((left, right) => {
      if (right.childCount !== left.childCount) {
        return right.childCount - left.childCount;
      }
      if (right.totalTextLength !== left.totalTextLength) {
        return right.totalTextLength - left.totalTextLength;
      }
      if (right.maxAnchorCount !== left.maxAnchorCount) {
        return right.maxAnchorCount - left.maxAnchorCount;
      }
      return right.depth - left.depth;
    })[0];

    if (!bestCandidate || bestCandidate.blockTexts.length < 2) {
      return rawText;
    }

    return normalizeOutputText(
      bestCandidate.blockTexts.map((text) => marker + '\n' + text).join('\n\n')
    );
  }`});`
)() as (root: Element, payload: ScopedDialogTextPayload) => string | null;

export async function readScopedDialogText(page: Page, selector: string): Promise<string | null> {
  let rawText: string | null = null;
  try {
    rawText = (await page.locator(selector).first().innerText()).replace(/\r/g, '');
    if (!rawText.trim()) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const result = await page.locator(selector).first().evaluate(readScopedDialogTextInBrowser, {
      marker: BLOCK_MARKER,
      anchorSelector: ANCHOR_SELECTOR,
      minBlockTextLength: 20,
      maxAnchorCountPerBlock: 4,
    });
    return typeof result === 'string' && result.trim().length > 0 ? result : rawText;
  } catch {
    return rawText;
  }
}
