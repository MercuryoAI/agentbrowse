import type { Frame, Locator, Page } from 'playwright-core';
import type { BrowseSession } from '../session.js';
import { getSurface, getTarget } from '../runtime-state.js';
import type { SurfaceDescriptor, TargetDescriptor } from '../runtime-state.js';
import {
  inferComparableValueTypeFromFacts,
  type ComparableValueType,
} from '../control-semantics.js';
import type { BrowseAction } from './browse-actions.js';
import { buildLocator, resolveLocatorRoot } from './action-fallbacks.js';
import { OBSERVE_DOM_LABEL_CONTRACT_HELPER_SCRIPT } from './observe-dom-label-contract.js';
import { resolveSurfaceScopeRoot } from './target-resolution.js';
import { isLocatorUserActionable } from './user-actionable.js';

export type PageObservation = {
  url: string;
  title: string;
  contentHash: string | null;
  structureHash: string | null;
  submitSignalHash: string | null;
  resultSignalHash: string | null;
  validationBlockerCount: number;
};

type TargetStateKey = 'selected' | 'checked' | 'expanded' | 'pressed' | 'current' | 'focused';

type LocatorStateObservation = Partial<Record<TargetStateKey, string | boolean>>;

export type AcceptanceProbe = {
  policy: NonNullable<TargetDescriptor['acceptancePolicy']>;
  page: Page;
  target: TargetDescriptor;
  action: BrowseAction;
  surface: SurfaceDescriptor | null;
  ownerTarget: TargetDescriptor | null;
  ownerSurface: SurfaceDescriptor | null;
  beforePage: PageObservation | null;
  beforeLocator: LocatorStateObservation | null;
  beforeContextHash: string | null;
  beforeReadLocator: LocatorStateObservation | null;
  beforeReadContextHash: string | null;
  trackedStateKeys: TargetStateKey[];
  locator: Locator;
  readLocator: Locator;
  readLocators: Locator[];
  surfaceLocator: Locator | null;
  expectedValue: string | null;
  beforeValue: string | null;
  comparableValueType?: ComparableValueType;
  ownerLocator: Locator | null;
  beforeOwnerValue: string | null;
  beforeSurfaceContextHash: string | null;
  beforeFollowUpSurfaceHash: string | null;
};

export type AcceptanceProbeResult = {
  accepted: boolean;
  afterPageObservation: PageObservation | null;
  polls: number;
};

export type NoObservableProgressObservations = {
  visibleMessages: string[];
  invalidFields: string[];
  targetState?: {
    disabled?: boolean;
    readonly?: boolean;
  };
};

const ACTION_CANDIDATE_PRIORITY: Record<BrowseAction, Record<string, number> | null> = {
  click: {
    role: 0,
    testId: 1,
    label: 2,
    text: 3,
    title: 4,
    css: 5,
    xpath: 6,
  },
  fill: {
    css: 0,
    xpath: 1,
    testId: 2,
    label: 3,
    placeholder: 4,
    role: 5,
    text: 6,
    title: 7,
  },
  type: {
    css: 0,
    xpath: 1,
    testId: 2,
    label: 3,
    placeholder: 4,
    role: 5,
    text: 6,
    title: 7,
  },
  select: {
    css: 0,
    xpath: 1,
    testId: 2,
    label: 3,
    role: 4,
    text: 5,
    title: 6,
    placeholder: 7,
  },
  press: {
    css: 0,
    xpath: 1,
    testId: 2,
    label: 3,
    placeholder: 4,
    role: 5,
    text: 6,
    title: 7,
  },
};

