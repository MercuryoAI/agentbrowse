import type {
  ProtectedFieldPolicy,
  StoredSecretFieldKey,
  StoredSecretFieldPolicies,
} from './types.js';

export function resolveProtectedFieldPolicy(
  fieldPolicies: StoredSecretFieldPolicies | undefined,
  fieldKey: StoredSecretFieldKey
): ProtectedFieldPolicy {
  return fieldPolicies?.[fieldKey] ?? 'deterministic_only';
}
