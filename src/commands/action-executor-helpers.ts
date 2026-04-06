import type { Locator, Page } from 'playwright-core';
import { inferComparableValueTypeFromFacts } from '../control-semantics.js';

const OVERLAY_DISMISS_SELECTORS = [
  '[aria-label="Close"]',
  '[aria-label="Dismiss"]',
  '[data-testid*="close"]',
  '[data-testid*="dismiss"]',
  'button:has-text("Close")',
  'button:has-text("Dismiss")',
  'button:has-text("Not now")',
  'button:has-text("No thanks")',
  'button:has-text("Skip")',
  'button:has-text("Maybe later")',
] as const;

export const LOCATOR_CLICK_TIMEOUT_MS = 1_500;
export const LOCATOR_FILL_TIMEOUT_MS = 1_500;

type TextEntryMetadata = {
  phoneLike: boolean;
  popupBackedTextEntry: boolean;
  maskedDateLike: boolean;
  nativeDateInput: boolean;
  dateSeparator: '.' | '/' | '-';
  currentValue: string;
  currentPhonePrefix: string | null;
};

const DATE_MASK_PLACEHOLDER_RE =
  /(?:^|\b)(?:dd|d|дд|д)\s*[./-]\s*(?:mm|m|мм|м)\s*[./-]\s*(?:yyyy|yyy|yy|y|гггг|гг|г)(?:\b|$)/i;
const DATE_FIELD_HINT_RE =
  /\b(?:birth|dob|date|dates|expire|expires|expiry|expir|bday)\b|(?:дата|рожд|срок)/i;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function looksLikeOverlayInterference(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('intercept') ||
    message.includes('another element') ||
    message.includes('not receiving pointer events') ||
    message.includes('obscured') ||
    message.includes('blocked by') ||
    message.includes('element click intercepted')
  );
}