const ACCEPTANCE_POLL_INTERVAL_MS = 100;
const ACCEPTANCE_POLL_TIMEOUT_MS = 2_500;
const CHILD_FRAME_SIGNAL_LIMIT = 20;
const NO_PROGRESS_SIGNAL_LIMIT = 6;
const NO_PROGRESS_OVERLAY_LIMIT = 4;
const ASSOCIATED_CHOICE_STATE_HELPER_SCRIPT = String.raw`
  const ownerWindowOf = (node) => node?.ownerDocument?.defaultView ?? window;
  const isHTMLElementNode = (value) => {
    const view = ownerWindowOf(value);
    return Boolean(view && value instanceof view.HTMLElement);
  };
  const isHTMLInputNode = (value) => {
    const view = ownerWindowOf(value);
    return Boolean(view && value instanceof view.HTMLInputElement);
  };
  const isHTMLLabelNode = (value) => {
    const view = ownerWindowOf(value);
    return Boolean(view && value instanceof view.HTMLLabelElement);
  };
  const isChoiceInput = (candidate) => {
    if (!isHTMLInputNode(candidate)) {
      return false;
    }
    const type = (candidate.type || '').toLowerCase();
    return type === 'radio' || type === 'checkbox';
  };
  const associatedLabelControlOf = (candidate) => {
    if (!isHTMLLabelNode(candidate)) {
      return undefined;
    }

    const directControl = candidate.control;
    if (isChoiceInput(directControl)) {
      return directControl;
    }

    const nestedControl = candidate.querySelector?.('input');
    return isChoiceInput(nestedControl) ? nestedControl : undefined;
  };
  const hiddenChoiceSiblingControlOf = (candidate) => {
    if (!isHTMLElementNode(candidate)) {
      return undefined;
    }

    const parent = candidate.parentElement;
    if (!isHTMLElementNode(parent)) {
      return undefined;
    }

    const hiddenChoiceSiblings = Array.from(parent.children).filter((sibling) => {
      if (sibling === candidate || !isChoiceInput(sibling)) {
        return false;
      }

      const style = ownerWindowOf(sibling).getComputedStyle(sibling);
      const rect = sibling.getBoundingClientRect();
      return (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.pointerEvents === 'none' ||
        Number(style.opacity || '1') < 0.05 ||
        rect.width < 4 ||
        rect.height < 4
      );
    });

    if (hiddenChoiceSiblings.length !== 1) {
      return undefined;
    }

    const visibleNonChoiceSiblings = Array.from(parent.children).filter((sibling) => {
      if (sibling === hiddenChoiceSiblings[0] || !isHTMLElementNode(sibling)) {
        return false;
      }

      const style = ownerWindowOf(sibling).getComputedStyle(sibling);
      const rect = sibling.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.visibility !== 'collapse' &&
        rect.width > 0 &&
        rect.height > 0
      );
    });

    if (visibleNonChoiceSiblings.length !== 1 || visibleNonChoiceSiblings[0] !== candidate) {
      return undefined;
    }

    return hiddenChoiceSiblings[0];
  };
  const associatedChoiceControl =
    (isChoiceInput(element) ? element : undefined) ||
    associatedLabelControlOf(element) ||
    hiddenChoiceSiblingControlOf(element);
  if (!associatedChoiceControl) {
    return null;
  }

  return {
    checked: associatedChoiceControl.indeterminate ? 'mixed' : associatedChoiceControl.checked,
  };
`;
const PAGE_OBSERVATION_SCRIPT = String.raw`(() => {
  const normalizeText = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
  const sampleText = (value, limit) => {
    if (value.length <= limit) {
      return value;
    }

    const edge = Math.floor(limit / 3);
    const middle = Math.max(1, limit - edge * 2);
    const middleStart = Math.max(0, Math.floor((value.length - middle) / 2));
    return [
      value.slice(0, edge),
      value.slice(middleStart, middleStart + middle),
      value.slice(-edge),
    ].join('\n');
  };
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = element.ownerDocument?.defaultView?.getComputedStyle(element);
    if (!style || style.display === 'none' || style.visibility !== 'visible') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const interactiveSummary = () => {
    const selectors = [
      'button',
      'a',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="option"]',
      '[role="combobox"]',
    ];
    const items = [];

    for (const element of Array.from(document.querySelectorAll(selectors.join(', ')))) {
      if (!isVisible(element)) {
        continue;
      }

      const role = element.getAttribute('role') || element.tagName.toLowerCase();
      const label =
        normalizeText(element.getAttribute('aria-label')) ||
        normalizeText(
          element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
            ? element.value
            : element.textContent
        ) ||
        normalizeText(element.getAttribute('title')) ||
        normalizeText(element.getAttribute('placeholder'));
      if (!label) {
        continue;
      }

      items.push(
        [
          role,
          label.slice(0, 80),
          element.getAttribute('aria-expanded') || '',
          element.getAttribute('aria-selected') || '',
          element.getAttribute('aria-pressed') || '',
        ].join(':')
      );
      if (items.length >= 60) {
        break;
      }
    }

    return items.join('|');
  };
  const stableControlSummary = () => {
    const selectors = [
      'button',
      'a[href]',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="option"]',
      '[role="combobox"]',
      '[role="textbox"]',
    ];
    const items = [];

    for (const element of Array.from(document.querySelectorAll(selectors.join(', ')))) {
      if (!isVisible(element)) {
        continue;
      }

      const role = element.getAttribute('role') || element.tagName.toLowerCase();
      const descriptor =
        normalizeText(element.getAttribute('aria-label')) ||
        normalizeText(element.getAttribute('name')) ||
        normalizeText(element.getAttribute('placeholder')) ||
        normalizeText(element.getAttribute('title')) ||
        normalizeText(element.id) ||
        normalizeText(element.getAttribute('data-testid')) ||
        normalizeText(element.getAttribute('data-test-id')) ||
        '';
      const inputType =
        element instanceof HTMLInputElement
          ? normalizeText(element.type || 'text')
          : element instanceof HTMLSelectElement
            ? 'select'
            : element instanceof HTMLTextAreaElement
              ? 'textarea'
              : '';
      const disabled =
        element instanceof HTMLButtonElement ||
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
          ? element.disabled
          : element.getAttribute('aria-disabled') === 'true';
      const valueState =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
          ? normalizeText(element.value)
            ? 'value'
            : 'empty'
          : '';

      items.push(
        [
          role,
          inputType,
          descriptor || 'unlabeled',
          disabled ? 'disabled' : '',
          valueState,
          element.getAttribute('aria-expanded') || '',
          element.getAttribute('aria-selected') || '',
          element.getAttribute('aria-pressed') || '',
        ].join(':')
      );
      if (items.length >= 80) {
        break;
      }
    }

    return items.join('|');
  };
  const dialogSummary = () => {
    const items = [];

    for (const element of Array.from(
      document.querySelectorAll('dialog, [role="dialog"], [aria-modal="true"]')
    )) {
      if (!isVisible(element)) {
        continue;
      }

      const label =
        normalizeText(element.getAttribute('aria-label')) ||
        normalizeText(element.getAttribute('data-testid')) ||
        normalizeText(element.id) ||
        sampleText(normalizeText(element.textContent || ''), 120);
      items.push('dialog:' + (label || 'visible'));
      if (items.length >= 20) {
        break;
      }
    }

    return items.join('|');
  };
  const frameSummary = () => {
    const items = [];

    for (const element of Array.from(document.querySelectorAll('iframe, frame'))) {
      if (!isVisible(element)) {
        continue;
      }

      const title =
        normalizeText(element.getAttribute('title')) ||
        normalizeText(element.getAttribute('name'));
      const rawSrc = element.getAttribute('src') || '';
      let normalizedSrc = normalizeText(rawSrc);
      if (rawSrc) {
        try {
          const url = new URL(rawSrc, document.baseURI);
          normalizedSrc = (url.origin + url.pathname).toLowerCase();
        } catch {
          normalizedSrc = normalizeText(rawSrc);
        }
      }

      items.push(
        [
          'frame',
          title || 'untitled',
          normalizedSrc.slice(0, 160),
          element.getAttribute('aria-hidden') || '',
        ].join(':')
      );
      if (items.length >= 20) {
        break;
      }
    }

    return items.join('|');
  };
  const headingSummary = () => {
    const items = [];

    for (const element of Array.from(
      document.querySelectorAll('h1, h2, h3, legend, [role="heading"]')
    )) {
      if (!isVisible(element)) {
        continue;
      }

      const label = sampleText(normalizeText(element.textContent || ''), 120);
      if (!label) {
        continue;
      }

      items.push(label);
      if (items.length >= 20) {
        break;
      }
    }

    return items.join('|');
  };
  const processingSummary = () => {
    const selectors = [
      '[aria-busy="true"]',
      '[role="progressbar"]',
      '[role="status"]',
      '[data-loading]',
      '[data-busy]',
      'button[disabled]',
      'input[disabled]',
      'select[disabled]',
      'textarea[disabled]',
    ];
    const items = [];

    for (const element of Array.from(document.querySelectorAll(selectors.join(', ')))) {
      if (!isVisible(element)) {
        continue;
      }

      const role = element.getAttribute('role') || element.tagName.toLowerCase();
      const label =
        normalizeText(element.getAttribute('aria-label')) ||
        normalizeText(element.getAttribute('name')) ||
        normalizeText(element.getAttribute('title')) ||
        normalizeText(element.id) ||
        sampleText(normalizeText(element.textContent || ''), 80);
      items.push(
        [
          role,
          label || 'processing',
          element.getAttribute('aria-busy') || '',
          element.getAttribute('data-loading') || '',
          element.getAttribute('data-busy') || '',
        ].join(':')
      );
      if (items.length >= 20) {
        break;
      }
    }

    return items.join('|');
  };
  const validationSummary = () => {
    const fieldSelectors =
      'input, textarea, select, [role="textbox"], [contenteditable="true"], [aria-invalid="true"]';
    const validationMessageSelectors = [
      '[role="alert"]',
      '[aria-live="assertive"]',
      '[aria-live="polite"]',
      '.error',
      '.errors',
      '.invalid-feedback',
      '.form-error',
      '.warning',
      '[data-testid*="error"]',
      '[data-testid*="warning"]',
    ];
    const validationTextRe =
      /(?:required|invalid|incorrect|too\s+(?:short|long)|must|error|format|please\s+(?:enter|select|choose|fill)|невер|ошиб|обязател|заполн|введите|укажите|выберите|долж|нужно|формат|цифр|символ)/i;
    const items = [];

    for (const element of Array.from(document.querySelectorAll(fieldSelectors))) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        continue;
      }

      const ariaInvalid = element.getAttribute('aria-invalid') === 'true';
      const htmlInvalid =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
          ? !element.checkValidity()
          : false;
      if (!ariaInvalid && !htmlInvalid) {
        continue;
      }

      const label =
        normalizeText(element.getAttribute('aria-label')) ||
        normalizeText(element.getAttribute('name')) ||
        normalizeText(element.getAttribute('placeholder')) ||
        normalizeText(element.id);
      items.push('field:' + (label || 'invalid'));
      if (items.length >= 12) {
        return items.join('|');
      }
    }

    for (const element of Array.from(document.querySelectorAll(validationMessageSelectors.join(', ')))) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        continue;
      }

      const text = normalizeText(element.textContent || '');
      if (!text || !validationTextRe.test(text)) {
        continue;
      }

      items.push('message:' + text.slice(0, 160));
      if (items.length >= 12) {
        break;
      }
    }

    return items.join('|');
  };

  const body = document.body;
  if (!body) {
    return {
      content: '',
      structure: '',
      submitSignals: '',
      resultSignals: '',
      validationBlockerCount: 0,
    };
  }

  const attrs = body
    .getAttributeNames()
    .sort()
    .map((name) => name + '=' + (body.getAttribute(name) ?? ''))
    .join('|');
  const text = sampleText(normalizeText(body.innerText || ''), 6000);
  const controls = interactiveSummary();
  const stableControls = stableControlSummary();
  const dialogs = dialogSummary();
  const frames = frameSummary();
  const headings = headingSummary();
  const processing = processingSummary();
  const resultSignals = (() => {
    const selectors = [
      '[role="alert"]',
      '[aria-live="assertive"]',
      '[role="dialog"]',
      '[aria-modal="true"]',
    ];
    const items = [];

    for (const element of Array.from(document.querySelectorAll(selectors.join(', ')))) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        continue;
      }

      if (element.matches('[aria-busy="true"], [role="progressbar"]')) {
        continue;
      }

      const role = element.getAttribute('role') || '';
      const label =
        normalizeText(element.getAttribute('aria-label')) ||
        normalizeText(element.id) ||
        sampleText(normalizeText(element.textContent || ''), 160);
      if (!label) {
        continue;
      }

      items.push([role || 'live', label].join(':'));
      if (items.length >= 20) {
        break;
      }
    }

    return items.join('|');
  })();
  const validation = validationSummary();
  return {
    content: [attrs, text, controls, dialogs, frames].join('\n'),
    structure: [attrs, stableControls, dialogs, frames, headings].join('\n'),
    submitSignals: [processing, dialogs, frames, headings, stableControls].join('\n'),
    resultSignals,
    validationBlockerCount: validation ? validation.split('|').length : 0,
  };
})()`;
const NO_PROGRESS_PAGE_SIGNALS_SCRIPT = String.raw`(() => {
  const normalizeText = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = element.ownerDocument?.defaultView?.getComputedStyle(element);
    if (!style || style.display === 'none' || style.visibility !== 'visible') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const uniqueTexts = (elements, limit) => {
    const values = [];
    for (const element of elements) {
      if (!isVisible(element)) {
        continue;
      }
      const text = normalizeText(element.textContent);
      if (!text || values.includes(text)) {
        continue;
      }
      values.push(text.slice(0, 240));
      if (values.length >= limit) {
        break;
      }
    }
    return values;
  };
  const labelForField = (element) => {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    const ariaLabel = normalizeText(element.getAttribute('aria-label'));
    if (ariaLabel) {
      return ariaLabel;
    }

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      if (element.labels?.length) {
        const labels = Array.from(element.labels)
          .map((label) => normalizeText(label.textContent))
          .filter(Boolean);
        if (labels.length > 0) {
          return labels.join(' / ');
        }
      }
    }

    const placeholder = normalizeText(element.getAttribute('placeholder'));
    if (placeholder) {
      return placeholder;
    }

    const name = normalizeText(element.getAttribute('name'));
    if (name) {
      return name;
    }

    const id = normalizeText(element.id);
    if (id) {
      return id;
    }

    return normalizeText(element.textContent) || null;
  };
  const pushUniqueText = (values, nextValue, limit) => {
    const text = normalizeText(nextValue);
    if (!text || values.includes(text)) {
      return;
    }

    values.push(text.slice(0, 240));
    if (values.length > limit) {
      values.length = limit;
    }
  };
  const VALIDATION_TEXT_RE =
    /(?:required|invalid|incorrect|too\s+(?:short|long)|must|error|format|please\s+(?:enter|select|choose|fill)|невер|ошиб|обязател|заполн|введите|укажите|выберите|долж|нужно|формат|цифр|символ)/i;

  const fieldSelectors =
    'input, textarea, select, [role="textbox"], [contenteditable="true"], [aria-invalid="true"]';
  const relatedHelperTexts = (element) => {
    if (!(element instanceof HTMLElement)) {
      return [];
    }

    const values = [];
    const describedBy = normalizeText(element.getAttribute('aria-describedby'));
    if (describedBy) {
      for (const id of describedBy.split(/\s+/)) {
        const helper = document.getElementById(id);
        if (helper && isVisible(helper)) {
          const helperText = normalizeText(helper.textContent);
          if (VALIDATION_TEXT_RE.test(helperText)) {
            pushUniqueText(values, helperText, 4);
          }
        }
      }
    }

    let anchor = element.parentElement;
    for (let depth = 0; anchor && depth < 4 && values.length < 4; depth += 1, anchor = anchor.parentElement) {
      const anchorFieldCount = anchor.querySelectorAll(fieldSelectors).length;
      if (anchorFieldCount === 0 || anchorFieldCount > 3) {
        continue;
      }

      for (const candidate of Array.from(anchor.children)) {
        if (!(candidate instanceof HTMLElement)) {
          continue;
        }
        if (candidate === element || candidate.contains(element) || element.contains(candidate)) {
          continue;
        }
        if (!isVisible(candidate) || candidate.matches('label, legend')) {
          continue;
        }
        if (candidate.querySelector(fieldSelectors)) {
          continue;
        }

        const helperText = normalizeText(candidate.textContent);
        if (!VALIDATION_TEXT_RE.test(helperText)) {
          continue;
        }
        pushUniqueText(values, helperText, 4);
      }
    }

    return values;
  };

  const invalidFields = [];
  const messages = [];
  for (const element of Array.from(document.querySelectorAll(fieldSelectors))) {
    if (!isVisible(element)) {
      continue;
    }

    const ariaInvalid = element.getAttribute('aria-invalid') === 'true';
    const htmlInvalid =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? !element.checkValidity()
        : false;
    const helperMessages = relatedHelperTexts(element);

    if (!ariaInvalid && !htmlInvalid && helperMessages.length === 0) {
      continue;
    }

    const label = labelForField(element);
    if (!label || invalidFields.includes(label)) {
      continue;
    }
    invalidFields.push(label.slice(0, 140));
    for (const helperMessage of helperMessages) {
      pushUniqueText(messages, helperMessage, 6);
    }
    if (invalidFields.length >= 6) {
      break;
    }
  }

  const messageSelectors = [
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[aria-live="polite"]',
    '.error',
    '.errors',
    '.invalid-feedback',
    '.form-error',
    '.warning',
    '[data-testid*="error"]',
    '[data-testid*="warning"]',
  ];
  for (const message of uniqueTexts(Array.from(document.querySelectorAll(messageSelectors.join(', '))), 6)) {
    pushUniqueText(messages, message, 6);
  }

  const overlaySelectors = [
    '[role="alertdialog"]',
    '[role="dialog"][aria-modal="true"]',
    '[role="dialog"][data-state="open"]',
    '[data-state="open"][role="dialog"]',
  ];
  const blockingOverlays = uniqueTexts(
    Array.from(document.querySelectorAll(overlaySelectors.join(', '))),
    4
  );

  return {
    messages,
    invalidFields,
    blockingOverlays,
  };
})()`;

