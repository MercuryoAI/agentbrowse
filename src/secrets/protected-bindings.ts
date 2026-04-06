import { z } from 'zod';
import { PROTECTED_BINDING_VALUE_HINTS, type ProtectedBindingValueHint } from './types.js';

export const protectedBindingValueHintSchema = z.enum(PROTECTED_BINDING_VALUE_HINTS);

export function normalizeProtectedBindingValueHint(
  fieldKey: string,
  valueHint?: string | null
): ProtectedBindingValueHint {
  if (
    fieldKey === 'full_name' &&
    (valueHint === 'full_name.given' || valueHint === 'full_name.family')
  ) {
    return valueHint;
  }

  if (
    fieldKey === 'date_of_birth' &&
    (valueHint === 'date_of_birth.day' ||
      valueHint === 'date_of_birth.month' ||
      valueHint === 'date_of_birth.year')
  ) {
    return valueHint;
  }

  return 'direct';
}

export function protectedBindingKey(binding: {
  targetRef: string;
  fieldKey: string;
  valueHint?: string | null;
}): string {
  return [
    binding.targetRef,
    binding.fieldKey,
    normalizeProtectedBindingValueHint(binding.fieldKey, binding.valueHint),
  ].join(':');
}

export function logicalProtectedBindingKey(binding: {
  fieldKey: string;
  valueHint?: string | null;
}): string {
  return [
    binding.fieldKey,
    normalizeProtectedBindingValueHint(binding.fieldKey, binding.valueHint),
  ].join(':');
}
