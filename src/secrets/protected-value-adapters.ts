import type { TargetDescriptor } from '../runtime-state.js';
import type { FillableFormFieldBinding, StoredSecretFieldKey } from './types.js';

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function splitFullName(value: string): string[] {
  return normalizeWhitespace(value)
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean);
}

function directStoredValue(
  protectedValues: Record<string, string>,
  fieldKey: StoredSecretFieldKey
): string | null {
  const value = protectedValues[fieldKey];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function parseIsoDate(value: string): { year: string; month: string; day: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const year = match[1];
  const month = match[2];
  const day = match[3];
  if (!year || !month || !day) {
    return null;
  }

  return { year, month, day };
}

function monthName(month: string): string {
  const names = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return names[Number(month) - 1] ?? month;
}

function monthShortName(month: string): string {
  return monthName(month).slice(0, 3);
}

function monthProjectionStyle(
  target: Pick<TargetDescriptor, 'label' | 'displayLabel' | 'context'> | undefined
): 'name' | 'short' | 'numeric' {
  const context = [target?.label, target?.displayLabel, target?.context?.hintText]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (
    /\bjanuary\b|\bfebruary\b|\bmarch\b|\bapril\b|\bmay\b|\bjune\b|\bjuly\b|\baugust\b|\bseptember\b|\boctober\b|\bnovember\b|\bdecember\b/.test(
      context
    )
  ) {
    return 'name';
  }

  if (
    /\bjan\b|\bfeb\b|\bmar\b|\bapr\b|\bjun\b|\bjul\b|\baug\b|\bsep\b|\boct\b|\bnov\b|\bdec\b/.test(
      context
    )
  ) {
    return 'short';
  }

  return 'numeric';
}

export function resolveDeterministicProtectedBindingValue(
  binding: Pick<FillableFormFieldBinding, 'fieldKey' | 'valueHint'>,
  protectedValues: Record<string, string>,
  target?: Pick<TargetDescriptor, 'label' | 'displayLabel' | 'context'>
): string | null {
  if (binding.fieldKey === 'date_of_birth') {
    const dateOfBirth = directStoredValue(protectedValues, 'date_of_birth');
    if (!dateOfBirth) {
      return null;
    }

    const valueHint = binding.valueHint ?? 'direct';
    if (valueHint === 'direct') {
      return dateOfBirth;
    }

    const parsed = parseIsoDate(dateOfBirth);
    if (!parsed) {
      return null;
    }

    if (valueHint === 'date_of_birth.day') {
      return String(Number(parsed.day));
    }

    if (valueHint === 'date_of_birth.year') {
      return parsed.year;
    }

    if (valueHint === 'date_of_birth.month') {
      const style = monthProjectionStyle(target);
      if (style === 'name') {
        return monthName(parsed.month);
      }
      if (style === 'short') {
        return monthShortName(parsed.month);
      }
      return parsed.month;
    }

    return null;
  }

  if (binding.fieldKey !== 'full_name') {
    return binding.valueHint === 'direct'
      ? directStoredValue(protectedValues, binding.fieldKey)
      : null;
  }

  const fullName = directStoredValue(protectedValues, 'full_name');
  if (!fullName) {
    return null;
  }

  const valueHint = binding.valueHint ?? 'direct';
  if (valueHint === 'direct') {
    return fullName;
  }

  const parts = splitFullName(fullName);
  if (parts.length === 0) {
    return null;
  }

  if (valueHint === 'full_name.given') {
    return parts[0] ?? fullName;
  }

  if (valueHint === 'full_name.family') {
    return parts.length > 1 ? (parts.at(-1) ?? fullName) : fullName;
  }

  return null;
}
