export const LOGIN_FIELD_KEYS = ['username', 'password'] as const;
export const IDENTITY_FIELD_KEYS = [
  'full_name',
  'document_number',
  'date_of_birth',
  'nationality',
  'issue_date',
  'expiry_date',
  'issuing_country',
] as const;
export const PAYMENT_CARD_FIELD_KEYS = [
  'cardholder',
  'pan',
  'exp_month',
  'exp_year',
  'cvv',
] as const;

export type StoredSecretKind = 'login' | 'identity' | 'payment_card';

export const STORED_SECRET_FIELD_KEYS_BY_KIND = {
  login: LOGIN_FIELD_KEYS,
  identity: IDENTITY_FIELD_KEYS,
  payment_card: PAYMENT_CARD_FIELD_KEYS,
} as const;

export type LoginFieldKey = (typeof LOGIN_FIELD_KEYS)[number];
export type IdentityFieldKey = (typeof IDENTITY_FIELD_KEYS)[number];
export type PaymentCardFieldKey = (typeof PAYMENT_CARD_FIELD_KEYS)[number];
export type StoredSecretFieldKey = LoginFieldKey | IdentityFieldKey | PaymentCardFieldKey;

export type StoredSecretScope = 'site' | 'global';
export type ProtectedFieldPolicy = 'deterministic_only' | 'llm_assisted';
export const PROTECTED_BINDING_VALUE_HINTS = [
  'direct',
  'full_name.given',
  'full_name.family',
  'date_of_birth.day',
  'date_of_birth.month',
  'date_of_birth.year',
] as const;
export type ProtectedBindingValueHint = (typeof PROTECTED_BINDING_VALUE_HINTS)[number];

export type StoredSecretApplicabilityTarget = 'host' | 'site' | 'global';

export interface StoredSecretApplicability {
  target: StoredSecretApplicabilityTarget;
  value?: string;
}

export type StoredSecretFieldPolicies = Partial<Record<StoredSecretFieldKey, ProtectedFieldPolicy>>;

export interface StoredSecretMetadata {
  storedSecretRef: string;
  kind: StoredSecretKind;
  scope: StoredSecretScope;
  displayName: string;
  fieldKeys: StoredSecretFieldKey[];
  fieldPolicies?: StoredSecretFieldPolicies;
  intentRequired: boolean;
  applicability: StoredSecretApplicability;
  preferredForMerchantKeys?: string[];
}

export interface SecretCatalogSnapshot {
  source: 'mock' | 'remote_api';
  host: string;
  syncedAt: string;
  storedSecrets: StoredSecretMetadata[];
}

export interface FillableFormFieldBinding {
  fieldKey: StoredSecretFieldKey;
  targetRef: string;
  label?: string;
  required?: boolean;
  valueHint?: ProtectedBindingValueHint;
}

export interface FillableFormStoredSecretCandidate {
  storedSecretRef: string;
  kind: StoredSecretKind;
  scope: StoredSecretScope;
  displayName: string;
  matchConfidence: 'high' | 'medium' | 'low';
  intentRequired: boolean;
  fieldKeys?: StoredSecretFieldKey[];
  fieldPolicies?: StoredSecretFieldPolicies;
}

export type FillableFormPresence = 'present' | 'unknown' | 'absent';

export interface PersistedFillableForm {
  fillRef: string;
  pageRef: string;
  scopeRef?: string;
  purpose: string;
  presence?: FillableFormPresence;
  scopeEpoch?: number;
  fields: FillableFormFieldBinding[];
  storedSecretCandidates: FillableFormStoredSecretCandidate[];
  observedAt: string;
}
