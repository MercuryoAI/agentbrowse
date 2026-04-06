import type { Locator } from 'playwright-core';

export const TRANSPARENT_ACTIONABLE_CONTROL_HELPER_SCRIPT = String.raw`
const credibleLabelTextOf = (element) => {
  if (!isHTMLElementNode(element)) {
    return '';
  }

  const normalizeText = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
  const labelledByTextOf = (candidate) => {
    const labelledBy = candidate.getAttribute?.('aria-labelledby')?.trim?.();
    if (!labelledBy) {
      return '';
    }

    return normalizeText(
      labelledBy
        .split(/\s+/)
        .map((id) => candidate.ownerDocument?.getElementById?.(id)?.textContent ?? '')
        .join(' ')
    );
  };

  const directLabel =
    normalizeText(element.getAttribute?.('aria-label')) ||
    labelledByTextOf(element) ||
    normalizeText(element.labels?.[0]?.textContent ?? '');
  if (directLabel) {
    return directLabel;
  }

  let current = element.parentElement;
  let depth = 0;
  while (isHTMLElementNode(current) && depth < 3) {
    const inheritedLabel = labelledByTextOf(current);
    if (inheritedLabel) {
      return inheritedLabel;
    }
    current = current.parentElement;
    depth += 1;
  }

  return '';
};

const isTransparentActionableControl = (element) => {
  if (!isHTMLElementNode(element)) {
    return false;
  }

  const tag = element.tagName?.toLowerCase?.() ?? '';
  const role = (element.getAttribute?.('role') || '').trim().toLowerCase();
  const isNativeControl =
    tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable;
  const isInteractiveRole =
    role === 'textbox' || role === 'combobox' || role === 'searchbox' || role === 'spinbutton';
  if (!isNativeControl && !isInteractiveRole) {
    return false;
  }

  const view = ownerWindowOf(element);
  const style = view?.getComputedStyle?.(element);
  if (
    !style ||
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    style.pointerEvents === 'none'
  ) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  const documentNode = element.ownerDocument;
  if (!documentNode?.elementFromPoint) {
    return false;
  }

  const viewportWidth = Math.max(
    0,
    Number(view?.innerWidth ?? documentNode?.documentElement?.clientWidth ?? 0)
  );
  const viewportHeight = Math.max(
    0,
    Number(view?.innerHeight ?? documentNode?.documentElement?.clientHeight ?? 0)
  );
  const visibleLeft = viewportWidth > 0 ? Math.max(0, rect.left) : rect.left;
  const visibleRight = viewportWidth > 0 ? Math.min(viewportWidth, rect.right) : rect.right;
  const visibleTop = viewportHeight > 0 ? Math.max(0, rect.top) : rect.top;
  const visibleBottom = viewportHeight > 0 ? Math.min(viewportHeight, rect.bottom) : rect.bottom;
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
    return Boolean(credibleLabelTextOf(element));
  }

  const samplePoints = [
    [visibleLeft + (visibleRight - visibleLeft) / 2, visibleTop + (visibleBottom - visibleTop) / 2],
    [
      Math.max(visibleLeft + 1, visibleLeft + (visibleRight - visibleLeft) * 0.25),
      visibleTop + (visibleBottom - visibleTop) / 2,
    ],
    [
      Math.min(visibleRight - 1, visibleLeft + (visibleRight - visibleLeft) * 0.75),
      visibleTop + (visibleBottom - visibleTop) / 2,
    ],
  ];

  return samplePoints.some(([x, y]) => {
    const hit = documentNode.elementFromPoint(x, y);
    return (
      isHTMLElementNode(hit) &&
      (hit === element || element.contains(hit) || hit.contains(element))
    );
  });
};
`;

export async function isLocatorUserActionable(locator: Locator): Promise<boolean> {
  const visible = await locator.isVisible().catch(() => false);
  if (visible) {
    return true;
  }

  return locator
    .evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const tag = element.tagName.toLowerCase();
      const role = (element.getAttribute('role') || '').trim().toLowerCase();
      const isNativeControl =
        tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable;
      const isInteractiveRole =
        role === 'textbox' || role === 'combobox' || role === 'searchbox' || role === 'spinbutton';
      if (!isNativeControl && !isInteractiveRole) {
        return false;
      }

      const style = element.ownerDocument.defaultView?.getComputedStyle(element);
      if (
        !style ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.pointerEvents === 'none'
      ) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const credibleLabelTextOf = (candidate: HTMLElement): string => {
        const normalizeText = (value: string | null | undefined) =>
          (value ?? '').replace(/\s+/g, ' ').trim();
        const labelledByTextOf = (labelCandidate: HTMLElement): string => {
          const labelledBy = labelCandidate.getAttribute('aria-labelledby')?.trim();
          if (!labelledBy) {
            return '';
          }

          return normalizeText(
            labelledBy
              .split(/\s+/)
              .map((id) => labelCandidate.ownerDocument.getElementById(id)?.textContent ?? '')
              .join(' ')
          );
        };
        const labelsText =
          candidate instanceof HTMLInputElement ||
          candidate instanceof HTMLTextAreaElement ||
          candidate instanceof HTMLSelectElement
            ? normalizeText(candidate.labels?.[0]?.textContent ?? '')
            : '';

        const directLabel =
          normalizeText(candidate.getAttribute('aria-label')) ||
          labelledByTextOf(candidate) ||
          labelsText;
        if (directLabel) {
          return directLabel;
        }

        let current = candidate.parentElement;
        let depth = 0;
        while (current instanceof HTMLElement && depth < 3) {
          const inheritedLabel = labelledByTextOf(current);
          if (inheritedLabel) {
            return inheritedLabel;
          }
          current = current.parentElement;
          depth += 1;
        }

        return '';
      };

      const viewportWidth = Math.max(
        0,
        Number(
          element.ownerDocument.defaultView?.innerWidth ??
            element.ownerDocument.documentElement?.clientWidth ??
            0
        )
      );
      const viewportHeight = Math.max(
        0,
        Number(
          element.ownerDocument.defaultView?.innerHeight ??
            element.ownerDocument.documentElement?.clientHeight ??
            0
        )
      );
      const visibleLeft = viewportWidth > 0 ? Math.max(0, rect.left) : rect.left;
      const visibleRight = viewportWidth > 0 ? Math.min(viewportWidth, rect.right) : rect.right;
      const visibleTop = viewportHeight > 0 ? Math.max(0, rect.top) : rect.top;
      const visibleBottom =
        viewportHeight > 0 ? Math.min(viewportHeight, rect.bottom) : rect.bottom;
      if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
        return Boolean(credibleLabelTextOf(element));
      }

      const samplePoints: Array<[number, number]> = [
        [
          visibleLeft + (visibleRight - visibleLeft) / 2,
          visibleTop + (visibleBottom - visibleTop) / 2,
        ],
        [
          Math.max(visibleLeft + 1, visibleLeft + (visibleRight - visibleLeft) * 0.25),
          visibleTop + (visibleBottom - visibleTop) / 2,
        ],
        [
          Math.min(visibleRight - 1, visibleLeft + (visibleRight - visibleLeft) * 0.75),
          visibleTop + (visibleBottom - visibleTop) / 2,
        ],
      ];

      return samplePoints.some(([x, y]) => {
        const hit = element.ownerDocument.elementFromPoint(x, y);
        return (
          hit instanceof HTMLElement &&
          (hit === element || element.contains(hit) || hit.contains(element))
        );
      });
    })
    .catch(() => false);
}