const SUBMIT_FOLLOW_UP_SURFACE_SCRIPT = String.raw`(() => {
  const normalizeText = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
  const sampleText = (value, limit = 120) => {
    const normalized = normalizeText(value);
    if (!normalized) {
      return '';
    }
    return normalized.length <= limit ? normalized : normalized.slice(0, limit - 1).trimEnd() + '…';
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
  const interactiveDescendantCountOf = (element) =>
    element.querySelectorAll(
      'button, [role="button"], input:not([type="hidden"]), textarea, select, a[href], [tabindex]:not([tabindex="-1"])'
    ).length;
  const overlayKeywordRe = /(modal|drawer|sheet|tray|popover|overlay|dialog)/i;
  const overlayHintOf = (element) =>
    [
      element.getAttribute('role') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('data-testid') || '',
      element.id || '',
      element.getAttribute('class') || '',
    ].join(' ');
  const positionedOverlayLike = (element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const style = element.ownerDocument?.defaultView?.getComputedStyle(element);
    if (!style) {
      return false;
    }
    const position = (style.position || '').toLowerCase();
    const zIndex = Number(style.zIndex || '0');
    const rect = element.getBoundingClientRect();
    const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
    const coverage = (rect.width * rect.height) / viewportArea;
    return (
      interactiveDescendantCountOf(element) >= 1 &&
      rect.width >= 160 &&
      rect.height >= 72 &&
      coverage >= 0.02 &&
      coverage <= 0.85 &&
      (position === 'fixed' ||
        position === 'sticky' ||
        (position === 'absolute' && Number.isFinite(zIndex) && zIndex > 0))
    );
  };
  const labelOf = (element) => {
    const heading = element.querySelector?.('h1, h2, h3, [role="heading"]');
    return (
      sampleText(element.getAttribute('aria-label')) ||
      sampleText(element.getAttribute('data-testid')) ||
      sampleText(element.id) ||
      sampleText(heading?.textContent || '') ||
      sampleText(element.textContent || '', 80)
    );
  };

  const items = [];
  const seen = new Set();
  const selector = [
    'dialog',
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[data-testid]',
    '[id]',
    '[class*="modal"]',
    '[class*="drawer"]',
    '[class*="sheet"]',
    '[class*="tray"]',
    '[class*="popover"]',
  ].join(', ');

  for (const element of Array.from(document.querySelectorAll(selector))) {
    if (!(element instanceof HTMLElement) || !isVisible(element)) {
      continue;
    }

    const overlayHint = overlayHintOf(element);
    const semanticOverlay =
      element.matches('dialog, [role="dialog"], [aria-modal="true"]') ||
      overlayKeywordRe.test(overlayHint);
    if (!semanticOverlay && !positionedOverlayLike(element)) {
      continue;
    }

    const label = labelOf(element);
    const summary = [
      sampleText(element.getAttribute('role') || element.tagName.toLowerCase(), 24) || 'surface',
      label || 'visible',
      sampleText(element.getAttribute('data-testid') || '', 48),
    ]
      .filter(Boolean)
      .join(':');
    if (!summary) {
      continue;
    }

    const key = summary.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(summary);
    if (items.length >= 12) {
      break;
    }
  }

  return items.join('|');
})()`;

