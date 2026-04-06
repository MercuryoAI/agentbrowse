import type { SecretCatalogSnapshot, StoredSecretMetadata } from './types.js';

export function normalizeCatalogLookupValue(value: string): string {
  return value.trim().toLowerCase();
}

export function storedSecretAppliesToHost(metadata: StoredSecretMetadata, host: string): boolean {
  const normalizedHost = normalizeCatalogLookupValue(host);
  const applicabilityValue = metadata.applicability.value
    ? normalizeCatalogLookupValue(metadata.applicability.value)
    : undefined;

  switch (metadata.applicability.target) {
    case 'global':
      return true;
    case 'host':
      return applicabilityValue === normalizedHost;
    case 'site':
      return (
        applicabilityValue === normalizedHost ||
        (typeof applicabilityValue === 'string' &&
          normalizedHost.endsWith(`.${applicabilityValue}`))
      );
    default:
      return false;
  }
}

function cloneStoredSecretMetadata(metadata: StoredSecretMetadata): StoredSecretMetadata {
  return {
    ...metadata,
    fieldKeys: [...metadata.fieldKeys],
    fieldPolicies: metadata.fieldPolicies ? { ...metadata.fieldPolicies } : undefined,
    preferredForMerchantKeys: metadata.preferredForMerchantKeys
      ? [...metadata.preferredForMerchantKeys]
      : undefined,
  };
}

export function resolveCachedSecretCatalogForHost(
  host: string,
  snapshots: ReadonlyArray<SecretCatalogSnapshot>
): SecretCatalogSnapshot | null {
  const normalizedHost = normalizeCatalogLookupValue(host);
  const exact = snapshots.find(
    (snapshot) => normalizeCatalogLookupValue(snapshot.host) === normalizedHost
  );
  if (exact) {
    return exact;
  }

  const orderedSnapshots = [...snapshots].sort((left, right) =>
    right.syncedAt.localeCompare(left.syncedAt)
  );
  const storedSecrets = new Map<string, StoredSecretMetadata>();

  for (const snapshot of orderedSnapshots) {
    for (const secret of snapshot.storedSecrets) {
      if (!storedSecretAppliesToHost(secret, normalizedHost)) {
        continue;
      }

      if (!storedSecrets.has(secret.storedSecretRef)) {
        storedSecrets.set(secret.storedSecretRef, cloneStoredSecretMetadata(secret));
      }
    }
  }

  if (storedSecrets.size === 0) {
    return null;
  }

  return {
    source: orderedSnapshots[0]?.source ?? 'mock',
    host: normalizedHost,
    syncedAt: orderedSnapshots[0]?.syncedAt ?? new Date().toISOString(),
    storedSecrets: [...storedSecrets.values()],
  };
}
