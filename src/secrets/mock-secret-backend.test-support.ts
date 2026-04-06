import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCatalogLookupValue, storedSecretAppliesToHost } from './catalog-applicability.js';
import type { SecretCatalogSnapshot, StoredSecretMetadata } from './types.js';

interface MockStoredSecretRecord {
  metadata: StoredSecretMetadata;
  values: Record<string, string>;
}

const DEFAULT_MOCK_SECRET_STORE_PATH = fileURLToPath(
  new URL('./mock-stored-secrets.json', import.meta.url)
);
const USER_MOCK_SECRET_STORE_PATH = join(homedir(), '.agentbrowse', 'mock-stored-secrets.json');
let testMockSecretStorePath: string | undefined;

export function setMockSecretStorePathForTests(storePath?: string): void {
  testMockSecretStorePath = storePath ? resolve(storePath) : undefined;
}

function loadMockStoredSecretRecords(): MockStoredSecretRecord[] {
  const storePath = testMockSecretStorePath
    ? testMockSecretStorePath
    : existsSync(USER_MOCK_SECRET_STORE_PATH)
      ? USER_MOCK_SECRET_STORE_PATH
      : DEFAULT_MOCK_SECRET_STORE_PATH;

  return JSON.parse(readFileSync(storePath, 'utf-8')) as MockStoredSecretRecord[];
}

export function normalizeMerchantKey(value: string): string {
  return normalizeCatalogLookupValue(value);
}

export function resolveHostFromInput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('mock_secret_catalog_host_required');
  }

  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname) {
      throw new Error('missing_hostname');
    }
    return normalizeCatalogLookupValue(parsed.hostname);
  } catch {
    return normalizeCatalogLookupValue(trimmed);
  }
}

function preferenceScore(metadata: StoredSecretMetadata, merchantKey: string): number {
  return metadata.preferredForMerchantKeys?.some(
    (candidate) => normalizeCatalogLookupValue(candidate) === merchantKey
  )
    ? 1
    : 0;
}

function stripValues(record: MockStoredSecretRecord): StoredSecretMetadata {
  return {
    ...record.metadata,
    fieldKeys: [...record.metadata.fieldKeys],
    fieldPolicies: record.metadata.fieldPolicies ? { ...record.metadata.fieldPolicies } : undefined,
    preferredForMerchantKeys: record.metadata.preferredForMerchantKeys
      ? [...record.metadata.preferredForMerchantKeys]
      : undefined,
  };
}

export function listMockStoredSecretsForHost(
  hostOrUrl: string,
  options: {
    merchantKey?: string;
  } = {}
): StoredSecretMetadata[] {
  const host = resolveHostFromInput(hostOrUrl);
  const merchantKey = normalizeMerchantKey(options.merchantKey ?? host);

  return loadMockStoredSecretRecords()
    .filter((record) => storedSecretAppliesToHost(record.metadata, host))
    .sort((left, right) => {
      const preferenceDelta =
        preferenceScore(right.metadata, merchantKey) - preferenceScore(left.metadata, merchantKey);
      if (preferenceDelta !== 0) {
        return preferenceDelta;
      }
      return left.metadata.displayName.localeCompare(right.metadata.displayName);
    })
    .map(stripValues);
}

export function syncMockSecretCatalog(
  hostOrUrl: string,
  options: {
    merchantKey?: string;
    syncedAt?: string;
  } = {}
): SecretCatalogSnapshot {
  const host = resolveHostFromInput(hostOrUrl);

  return {
    source: 'mock',
    host,
    syncedAt: options.syncedAt ?? new Date().toISOString(),
    storedSecrets: listMockStoredSecretsForHost(host, {
      merchantKey: options.merchantKey ?? host,
    }),
  };
}

export function resolveMockStoredSecretValues(
  storedSecretRef: string
): Record<string, string> | null {
  const match = loadMockStoredSecretRecords().find(
    (record) => record.metadata.storedSecretRef === storedSecretRef
  );
  if (!match) {
    return null;
  }

  return { ...match.values };
}