function hashText(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return String(hash);
}

export async function captureSubmitFollowUpSurfaceHash(page: Page): Promise<string | null> {
  const summary = await page
    .evaluate<string | null | undefined>(SUBMIT_FOLLOW_UP_SURFACE_SCRIPT)
    .catch(() => '');
  const normalized = typeof summary === 'string' ? summary.trim() : '';
  return normalized ? hashText(normalized) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function rankLocatorCandidates(
  candidates: ReadonlyArray<NonNullable<ReturnType<typeof getTarget>>['locatorCandidates'][number]>,
  action: BrowseAction
) {
  const priority = ACTION_CANDIDATE_PRIORITY[action];
  if (!priority) {
    return [...candidates];
  }

  return [...candidates].sort((left, right) => {
    const leftPriority = priority[left.strategy] ?? 99;
    const rightPriority = priority[right.strategy] ?? 99;
    return leftPriority - rightPriority;
  });
}

export function shouldVerifyObservableProgress(
  target: TargetDescriptor,
  action: BrowseAction
): boolean {
  if (action === 'fill' || action === 'type') {
    return false;
  }

  if (action === 'press' && isEditableLikeTarget(target)) {
    return false;
  }

  return action === 'click' || action === 'press' || action === 'select';
}

function isEditableLikeTarget(target: TargetDescriptor): boolean {
  if (
    target.controlFamily === 'text-input' ||
    target.controlFamily === 'select' ||
    target.controlFamily === 'datepicker'
  ) {
    return true;
  }
  const kind = (target.kind ?? '').toLowerCase();
  const role = (target.semantics?.role ?? '').toLowerCase();
  return (
    ['input', 'textarea', 'select', 'combobox'].includes(kind) ||
    ['textbox', 'combobox'].includes(role) ||
    target.allowedActions.includes('fill') ||
    target.allowedActions.includes('type') ||
    target.allowedActions.includes('select')
  );
}

function isSelectableChoiceTarget(target: TargetDescriptor): boolean {
  const kind = (target.kind ?? '').toLowerCase();
  const role = (target.semantics?.role ?? '').toLowerCase();

  return (
    kind === 'option' ||
    role === 'option' ||
    role === 'menuitem' ||
    role === 'gridcell' ||
    target.structure?.family === 'structured-grid'
  );
}

function acceptancePolicyForAction(
  target: TargetDescriptor,
  action: BrowseAction
): TargetDescriptor['acceptancePolicy'] {
  if (action === 'press' && isEditableLikeTarget(target)) {
    return undefined;
  }

  if (
    (action === 'fill' || action === 'type') &&
    target.controlFamily === 'select' &&
    target.allowedActions.includes('fill') &&
    target.allowedActions.includes('select') &&
    (target.kind ?? '').toLowerCase() !== 'select' &&
    (target.semantics?.role ?? '').toLowerCase() === 'combobox'
  ) {
    return 'selection';
  }

  if (action === 'select') {
    if (target.controlFamily === 'datepicker') {
      return 'date-selection';
    }
    if (target.controlFamily === 'select') {
      return 'selection';
    }
  }

  if (action === 'click' || action === 'press') {
    if (target.controlFamily === 'datepicker') {
      return isSelectableChoiceTarget(target) ? 'date-selection' : 'disclosure';
    }
    if (target.controlFamily === 'select') {
      return isSelectableChoiceTarget(target) ? 'selection' : 'disclosure';
    }
  }

  const policy = target.acceptancePolicy;
  if (!policy) {
    return undefined;
  }

  if (
    (action === 'click' || action === 'press') &&
    policy === 'value-change' &&
    isEditableLikeTarget(target)
  ) {
    return 'generic-click';
  }

  return policy;
}

function trackedStateKeys(
  target: TargetDescriptor,
  action: BrowseAction,
  policy: TargetDescriptor['acceptancePolicy']
): TargetStateKey[] {
  const states = target.semantics?.states;
  const keys = new Set<TargetStateKey>();

  if (states) {
    for (const key of ['selected', 'checked', 'expanded', 'pressed', 'current'] as const) {
      if (Object.prototype.hasOwnProperty.call(states, key)) {
        keys.add(key);
      }
    }
  }

  if (
    policy === 'disclosure' &&
    (action === 'click' || action === 'press') &&
    (target.controlFamily === 'select' || target.controlFamily === 'datepicker')
  ) {
    keys.add('expanded');
  }

  return [...keys];
}

export async function capturePageObservation(page: Page): Promise<PageObservation> {
  const snapshot =
    typeof page.evaluate === 'function'
      ? await Promise.resolve(
          page.evaluate<
            | string
            | {
                content?: string;
                structure?: string;
                submitSignals?: string;
                resultSignals?: string;
                validationBlockerCount?: number;
              }
          >(PAGE_OBSERVATION_SCRIPT)
        ).catch(() => '')
      : '';
  const contentSnapshot = typeof snapshot === 'string' ? snapshot : (snapshot?.content ?? '');
  const structureSnapshot = typeof snapshot === 'string' ? '' : (snapshot?.structure ?? '');
  const submitSignalSnapshot = typeof snapshot === 'string' ? '' : (snapshot?.submitSignals ?? '');
  const resultSignalSnapshot = typeof snapshot === 'string' ? '' : (snapshot?.resultSignals ?? '');
  const validationBlockerCount =
    typeof snapshot === 'string'
      ? 0
      : typeof snapshot?.validationBlockerCount === 'number'
        ? snapshot.validationBlockerCount
        : 0;

  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    contentHash: contentSnapshot ? hashText(contentSnapshot) : null,
    structureHash: structureSnapshot ? hashText(structureSnapshot) : null,
    submitSignalHash: submitSignalSnapshot ? hashText(submitSignalSnapshot) : null,
    resultSignalHash: resultSignalSnapshot ? hashText(resultSignalSnapshot) : null,
    validationBlockerCount,
  };
}

async function readLocatorText(locator: Locator): Promise<string | null> {
  const count = await locator.count().catch(() => 0);
  if (count === 0) {
    return null;
  }

  const normalizedInnerText =
    typeof locator.innerText === 'function'
      ? await locator
          .innerText()
          .then((value) => value.replace(/\s+/g, ' ').trim())
          .catch(() => '')
      : '';
  if (normalizedInnerText) {
    return normalizedInnerText;
  }

  const normalizedTextContent =
    typeof locator.textContent === 'function'
      ? await locator
          .textContent()
          .then((value) => (value ?? '').replace(/\s+/g, ' ').trim())
          .catch(() => '')
      : '';
  return normalizedTextContent || null;
}

export async function captureLocatorContextHash(locator: Locator): Promise<string | null> {
  const candidates: Locator[] = [];

  if (typeof locator.locator === 'function') {
    const ancestorContext = locator.locator(
      'xpath=ancestor-or-self::*[' +
        '@role="option" or @role="row" or @role="gridcell" or @role="listitem" or ' +
        '@role="tabpanel" or @role="dialog" or @role="listbox" or @role="menu" or @role="grid" or ' +
        'self::article or self::li or self::tr or self::td or self::section or self::form' +
        '][1]'
    );
    const ancestorCount = await ancestorContext.count().catch(() => 0);
    if (ancestorCount > 0) {
      candidates.push(
        typeof ancestorContext.first === 'function' ? ancestorContext.first() : ancestorContext
      );
    }
  }

  candidates.push(typeof locator.first === 'function' ? locator.first() : locator);

  for (const candidate of candidates) {
    const text = await readLocatorText(candidate);
    if (text) {
      return hashText(text);
    }
  }

  return null;
}

async function shouldProbePopupCurrentValue(locator: Locator): Promise<boolean> {
  const readAttribute = async (name: string): Promise<string | null> => {
    if (typeof locator.getAttribute !== 'function') {
      return null;
    }
    return locator.getAttribute(name).catch(() => null);
  };
  const [role, ariaHasPopup, ariaControls, ariaExpanded] = await Promise.all([
    readAttribute('role'),
    readAttribute('aria-haspopup'),
    readAttribute('aria-controls'),
    readAttribute('aria-expanded'),
  ]);

  return (
    Boolean((ariaControls || '').trim()) ||
    ['listbox', 'menu'].includes((ariaHasPopup || '').toLowerCase()) ||
    (role || '').toLowerCase() === 'combobox' ||
    ariaExpanded !== null
  );
}

