import type { BrowserSessionState } from './browser-session-state.js';
import {
  fillProtectedFormBrowser,
  type FillProtectedFormBrowserResult,
} from './protected-fill-browser.js';
import { buildProtectedExactValueProfile as buildProtectedExactValueProfileInternal } from './secrets/protected-exact-value-redaction.js';
import type {
  FillableFormFieldBinding,
  FillableFormPresence,
  PersistedFillableForm,
  ProtectedBindingValueHint,
  ProtectedFieldPolicy,
  StoredSecretFieldKey,
  StoredSecretFieldPolicies,
} from './secrets/types.js';
import type { ProtectedExactValueProfile } from './runtime-state.js';

/** Canonical stored protected field keys supported by AgentBrowse protected fill. */
export type ProtectedFieldKey = StoredSecretFieldKey;
export type ProtectedFieldPolicyMode = ProtectedFieldPolicy;
export type ProtectedFieldPolicies = StoredSecretFieldPolicies;
export type ProtectedFieldValueHint = ProtectedBindingValueHint;
export type ProtectedFillPresence = FillableFormPresence;
export type { ProtectedExactValueProfile } from './runtime-state.js';

/** Single field binding inside a protected fill form. */
export interface ProtectedFillFieldBinding extends FillableFormFieldBinding {}

/** Protected fill form returned from `observe(...)` and accepted by `fillProtectedForm(...)`. */
export interface ProtectedFillForm {
  fillRef: string;
  pageRef: string;
  scopeRef?: string;
  purpose: string;
  presence?: ProtectedFillPresence;
  scopeEpoch?: number;
  fields: ProtectedFillFieldBinding[];
  observedAt: string;
}

/** Single field that AgentBrowse filled during a protected fill run. */
export interface ProtectedFilledField {
  fieldKey: ProtectedFieldKey;
  targetRef: string;
}

/** Field-level validation or application failure for protected fill. */
export interface ProtectedFieldError extends ProtectedFilledField {
  reason: 'client_validation_rejected' | 'value_not_applied';
  validationTextRedacted?: true;
}

export type ProtectedFillExecution =
  | {
      kind: 'success';
      filledFields: ProtectedFilledField[];
    }
  | {
      kind: 'binding_stale';
      targetRef: string;
      fieldKeys: ProtectedFieldKey[];
      reason:
        | 'target_missing'
        | 'target_not_live'
        | 'page_signature_mismatch'
        | 'dom_signature_mismatch'
        | 'locator_resolution_failed'
        | 'target_blocked';
      attempts: string[];
    }
  | {
      kind: 'validation_failed';
      filledFields: ProtectedFilledField[];
      fieldErrors: ProtectedFieldError[];
    }
  | {
      kind: 'unexpected_error';
      reason:
        | 'missing_protected_value'
        | 'unsupported_protected_field_group'
        | 'deterministic_only_resolution_failed'
        | 'assisted_value_resolution_failed'
        | 'action_failed';
    };

export type FillProtectedFormResult =
  | {
      success: true;
      pageRef: string;
      url: string;
      title: string;
      execution: ProtectedFillExecution;
    }
  | {
      success: false;
      error: 'browser_connection_failed' | 'page_resolution_failed';
      message: string;
      reason: string;
    };

export interface FillProtectedFormInput {
  session: BrowserSessionState;
  fillableForm: ProtectedFillForm;
  protectedValues: Partial<Record<ProtectedFieldKey, string>>;
  fieldPolicies?: ProtectedFieldPolicies;
}

export interface BuildProtectedExposureArtifactsInput {
  session: BrowserSessionState;
  fillableForm: ProtectedFillForm;
  protectedValues: Partial<Record<ProtectedFieldKey, string>>;
  fieldPolicies?: ProtectedFieldPolicies;
}

export interface ProtectedExposureArtifacts {
  exactValueProfile: ProtectedExactValueProfile;
}

/** Fills a previously observed protected form with caller-provided protected values. */
export async function fillProtectedForm(
  params: FillProtectedFormInput
): Promise<FillProtectedFormResult> {
  return (await fillProtectedFormBrowser({
    session: params.session,
    fillableForm: params.fillableForm as PersistedFillableForm,
    protectedValues: params.protectedValues,
    fieldPolicies: params.fieldPolicies,
  })) as FillProtectedFormBrowserResult as FillProtectedFormResult;
}

export function buildProtectedExposureArtifacts(
  params: BuildProtectedExposureArtifactsInput
): ProtectedExposureArtifacts {
  const filteredProtectedValues = Object.fromEntries(
    Object.entries(params.protectedValues).filter((entry) => {
      const value = entry[1];
      return typeof value === 'string' && value.length > 0;
    })
  ) as Partial<Record<ProtectedFieldKey, string>>;

  return {
    exactValueProfile: buildProtectedExactValueProfileInternal(filteredProtectedValues),
  };
}
