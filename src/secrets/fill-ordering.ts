import type { StoredSecretFieldKey } from './types.js';

const DEFAULT_PRIORITY = 100;

const FIELD_PRIORITY_BY_PURPOSE: Record<string, Partial<Record<StoredSecretFieldKey, number>>> = {
  login: {
    username: 10,
    password: 20,
  },
  identity: {
    full_name: 10,
    document_number: 20,
    date_of_birth: 30,
    nationality: 40,
    issue_date: 50,
    expiry_date: 60,
    issuing_country: 70,
  },
  payment_card: {
    cardholder: 10,
    exp_month: 20,
    exp_year: 20,
    pan: 30,
    cvv: 40,
  },
};

function fieldPriority(purpose: string, fieldKey: StoredSecretFieldKey): number {
  return FIELD_PRIORITY_BY_PURPOSE[purpose]?.[fieldKey] ?? DEFAULT_PRIORITY;
}

export function sortProtectedBindingsForExecution<T extends { fieldKeys: StoredSecretFieldKey[] }>(
  purpose: string,
  bindings: ReadonlyArray<T>
): T[] {
  return bindings
    .map((binding, index) => ({
      binding,
      index,
      priority:
        binding.fieldKeys.length === 0
          ? DEFAULT_PRIORITY
          : Math.min(...binding.fieldKeys.map((fieldKey) => fieldPriority(purpose, fieldKey))),
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map((entry) => entry.binding);
}

export const __testFillOrdering = {
  fieldPriority,
};