async function captureLocatorValue(locator: Locator): Promise<string | null> {
  const count = await locator.count().catch(() => 0);
  if (count === 0) {
    return null;
  }

  const inputValue =
    typeof locator.inputValue === 'function' ? await locator.inputValue().catch(() => '') : '';
  if (inputValue) {
    return inputValue;
  }

  if (!(await shouldProbePopupCurrentValue(locator))) {
    return readLocatorText(locator);
  }

  const popupCurrentValue = await locator
    .evaluate((element, source) => {
      const read = Function(
        'element',
        `${source}
        if (!(element instanceof HTMLElement)) {
          return null;
        }
        return observedPopupCurrentValueOf(element) || null;`
      );
      return read(element) as string | null;
    }, OBSERVE_DOM_LABEL_CONTRACT_HELPER_SCRIPT)
    .catch(() => null);
  if (popupCurrentValue) {
    return popupCurrentValue;
  }

  return readLocatorText(locator);
}

async function captureLocatorValueFromCandidates(
  locators: ReadonlyArray<Locator>
): Promise<string | null> {
  let fallbackValue: string | null = null;

  for (const locator of locators) {
    const value = await captureLocatorValue(locator).catch(() => null);
    if (value) {
      return value;
    }
    if (value !== null && fallbackValue === null) {
      fallbackValue = value;
    }
  }

  return fallbackValue;
}

async function captureSelectedOptionText(locator: Locator): Promise<string | null> {
  return locator
    .evaluate((element) => {
      if (!(element instanceof HTMLSelectElement)) {
        return null;
      }

      const selected = element.options[element.selectedIndex] ?? null;
      const text = (selected?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return text || null;
    })
    .catch(() => null);
}

function pushComparableValue(values: string[], nextValue: string | null | undefined): void {
  const raw = (nextValue ?? '').replace(/\s+/g, ' ').trim();
  const normalized = normalizeComparableValue(raw);
  if (!normalized) {
    return;
  }

  if (values.some((existing) => normalizeComparableValue(existing) === normalized)) {
    return;
  }

  values.push(raw);
}

async function captureLocatorComparableValues(locator: Locator): Promise<string[]> {
  const count = await locator.count().catch(() => 0);
  if (count === 0) {
    return [];
  }

  const values: string[] = [];
  pushComparableValue(values, await captureLocatorValue(locator));
  pushComparableValue(values, await captureSelectedOptionText(locator));
  return values;
}

async function captureLocatorComparableValuesFromCandidates(
  locators: ReadonlyArray<Locator>
): Promise<string[]> {
  const values: string[] = [];

  for (const locator of locators) {
    const nextValues = await captureLocatorComparableValues(locator).catch(() => []);
    for (const nextValue of nextValues) {
      pushComparableValue(values, nextValue);
    }
  }

  return values;
}

async function captureLocatorStateFromCandidates(
  locators: ReadonlyArray<Locator>,
  keys: ReadonlyArray<TargetStateKey>
): Promise<LocatorStateObservation | null> {
  for (const locator of locators) {
    const state = await captureLocatorState(locator, keys).catch(() => null);
    if (state && Object.keys(state).length > 0) {
      return state;
    }
  }

  return null;
}

async function captureLocatorContextHashFromCandidates(
  locators: ReadonlyArray<Locator>
): Promise<string | null> {
  for (const locator of locators) {
    const hash = await captureLocatorContextHash(locator).catch(() => null);
    if (hash) {
      return hash;
    }
  }

  return null;
}

function comparableValueTypeForTarget(target: TargetDescriptor): ComparableValueType | undefined {
  return inferComparableValueTypeFromFacts({
    kind: target.kind,
    role: target.semantics?.role,
    label: target.label,
    displayLabel: target.displayLabel,
    placeholder: target.placeholder,
    inputName: target.inputName,
    inputType: target.inputType,
    autocomplete: target.autocomplete,
    states: target.semantics?.states,
    structure: target.structure,
  });
}

function normalizeComparableValue(
  value: string | null,
  comparableValueType?: ComparableValueType
): string {
  const raw = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) {
    return '';
  }

  if (
    comparableValueType === 'card-number' ||
    comparableValueType === 'expiry' ||
    comparableValueType === 'cvc'
  ) {
    return raw.replace(/\D/g, '');
  }

  if (comparableValueType === 'date') {
    const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
      return `${isoMatch[1]}${isoMatch[2]}${isoMatch[3]}`;
    }

    const localizedMatch = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
    if (localizedMatch) {
      const [, day = '', month = '', year = ''] = localizedMatch;
      if (!day || !month || !year) {
        return raw.replace(/\D/g, '');
      }
      const normalizedYear = year.length === 2 ? `20${year}` : year.padStart(4, '0');
      return `${normalizedYear}${month.padStart(2, '0')}${day.padStart(2, '0')}`;
    }

    return raw.replace(/\D/g, '');
  }

  if (
    comparableValueType === 'phone' ||
    (!comparableValueType && /^\+?[\d\s().-]{5,}$/.test(raw))
  ) {
    const normalized = raw.replace(/[^\d+]/g, '');
    return normalized.startsWith('+') ? `+${normalized.slice(1).replace(/\+/g, '')}` : normalized;
  }

  return raw.toLowerCase();
}

function valuesMatchExpected(
  expected: string | null,
  actual: string | null,
  comparableValueType?: ComparableValueType,
  options?: {
    allowCompactActualSequence?: boolean;
  }
): boolean {
  const normalizedExpected = normalizeComparableValue(expected, comparableValueType);
  const normalizedActual = normalizeComparableValue(actual, comparableValueType);
  if (!normalizedExpected || !normalizedActual) {
    return false;
  }
  if (normalizedActual === normalizedExpected || normalizedActual.includes(normalizedExpected)) {
    return true;
  }

  if (options?.allowCompactActualSequence !== true) {
    return false;
  }

  const expectedTokens = normalizedExpected.split(/\s+/).filter(Boolean);
  const actualTokens = normalizedActual.split(/\s+/).filter(Boolean);
  if (actualTokens.length === 0 || actualTokens.length > expectedTokens.length) {
    return false;
  }
  const compactActualLooksCodeLike = actualTokens.every(
    (token) => token.length <= 3 || /[\d+]/.test(token)
  );
  if (!compactActualLooksCodeLike) {
    return false;
  }

  for (let index = 0; index <= expectedTokens.length - actualTokens.length; index += 1) {
    const matches = actualTokens.every(
      (token, tokenIndex) => expectedTokens[index + tokenIndex] === token
    );
    if (matches) {
      return true;
    }
  }

  return false;
}

function valuesMatchAnyExpected(
  expected: string | null,
  actualValues: ReadonlyArray<string>,
  comparableValueType?: ComparableValueType,
  options?: {
    allowCompactActualSequence?: boolean;
  }
): boolean {
  return actualValues.some((actualValue) =>
    valuesMatchExpected(expected, actualValue, comparableValueType, options)
  );
}

function expectedValueForAcceptance(
  action: BrowseAction,
  actionValue: string | undefined
): string | null {
  if (action === 'fill' || action === 'type' || action === 'select') {
    return actionValue ?? null;
  }

  return null;
}

function recoveryDescendantSelector(target: TargetDescriptor, action: BrowseAction): string | null {
  if (action === 'fill' || action === 'type') {
    return 'input:not([type="hidden"]), textarea, select, [contenteditable="true"]';
  }

  if (
    (action === 'click' || action === 'press') &&
    (target.controlFamily === 'text-input' ||
      target.controlFamily === 'select' ||
      target.controlFamily === 'datepicker')
  ) {
    return 'input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]';
  }

  return null;
}

async function prepareReadLocator(
  locator: Locator,
  target: TargetDescriptor,
  action: BrowseAction
): Promise<Locator | null> {
  const visible = await isLocatorUserActionable(locator);
  if (!visible) {
    return null;
  }

  const descendantSelector = recoveryDescendantSelector(target, action);
  if (!descendantSelector) {
    return locator;
  }

  const requiresEditableDescendant = action === 'fill' || action === 'type';
  if (requiresEditableDescendant) {
    const editable = await locator.isEditable().catch(() => false);
    if (editable) {
      return locator;
    }
  }

  const descendants = locator.locator(descendantSelector);
  const count = await descendants.count().catch(() => 0);
  const visibleDescendants: Locator[] = [];

  for (let index = 0; index < count; index += 1) {
    const descendant = descendants.nth(index);
    const descendantVisible = await isLocatorUserActionable(descendant);
    if (!descendantVisible) {
      continue;
    }

    if (requiresEditableDescendant) {
      const editable = await descendant.isEditable().catch(() => false);
      if (!editable) {
        continue;
      }
    }

    visibleDescendants.push(descendant);
  }

  if (visibleDescendants.length === 1) {
    return visibleDescendants[0] ?? null;
  }

  return requiresEditableDescendant ? null : locator;
}

