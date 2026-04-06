import type { Locator } from 'playwright-core';
import type { TargetDescriptor } from '../runtime-state.js';
import type { BrowseAction } from './browse-actions.js';

export type ActionValueProjection =
  | {
      kind: 'direct';
      executionValue: string;
      acceptanceValue: string;
    }
  | {
      kind: 'phone-national';
      executionValue: string;
      acceptanceValue: string;
      selectedDialCode: string;
      selectedOptionText?: string;
    };

type PhoneProjectionContext = {
  selectedDialCode: string | null;
  selectedOptionText?: string;
};

const PHONE_PROJECTION_CONTEXT_SCRIPT = String.raw`
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  const autocomplete = (element.getAttribute('autocomplete') || '').trim().toLowerCase();
  const inputName = (element.getAttribute('name') || '').trim().toLowerCase();
  const inputType = (element.getAttribute('type') || '').trim().toLowerCase();
  const phoneLike =
    inputType === 'tel' ||
    autocomplete.includes('tel') ||
    inputName.includes('phone');
  const isNationalPhoneInput =
    autocomplete.includes('tel-national') ||
    autocomplete === 'tel-local' ||
    autocomplete === 'tel';
  if (!phoneLike || !isNationalPhoneInput) {
    return null;
  }

  const anchors = [];
  let current = element.parentElement;
  for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
    anchors.push(current);
  }

  const extractDialCode = (rawValue) => {
    const normalized = String(rawValue ?? '').replace(/\s+/g, ' ').trim();
    const matches = normalized.match(/\+\d{1,4}/g);
    return matches && matches.length > 0 ? matches[matches.length - 1] : null;
  };

  for (const anchor of anchors) {
    const companions = Array.from(
      anchor.querySelectorAll('select, input, [role="combobox"]')
    ).filter((candidate) => candidate instanceof HTMLElement && candidate !== element);

    for (const companion of companions) {
      const companionAutocomplete = (
        companion.getAttribute('autocomplete') || ''
      ).trim().toLowerCase();
      const companionName = (companion.getAttribute('name') || '').trim().toLowerCase();
      const companionTestId = (
        companion.getAttribute('data-testid') || companion.getAttribute('data-test-id') || ''
      )
        .trim()
        .toLowerCase();
      const companionAriaLabel = (
        companion.getAttribute('aria-label') || ''
      ).trim().toLowerCase();
      const isCountryCodeCompanion =
        companionAutocomplete.includes('tel-country-code') ||
        companionName.includes('countrycode') ||
        companionTestId.includes('phone-country-code') ||
        companionAriaLabel.includes('country or region');
      if (!isCountryCodeCompanion) {
        continue;
      }

      if (companion instanceof HTMLSelectElement) {
        const selectedOption = companion.selectedOptions && companion.selectedOptions[0]
          ? companion.selectedOptions[0]
          : null;
        const selectedText = (selectedOption && selectedOption.textContent
          ? selectedOption.textContent
          : ''
        ).replace(/\s+/g, ' ').trim();
        return {
          selectedDialCode: extractDialCode(selectedText),
          selectedOptionText: selectedText || undefined,
        };
      }

      const currentValue =
        companion instanceof HTMLInputElement
          ? companion.value
          : (companion.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        selectedDialCode: extractDialCode(currentValue),
        selectedOptionText: currentValue || undefined,
      };
    }
  }

  return null;
`;

function looksPhoneLike(target: TargetDescriptor): boolean {
  const inputType = (target.inputType ?? '').trim().toLowerCase();
  const autocomplete = (target.autocomplete ?? '').trim().toLowerCase();
  const inputName = (target.inputName ?? '').trim().toLowerCase();
  const label = (target.label ?? '').trim().toLowerCase();

  return (
    inputType === 'tel' ||
    autocomplete.includes('tel') ||
    inputName.includes('phone') ||
    /\bphone\b|\bтелефон\b|\bномер\b/.test(label)
  );
}

function normalizePhoneComparable(value: string): string {
  const compact = value.replace(/[^\d+]/g, '');
  if (!compact) {
    return '';
  }

  if (!compact.startsWith('+')) {
    return compact.replace(/\+/g, '');
  }

  return `+${compact.slice(1).replace(/\+/g, '')}`;
}

function readPhoneProjectionContextInBrowser(element: Element): PhoneProjectionContext | null {
  return Function(
    'element',
    PHONE_PROJECTION_CONTEXT_SCRIPT
  )(element) as PhoneProjectionContext | null;
}

async function readPhoneProjectionContext(
  locator: Locator
): Promise<PhoneProjectionContext | null> {
  return locator
    .evaluate(
      (element, source) => Function('element', source)(element) as PhoneProjectionContext | null,
      PHONE_PROJECTION_CONTEXT_SCRIPT
    )
    .catch(() => null);
}

export async function projectActionValue(args: {
  target: TargetDescriptor;
  action: BrowseAction;
  actionValue: string | undefined;
  locator: Locator;
  attempts: string[];
}): Promise<ActionValueProjection | null> {
  const { target, action, actionValue, locator, attempts } = args;
  if (!actionValue || (action !== 'fill' && action !== 'type')) {
    return null;
  }

  if (!looksPhoneLike(target)) {
    return null;
  }

  const normalized = normalizePhoneComparable(actionValue);
  if (!normalized.startsWith('+')) {
    return null;
  }

  const context = await readPhoneProjectionContext(locator);
  if (!context?.selectedDialCode) {
    return null;
  }

  const selectedDialCode = normalizePhoneComparable(context.selectedDialCode);
  if (!selectedDialCode.startsWith('+') || !normalized.startsWith(selectedDialCode)) {
    return null;
  }

  const localPart = normalized.slice(selectedDialCode.length);
  if (!/^\d{4,}$/.test(localPart)) {
    return null;
  }

  attempts.push(`projection:phone.local-from-selected-code:${selectedDialCode}`);
  return {
    kind: 'phone-national',
    executionValue: localPart,
    acceptanceValue: localPart,
    selectedDialCode,
    selectedOptionText: context.selectedOptionText,
  };
}

export const __testActionValueProjection = {
  phoneProjectionContextScript: PHONE_PROJECTION_CONTEXT_SCRIPT,
  readPhoneProjectionContextInBrowser,
};