export async function dismissBlockingOverlay(page: Page, attempts: string[]): Promise<boolean> {
  attempts.push('overlay.dismiss.scan');

  for (const selector of OVERLAY_DISMISS_SELECTORS) {
    const candidate = page.locator(selector).first();
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    attempts.push(`overlay.dismiss:${selector}`);
    try {
      await candidate.click({ timeout: LOCATOR_CLICK_TIMEOUT_MS });
      attempts.push('overlay.dismissed');
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

export async function applyValueWithJsFallback(
  locator: Locator,
  value: string,
  attempts: string[]
): Promise<void> {
  attempts.push('locator.evaluate.setValue');
  await locator.evaluate((element, nextValue) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error('unsupported_js_value_fallback');
    }

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      const prototype =
        element instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLSelectElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) {
        setter.call(element, nextValue);
      } else {
        element.value = nextValue;
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    if (element.isContentEditable) {
      element.textContent = nextValue;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    throw new Error('unsupported_js_value_fallback');
  }, value);
}

export async function focusLocator(
  page: Page,
  locator: Locator,
  attempts: string[]
): Promise<void> {
  attempts.push('locator.click');
  try {
    await locator.click({ timeout: LOCATOR_CLICK_TIMEOUT_MS });
  } catch (error) {
    if (looksLikeOverlayInterference(error)) {
      const dismissed = await dismissBlockingOverlay(page, attempts);
      if (dismissed) {
        attempts.push('locator.click.retry.afterOverlay');
        try {
          await locator.click({ timeout: LOCATOR_CLICK_TIMEOUT_MS });
          return;
        } catch {
          // Ignore focus click failure and fall through.
        }
      }
    }
    // Ignore focus click failure and let downstream fallback continue.
  }
}

export async function normalizeFillValue(
  locator: Locator,
  value: string,
  attempts: string[]
): Promise<string> {
  const metadata = await readTextEntryMetadata(locator);
  const normalized = normalizeDateLikeValue(value, metadata);
  if (normalized !== value) {
    attempts.push('fill.normalize:date-mask');
  }
  return normalized;
}

function extractPhonePrefix(value: string): string | null {
  const raw = (value ?? '').trim();
  if (!raw.startsWith('+')) {
    return null;
  }

  const explicitBoundary = raw.match(/^\+\d{1,4}(?=[\s(.-]|$)/);
  if (explicitBoundary) {
    return explicitBoundary[0];
  }

  return null;
}

async function readTextEntryMetadata(locator: Locator): Promise<TextEntryMetadata> {
  const [
    type,
    autocomplete,
    name,
    role,
    ariaHasPopup,
    ariaControls,
    ariaExpanded,
    placeholder,
    id,
    currentValue,
  ] = await Promise.all([
    locator.getAttribute?.('type').catch(() => null),
    locator.getAttribute?.('autocomplete').catch(() => null),
    locator.getAttribute?.('name').catch(() => null),
    locator.getAttribute?.('role').catch(() => null),
    locator.getAttribute?.('aria-haspopup').catch(() => null),
    locator.getAttribute?.('aria-controls').catch(() => null),
    locator.getAttribute?.('aria-expanded').catch(() => null),
    locator.getAttribute?.('placeholder').catch(() => null),
    locator.getAttribute?.('id').catch(() => null),
    typeof locator.inputValue === 'function' ? locator.inputValue().catch(() => '') : '',
  ]);

  const normalizedType = (type || '').toLowerCase();
  const normalizedAutocomplete = (autocomplete || '').toLowerCase();
  const normalizedName = (name || '').toLowerCase();
  const cardAutocomplete = normalizedAutocomplete.startsWith('cc-');
  const phoneLike =
    !cardAutocomplete &&
    (normalizedType === 'tel' ||
      normalizedAutocomplete.includes('tel') ||
      normalizedName.includes('phone'));
  const comparableValueType = inferComparableValueTypeFromFacts({
    kind: 'input',
    role: role || undefined,
    placeholder: placeholder || undefined,
    inputName: name || undefined,
    inputType: type || undefined,
    autocomplete: autocomplete || undefined,
  });
  const dateHintBlob = [type, autocomplete, name, placeholder, id]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ');
  const nativeDateInput = normalizedType === 'date';
  const trimmedPlaceholder = (placeholder || '').trim();
  const dateSeparator = trimmedPlaceholder.includes('/')
    ? '/'
    : trimmedPlaceholder.includes('-')
      ? '-'
      : '.';
  const maskedDateLike =
    !nativeDateInput &&
    comparableValueType !== 'expiry' &&
    (DATE_MASK_PLACEHOLDER_RE.test(trimmedPlaceholder) || DATE_FIELD_HINT_RE.test(dateHintBlob));
  const popupBackedTextEntry =
    Boolean((ariaControls || '').trim()) ||
    ['listbox', 'menu'].includes((ariaHasPopup || '').toLowerCase()) ||
    (role || '').toLowerCase() === 'combobox' ||
    ariaExpanded !== null;

  return {
    phoneLike,
    popupBackedTextEntry,
    maskedDateLike,
    nativeDateInput,
    dateSeparator,
    currentValue: currentValue || '',
    currentPhonePrefix: phoneLike ? extractPhonePrefix(currentValue || '') : null,
  };
}

function normalizeDateLikeValue(value: string, metadata: TextEntryMetadata): string {
  if (metadata.nativeDateInput) {
    return value;
  }

  if (!metadata.maskedDateLike) {
    return value;
  }

  const isoMatch = value.match(ISO_DATE_RE);
  if (!isoMatch) {
    return value;
  }

  const [, year, month, day] = isoMatch;
  return `${day}${metadata.dateSeparator}${month}${metadata.dateSeparator}${year}`;
}

export async function readLocatorCurrentValue(locator: Locator): Promise<string> {
  return typeof locator.inputValue === 'function' ? locator.inputValue().catch(() => '') : '';
}

export async function planTextFillStrategy(
  locator: Locator,
  value: string,
  attempts: string[]
): Promise<{
  normalizedValue: string;
  preferSequential: boolean;
  settleMs: number;
  initialPhonePrefix: string | null;
  blurAfterFill: boolean;
}> {
  const metadata = await readTextEntryMetadata(locator);
  if (metadata.phoneLike) {
    attempts.push('fill.strategy:masked-sequential');
  } else if (metadata.maskedDateLike) {
    attempts.push('fill.strategy:date-sequential');
  } else if (metadata.popupBackedTextEntry) {
    attempts.push('fill.strategy:popup-sequential');
  }
  return {
    normalizedValue: normalizeDateLikeValue(value, metadata),
    preferSequential:
      metadata.phoneLike || metadata.popupBackedTextEntry || metadata.maskedDateLike,
    settleMs: metadata.phoneLike
      ? 120
      : metadata.popupBackedTextEntry || metadata.maskedDateLike
        ? 80
        : 0,
    initialPhonePrefix: metadata.currentPhonePrefix,
    blurAfterFill: metadata.maskedDateLike,
  };
}

export function normalizeDigitsOnly(value: string): string {
  return value.replace(/\s+/g, '');
}

export function deriveMaskedSequentialValue(
  value: string,
  residualValue: string,
  initialPhonePrefix: string | null,
  attempts: string[]
): string {
  const normalizedIncoming = normalizeDigitsOnly(value);
  if (!/^\d{5,}$/.test(normalizedIncoming) || normalizedIncoming.startsWith('+')) {
    return value;
  }

  const residualPrefix = extractPhonePrefix(residualValue);
  if (residualPrefix) {
    attempts.push(`fill.masked.residual-prefix:${residualPrefix}`);
    return value;
  }

  if (initialPhonePrefix) {
    attempts.push(`fill.masked.initial-prefix:${initialPhonePrefix}`);
    return `${initialPhonePrefix}${normalizedIncoming}`;
  }

  return value;
}

export async function clearLocatorForReplacement(
  locator: Locator,
  attempts: string[]
): Promise<void> {
  if (typeof locator.selectText === 'function') {
    attempts.push('locator.selectText');
    try {
      await locator.selectText();
      attempts.push('locator.press:Backspace');
      await locator.press('Backspace');
      return;
    } catch {
      // Fall through to downstream replacement strategies.
    }
  }
}

export async function blurLocator(locator: Locator, attempts: string[]): Promise<void> {
  if (typeof locator.blur === 'function') {
    attempts.push('locator.blur');
    try {
      await locator.blur();
      return;
    } catch {
      // Fall through to DOM-event fallback.
    }
  }

  attempts.push('locator.dispatchEvent:blur');
  await locator.dispatchEvent?.('blur').catch(() => {});
}