function valueMeaningfullyChanged(before: string | null, after: string | null): boolean {
  const normalizedBefore = normalizeComparableValue(before);
  const normalizedAfter = normalizeComparableValue(after);
  if (!normalizedAfter) {
    return false;
  }
  return normalizedBefore !== normalizedAfter;
}

export const __testComparableValues = {
  comparableValueTypeForTarget,
  normalizeComparableValue,
  valuesMatchExpected,
};

export async function captureLocatorState(
  locator: Locator,
  keys: ReadonlyArray<TargetStateKey>
): Promise<LocatorStateObservation | null> {
  if (keys.length === 0) {
    return null;
  }

  const count = await locator.count().catch(() => 0);
  if (count === 0) {
    return { current: 'missing' };
  }

  const state: LocatorStateObservation = {};
  const readAttribute = async (name: string): Promise<string | null> => {
    if (typeof locator.getAttribute !== 'function') {
      return null;
    }
    return locator.getAttribute(name).catch(() => null);
  };
  const heuristicFlags = await locator
    .evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        return { selected: null, current: null, pressed: null };
      }

      const blob =
        (element.getAttribute('class') || '').toLowerCase() +
        ' ' +
        (element.getAttribute('data-state') || '').toLowerCase() +
        ' ' +
        (element.getAttribute('data-status') || '').toLowerCase() +
        ' ' +
        Object.values(element.dataset || {})
          .join(' ')
          .toLowerCase();

      const active = /(?:selected|active|current)\b/.test(blob);
      const pressed = /(?:pressed|active)\b/.test(blob);

      return {
        selected: active,
        current: active,
        pressed,
      };
    })
    .catch(() => ({ selected: null, current: null, pressed: null }));
  const associatedChoiceState = keys.includes('checked')
    ? await locator
        .evaluate(
          (element, source) =>
            Function('element', source)(element) as { checked: boolean | 'mixed' } | null,
          ASSOCIATED_CHOICE_STATE_HELPER_SCRIPT
        )
        .catch(() => null)
    : null;
  for (const key of keys) {
    switch (key) {
      case 'checked': {
        if (typeof locator.isChecked === 'function') {
          const checked = await locator.isChecked().catch(() => undefined);
          if (typeof checked === 'boolean') {
            state.checked = checked;
            break;
          }
        }

        const ariaChecked = await readAttribute('aria-checked');
        if (ariaChecked === 'true') state.checked = true;
        else if (ariaChecked === 'false') state.checked = false;
        else if (ariaChecked === 'mixed') state.checked = 'mixed';
        else if (associatedChoiceState && typeof associatedChoiceState === 'object') {
          state.checked = associatedChoiceState.checked;
        }
        break;
      }

      case 'selected': {
        const value = await readAttribute('aria-selected');
        if (value === 'true') state.selected = true;
        else if (value === 'false') state.selected = false;
        else if (typeof heuristicFlags.selected === 'boolean')
          state.selected = heuristicFlags.selected;
        break;
      }

      case 'expanded': {
        const value = await readAttribute('aria-expanded');
        if (value === 'true') state.expanded = true;
        else if (value === 'false') state.expanded = false;
        break;
      }

      case 'pressed': {
        const value = await readAttribute('aria-pressed');
        if (value === 'true') state.pressed = true;
        else if (value === 'false') state.pressed = false;
        else if (typeof heuristicFlags.pressed === 'boolean')
          state.pressed = heuristicFlags.pressed;
        break;
      }

      case 'current': {
        const value = await readAttribute('aria-current');
        if (value === 'true') state.current = true;
        else if (typeof value === 'string' && value.length > 0) state.current = value;
        else if (typeof heuristicFlags.current === 'boolean')
          state.current = heuristicFlags.current;
        break;
      }

      case 'focused': {
        const focused = await locator
          .evaluate((element) => {
            if (!(element instanceof HTMLElement)) {
              return false;
            }

            return (
              element.matches?.(':focus') === true ||
              element.ownerDocument?.activeElement === element
            );
          })
          .catch(() => false);
        state.focused = focused;
        break;
      }
    }
  }

  return Object.keys(state).length > 0 ? state : null;
}

export function locatorStateChanged(
  before: LocatorStateObservation | null,
  after: LocatorStateObservation | null
): boolean {
  if (!before && !after) {
    return false;
  }

  if (!before) {
    return Boolean(after && Object.keys(after).length > 0);
  }

  if (!after) {
    return Object.keys(before).length > 0;
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (before[key as TargetStateKey] !== after[key as TargetStateKey]) {
      return true;
    }
  }
  return false;
}

export function pageObservationChanged(
  before: PageObservation | null,
  after: PageObservation | null
): boolean {
  if (!before || !after) {
    return false;
  }

  if (before.url !== after.url || before.title !== after.title) {
    return true;
  }

  if (before.contentHash && after.contentHash && before.contentHash !== after.contentHash) {
    return true;
  }

  return false;
}

export function genericClickObservationChanged(
  before: PageObservation | null,
  after: PageObservation | null
): boolean {
  if (!before || !after) {
    return false;
  }

  if (before.url !== after.url || before.title !== after.title) {
    return true;
  }

  if (
    (before.structureHash || after.structureHash) &&
    before.structureHash !== after.structureHash
  ) {
    return true;
  }

  if (
    (before.submitSignalHash || after.submitSignalHash) &&
    before.submitSignalHash !== after.submitSignalHash
  ) {
    return true;
  }

  if (
    (before.resultSignalHash || after.resultSignalHash) &&
    before.resultSignalHash !== after.resultSignalHash
  ) {
    return true;
  }

  if (before.validationBlockerCount > after.validationBlockerCount) {
    return true;
  }

  return false;
}

export function submitObservationChanged(
  before: PageObservation | null,
  after: PageObservation | null
): boolean {
  if (!before || !after) {
    return false;
  }

  if (before.url !== after.url || before.title !== after.title) {
    return true;
  }

  if (before.structureHash && after.structureHash && before.structureHash !== after.structureHash) {
    return true;
  }

  if (before.validationBlockerCount > 0 && after.validationBlockerCount === 0) {
    return true;
  }

  return false;
}

type NoProgressPageSignalsSnapshot = {
  messages: string[];
  invalidFields: string[];
  blockingOverlays: string[];
};

function normalizeObservationText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function mergeUniqueObservationTexts(
  target: string[],
  values: ReadonlyArray<string>,
  limit: number
): void {
  for (const value of values) {
    const normalized = normalizeObservationText(value);
    if (!normalized || target.includes(normalized)) {
      continue;
    }

    target.push(normalized);
    if (target.length >= limit) {
      return;
    }
  }
}

async function walkChildFrames(page: Page, visit: (frame: Frame) => Promise<void>): Promise<void> {
  if (typeof page.mainFrame !== 'function') {
    return;
  }

  const mainFrame = page.mainFrame();
  if (!mainFrame || typeof mainFrame.childFrames !== 'function') {
    return;
  }

  let visitedFrames = 0;
  const isFrameHostVisible = async (frame: Frame): Promise<boolean> => {
    if (typeof frame.frameElement !== 'function') {
      return true;
    }

    const frameElement = await frame.frameElement().catch(() => null);
    if (!frameElement) {
      return false;
    }

    try {
      return await frameElement.evaluate((element) => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const style = element.ownerDocument?.defaultView?.getComputedStyle(element);
        if (
          !style ||
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse'
        ) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    } catch {
      return false;
    } finally {
      await frameElement.dispose().catch(() => undefined);
    }
  };
  const walk = async (frame: Frame): Promise<void> => {
    const childFrames = frame.childFrames().slice(0, CHILD_FRAME_SIGNAL_LIMIT);
    for (const childFrame of childFrames) {
      if (visitedFrames >= CHILD_FRAME_SIGNAL_LIMIT) {
        return;
      }

      visitedFrames += 1;
      if (!(await isFrameHostVisible(childFrame))) {
        continue;
      }
      await visit(childFrame).catch(() => undefined);
      await walk(childFrame);
    }
  };

  await walk(mainFrame);
}

async function readNoProgressPageSignals(
  documentRoot: Page | Frame
): Promise<NoProgressPageSignalsSnapshot> {
  const pageSignals = await Promise.resolve(
    documentRoot.evaluate<{
      messages?: unknown;
      invalidFields?: unknown;
      blockingOverlays?: unknown;
    }>(NO_PROGRESS_PAGE_SIGNALS_SCRIPT)
  ).catch(() => null);

  if (!pageSignals || typeof pageSignals !== 'object' || Array.isArray(pageSignals)) {
    return {
      messages: [],
      invalidFields: [],
      blockingOverlays: [],
    };
  }

  return {
    messages: Array.isArray(pageSignals.messages)
      ? pageSignals.messages.filter((value): value is string => typeof value === 'string')
      : [],
    invalidFields: Array.isArray(pageSignals.invalidFields)
      ? pageSignals.invalidFields.filter((value): value is string => typeof value === 'string')
      : [],
    blockingOverlays: Array.isArray(pageSignals.blockingOverlays)
      ? pageSignals.blockingOverlays.filter((value): value is string => typeof value === 'string')
      : [],
  };
}

export async function diagnoseNoObservableProgress(
  page: Page,
  locator: Locator
): Promise<NoObservableProgressObservations | null> {
  const targetState = await locator
    .evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        return {};
      }

      const readonly =
        element.hasAttribute('readonly') ||
        element.getAttribute('aria-readonly') === 'true' ||
        ('readOnly' in element &&
          typeof (element as HTMLInputElement | HTMLTextAreaElement).readOnly === 'boolean' &&
          (element as HTMLInputElement | HTMLTextAreaElement).readOnly);

      return {
        disabled: Boolean((element as HTMLButtonElement | HTMLInputElement).disabled),
        ariaDisabled: element.getAttribute('aria-disabled') === 'true',
        readonly,
        centerHitSelf: (() => {
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            return false;
          }

          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const hit = element.ownerDocument?.elementFromPoint(centerX, centerY);
          return Boolean(
            hit &&
              (hit === element ||
                element.contains(hit) ||
                (hit instanceof HTMLElement && hit.shadowRoot?.contains(element)))
          );
        })(),
      };
    })
    .catch(() => ({}));

  const aggregatedSignals = await readNoProgressPageSignals(page);
  await walkChildFrames(page, async (frame) => {
    const frameSignals = await readNoProgressPageSignals(frame);
    mergeUniqueObservationTexts(
      aggregatedSignals.messages,
      frameSignals.messages,
      NO_PROGRESS_SIGNAL_LIMIT
    );
    mergeUniqueObservationTexts(
      aggregatedSignals.invalidFields,
      frameSignals.invalidFields,
      NO_PROGRESS_SIGNAL_LIMIT
    );
    mergeUniqueObservationTexts(
      aggregatedSignals.blockingOverlays,
      frameSignals.blockingOverlays,
      NO_PROGRESS_OVERLAY_LIMIT
    );
  });

  const messages = aggregatedSignals.messages;
  const invalidFields = aggregatedSignals.invalidFields;
  const rawTargetState =
    targetState && typeof targetState === 'object' && !Array.isArray(targetState)
      ? (targetState as {
          disabled?: unknown;
          ariaDisabled?: unknown;
          readonly?: unknown;
          centerHitSelf?: unknown;
        })
      : undefined;
  const disabled =
    rawTargetState && (Boolean(rawTargetState.disabled) || Boolean(rawTargetState.ariaDisabled));
  const readonly = rawTargetState ? Boolean(rawTargetState.readonly) : false;
  const normalizedTargetState =
    disabled || readonly
      ? {
          ...(disabled ? { disabled: true } : {}),
          ...(readonly ? { readonly: true } : {}),
        }
      : undefined;

  return {
    visibleMessages: messages,
    invalidFields,
    ...(normalizedTargetState ? { targetState: normalizedTargetState } : {}),
  };
}

async function resolveTargetLocatorForRead(
  page: Page,
  target: TargetDescriptor,
  surface: SurfaceDescriptor | null,
  action: BrowseAction = 'click'
): Promise<Locator | null> {
  const surfaceRoot = await resolveSurfaceScopeRoot(page, surface);
  const baseRoot = resolveLocatorRoot(page, target.framePath ?? surface?.framePath);
  const defaultRoot = surfaceRoot ?? baseRoot;

  for (const candidate of rankLocatorCandidates(target.locatorCandidates, action)) {
    const locatorRoot =
      candidate.scope === 'root'
        ? baseRoot
        : candidate.scope === 'surface'
          ? surfaceRoot
          : defaultRoot;
    if (!locatorRoot) {
      continue;
    }

    const locator = buildLocator(locatorRoot, candidate);
    if (!locator) continue;
    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;
    const first = locator.first();
    const prepared = await prepareReadLocator(first, target, action);
    if (!prepared) continue;
    return prepared;
  }

  const descendantSelector = recoveryDescendantSelector(target, action);
  if (!surfaceRoot || !descendantSelector) {
    return null;
  }

  const descendants = surfaceRoot.locator(descendantSelector);
  const descendantCount = await descendants.count().catch(() => 0);
  const visibleDescendants: Locator[] = [];

  for (let index = 0; index < descendantCount; index += 1) {
    const descendant = descendants.nth(index);
    const visible = await isLocatorUserActionable(descendant);
    if (!visible) {
      continue;
    }

    if (action === 'fill' || action === 'type') {
      const editable = await descendant.isEditable().catch(() => false);
      if (!editable) {
        continue;
      }
    }

    visibleDescendants.push(descendant);
  }

  return visibleDescendants.length === 1 ? (visibleDescendants[0] ?? null) : null;
}

export async function createAcceptanceProbe(args: {
  session: BrowseSession;
  page: Page;
  target: TargetDescriptor;
  action: BrowseAction;
  actionValue: string | undefined;
  locator: Locator;
  beforePageObservation: PageObservation | null;
}): Promise<AcceptanceProbe | null> {
  const { session, page, target, action, actionValue, locator, beforePageObservation } = args;
  const policy = acceptancePolicyForAction(target, action);
  if (!policy) {
    return null;
  }

  const trackedStates = shouldVerifyObservableProgress(target, action)
    ? trackedStateKeys(target, action, policy)
    : [];
  if (
    (action === 'click' || action === 'press') &&
    policy === 'generic-click' &&
    isEditableLikeTarget(target) &&
    !trackedStates.includes('focused')
  ) {
    trackedStates.push('focused');
  }
  const beforeLocatorObservation =
    trackedStates.length > 0 ? await captureLocatorState(locator, trackedStates) : null;
  const beforeContextHash =
    policy === 'value-change' || policy === 'submit'
      ? null
      : await captureLocatorContextHash(locator);
  const surface = target.surfaceRef ? getSurface(session, target.surfaceRef) : null;
  const surfaceLocator = surface ? await resolveSurfaceScopeRoot(page, surface) : null;
  const pageReadLocator = await resolveTargetLocatorForRead(page, target, surface, action);
  const readLocator = pageReadLocator ?? locator;
  const readLocators =
    pageReadLocator && pageReadLocator !== locator ? [locator, pageReadLocator] : [locator];
  const beforeReadLocatorObservation =
    trackedStates.length > 0
      ? await captureLocatorStateFromCandidates([readLocator], trackedStates)
      : null;
  const beforeReadContextHash =
    policy === 'value-change' || policy === 'submit'
      ? null
      : await captureLocatorContextHashFromCandidates([readLocator]);
  const beforeValue = await captureLocatorValueFromCandidates(readLocators);

  const ownerTarget = target.ownerRef ? getTarget(session, target.ownerRef) : null;
  const ownerSurface = ownerTarget?.surfaceRef ? getSurface(session, ownerTarget.surfaceRef) : null;
  const ownerLocator = ownerTarget
    ? await resolveTargetLocatorForRead(page, ownerTarget, ownerSurface, action)
    : null;
  const beforeOwnerValue =
    ownerLocator && (policy === 'selection' || policy === 'date-selection')
      ? await captureLocatorValue(ownerLocator)
      : null;
  const beforeSurfaceContextHash =
    surfaceLocator &&
    ((target.structure?.family === 'structured-grid' &&
      (policy === 'selection' || policy === 'date-selection')) ||
      policy === 'submit')
      ? await captureLocatorContextHash(surfaceLocator)
      : null;
  const beforeFollowUpSurfaceHash =
    policy === 'submit' ? await captureSubmitFollowUpSurfaceHash(page) : null;
  const comparableValueType = comparableValueTypeForTarget(target);

  return {
    policy,
    page,
    target,
    action,
    surface,
    ownerTarget,
    ownerSurface,
    beforePage: beforePageObservation,
    beforeLocator: beforeLocatorObservation,
    beforeContextHash,
    beforeReadLocator: beforeReadLocatorObservation,
    beforeReadContextHash,
    trackedStateKeys: trackedStates,
    locator,
    readLocator,
    readLocators,
    surfaceLocator,
    expectedValue: expectedValueForAcceptance(action, actionValue),
    beforeValue,
    comparableValueType,
    ownerLocator,
    beforeOwnerValue,
    beforeSurfaceContextHash,
    beforeFollowUpSurfaceHash,
  };
}

export async function evaluateAcceptanceProbe(
  probe: AcceptanceProbe,
  afterPageObservation: PageObservation | null
): Promise<boolean> {
  const liveReadLocator =
    (await resolveTargetLocatorForRead(probe.page, probe.target, probe.surface, probe.action).catch(
      () => null
    )) ?? probe.readLocator;
  const liveReadLocators =
    liveReadLocator && liveReadLocator !== probe.locator
      ? [probe.locator, liveReadLocator]
      : [probe.locator];
  const liveOwnerLocator = probe.ownerTarget
    ? ((await resolveTargetLocatorForRead(
        probe.page,
        probe.ownerTarget,
        probe.ownerSurface,
        probe.action
      ).catch(() => null)) ?? probe.ownerLocator)
    : null;
  const liveSurfaceLocator =
    probe.target.structure?.family === 'structured-grid' && probe.surface
      ? ((await resolveSurfaceScopeRoot(probe.page, probe.surface).catch(() => null)) ??
        probe.surfaceLocator)
      : probe.surfaceLocator;
  const afterLocatorObservation =
    probe.trackedStateKeys.length > 0
      ? await captureLocatorState(probe.locator, probe.trackedStateKeys)
      : null;
  const afterContextHash =
    probe.policy === 'value-change' || probe.policy === 'submit'
      ? probe.beforeContextHash
      : await captureLocatorContextHash(probe.locator);
  const afterReadLocatorObservation =
    probe.trackedStateKeys.length > 0
      ? await captureLocatorStateFromCandidates([liveReadLocator], probe.trackedStateKeys)
      : null;
  const afterReadContextHash =
    probe.policy === 'value-change' || probe.policy === 'submit'
      ? probe.beforeReadContextHash
      : await captureLocatorContextHashFromCandidates([liveReadLocator]);
  const afterValue = await captureLocatorValueFromCandidates(liveReadLocators);
  const afterOwnerValue = liveOwnerLocator ? await captureLocatorValue(liveOwnerLocator) : null;
  const afterSurfaceContextHash =
    liveSurfaceLocator &&
    probe.target.structure?.family === 'structured-grid' &&
    (probe.policy === 'selection' || probe.policy === 'date-selection')
      ? await captureLocatorContextHash(liveSurfaceLocator)
      : probe.beforeSurfaceContextHash;
  const targetValueChanged =
    probe.expectedValue === null && valueMeaningfullyChanged(probe.beforeValue, afterValue);
  const ownerValueChanged =
    probe.expectedValue === null &&
    valueMeaningfullyChanged(probe.beforeOwnerValue, afterOwnerValue);
  const surfaceContextChanged =
    probe.expectedValue === null &&
    probe.beforeSurfaceContextHash !== null &&
    afterSurfaceContextHash !== null &&
    probe.beforeSurfaceContextHash !== afterSurfaceContextHash;

  switch (probe.policy) {
    case 'value-change':
      return valuesMatchExpected(probe.expectedValue, afterValue, probe.comparableValueType);
    case 'selection': {
      const afterComparableValues =
        await captureLocatorComparableValuesFromCandidates(liveReadLocators);
      const afterOwnerComparableValues = liveOwnerLocator
        ? await captureLocatorComparableValuesFromCandidates([liveOwnerLocator])
        : [];
      if (probe.expectedValue !== null) {
        return (
          valuesMatchAnyExpected(
            probe.expectedValue,
            afterComparableValues,
            probe.comparableValueType,
            { allowCompactActualSequence: true }
          ) ||
          valuesMatchAnyExpected(
            probe.expectedValue,
            afterOwnerComparableValues,
            probe.comparableValueType,
            { allowCompactActualSequence: true }
          )
        );
      }
      return (
        targetValueChanged ||
        ownerValueChanged ||
        surfaceContextChanged ||
        locatorStateChanged(probe.beforeLocator, afterLocatorObservation) ||
        locatorStateChanged(probe.beforeReadLocator, afterReadLocatorObservation) ||
        probe.beforeContextHash !== afterContextHash ||
        probe.beforeReadContextHash !== afterReadContextHash
      );
    }
    case 'toggle':
      return (
        locatorStateChanged(probe.beforeLocator, afterLocatorObservation) ||
        locatorStateChanged(probe.beforeReadLocator, afterReadLocatorObservation)
      );
    case 'disclosure':
      return (
        targetValueChanged ||
        locatorStateChanged(probe.beforeLocator, afterLocatorObservation) ||
        locatorStateChanged(probe.beforeReadLocator, afterReadLocatorObservation) ||
        probe.beforeContextHash !== afterContextHash ||
        probe.beforeReadContextHash !== afterReadContextHash
      );
    case 'date-selection': {
      const afterDateComparableValues =
        await captureLocatorComparableValuesFromCandidates(liveReadLocators);
      const afterDateOwnerComparableValues = liveOwnerLocator
        ? await captureLocatorComparableValuesFromCandidates([liveOwnerLocator])
        : [];
      const explicitDateMatched =
        probe.expectedValue !== null &&
        (valuesMatchAnyExpected(
          probe.expectedValue,
          afterDateComparableValues,
          probe.comparableValueType
        ) ||
          valuesMatchAnyExpected(
            probe.expectedValue,
            afterDateOwnerComparableValues,
            probe.comparableValueType
          ));
      return (
        explicitDateMatched ||
        locatorStateChanged(probe.beforeLocator, afterLocatorObservation) ||
        locatorStateChanged(probe.beforeReadLocator, afterReadLocatorObservation) ||
        targetValueChanged ||
        ownerValueChanged ||
        surfaceContextChanged ||
        (probe.expectedValue === null &&
          (probe.beforeContextHash !== afterContextHash ||
            probe.beforeReadContextHash !== afterReadContextHash))
      );
    }
    case 'submit':
      return submitObservationChanged(probe.beforePage, afterPageObservation);
    case 'navigation':
      return (
        targetValueChanged ||
        pageObservationChanged(probe.beforePage, afterPageObservation) ||
        probe.beforeContextHash !== afterContextHash ||
        probe.beforeReadContextHash !== afterReadContextHash
      );
    case 'generic-click':
      return (
        targetValueChanged ||
        locatorStateChanged(probe.beforeLocator, afterLocatorObservation) ||
        locatorStateChanged(probe.beforeReadLocator, afterReadLocatorObservation) ||
        probe.beforeContextHash !== afterContextHash ||
        probe.beforeReadContextHash !== afterReadContextHash ||
        genericClickObservationChanged(probe.beforePage, afterPageObservation)
      );
  }

  return false;
}

export async function waitForAcceptanceProbe(
  probe: AcceptanceProbe,
  options?: {
    timeoutMs?: number;
    intervalMs?: number;
  }
): Promise<AcceptanceProbeResult> {
  const timeoutMs = options?.timeoutMs ?? ACCEPTANCE_POLL_TIMEOUT_MS;
  const intervalMs = options?.intervalMs ?? ACCEPTANCE_POLL_INTERVAL_MS;
  const startedAt = Date.now();
  let polls = 0;
  let afterPageObservation = probe.beforePage ? await capturePageObservation(probe.page) : null;

  while (true) {
    polls += 1;
    const accepted = await evaluateAcceptanceProbe(probe, afterPageObservation);
    if (accepted) {
      return {
        accepted: true,
        afterPageObservation,
        polls,
      };
    }

    if (Date.now() - startedAt >= timeoutMs) {
      return {
        accepted: false,
        afterPageObservation,
        polls,
      };
    }

    await sleep(intervalMs);
    afterPageObservation = probe.beforePage ? await capturePageObservation(probe.page) : null;
  }
}
