import type { Locator, Page } from 'playwright-core';
import { AgentbrowseAssistiveRuntimeMissingError } from '../assistive-runtime.js';
import type { BrowserSessionState } from '../browser-session-state.js';
import { getSurface, getTarget, type TargetDescriptor } from '../runtime-state.js';
import { createAcceptanceProbe, waitForAcceptanceProbe } from '../commands/action-acceptance.js';
import type { LocatorRoot } from '../commands/action-fallbacks.js';
import { applyActionWithFallbacks } from '../commands/action-executor.js';
import {
  normalizePageSignature,
  readLocatorDomSignature,
} from '../commands/descriptor-validation.js';
import {
  assertStoredBindingStillValid,
  resolvePreparedLocatorCandidates,
  resolveInteractionRoots,
} from '../commands/interaction-kernel.js';
import { resolveProtectedFieldPolicy } from './field-policy.js';
import { protectedBindingKey } from './protected-bindings.js';
import { resolveAssistedProtectedFieldValues } from './protected-field-values.js';
import { resolveDeterministicProtectedBindingValue } from './protected-value-adapters.js';
import type {
  FillableFormFieldBinding,
  PersistedFillableForm,
  StoredSecretFieldPolicies,
  StoredSecretFieldKey,
} from './types.js';
import { sortProtectedBindingsForExecution } from './fill-ordering.js';

type ProtectedFillAction = 'fill' | 'select' | 'type';

export interface ProtectedFilledField {
  fieldKey: StoredSecretFieldKey;
  targetRef: string;
}

export interface ProtectedFieldError extends ProtectedFilledField {
  reason: 'client_validation_rejected' | 'value_not_applied';
  validationTextRedacted?: true;
}

type ProtectedBindingStaleReason =
  | 'target_missing'
  | 'target_not_live'
  | 'page_signature_mismatch'
  | 'dom_signature_mismatch'
  | 'locator_resolution_failed'
  | 'target_blocked';

interface PreparedProtectedBinding {
  targetRef: string;
  fields: FillableFormFieldBinding[];
  fieldKeys: StoredSecretFieldKey[];
  action: ProtectedFillAction;
  target: TargetDescriptor;
  root: LocatorRoot;
  locator: Locator;
  attempts: string[];
}

export type ProtectedFillExecutionResult =
  | {
      kind: 'success';
      filledFields: ProtectedFilledField[];
    }
  | {
      kind: 'binding_stale';
      targetRef: string;
      fieldKeys: StoredSecretFieldKey[];
      reason: ProtectedBindingStaleReason;
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

function actionForTarget(target: TargetDescriptor): ProtectedFillAction {
  if (target.controlFamily === 'select') {
    return 'select';
  }
  if (target.allowedActions.includes('fill')) {
    return 'fill';
  }
  if (target.allowedActions.includes('type')) {
    return 'type';
  }
  if (target.allowedActions.includes('select')) {
    return 'select';
  }
  return 'fill';
}

function formatCardExpiry(month: string, year: string): string {
  const normalizedMonth = month.trim().padStart(2, '0');
  const normalizedYear =
    year.trim().length > 2 ? year.trim().slice(-2) : year.trim().padStart(2, '0');
  return `${normalizedMonth}/${normalizedYear}`;
}

function resolveBindingValue(
  fields: ReadonlyArray<FillableFormFieldBinding>,
  target: TargetDescriptor,
  protectedValues: Record<string, string>,
  fieldPolicies: StoredSecretFieldPolicies | undefined,
  assistedValues: ReadonlyMap<string, string>
): string {
  if (fields.length === 1) {
    const field = fields[0]!;
    const policy = resolveProtectedFieldPolicy(fieldPolicies, field.fieldKey);
    const deterministicValue = resolveDeterministicProtectedBindingValue(
      field,
      protectedValues,
      target
    );

    if (policy === 'llm_assisted') {
      const assistedValue = assistedValues.get(protectedBindingKey(field));
      if (typeof assistedValue === 'string' && assistedValue.length > 0) {
        return assistedValue;
      }
      throw new Error('assisted_value_resolution_failed');
    }

    if (typeof deterministicValue === 'string' && deterministicValue.length > 0) {
      return deterministicValue;
    }

    if ((field.valueHint ?? 'direct') !== 'direct') {
      throw new Error('deterministic_only_resolution_failed');
    }

    const value = protectedValues[field.fieldKey];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    throw new Error('missing_protected_value');
  }

  const includesExpiry =
    fields.some((field) => field.fieldKey === 'exp_month') &&
    fields.some((field) => field.fieldKey === 'exp_year') &&
    fields.length === 2;
  if (includesExpiry) {
    const month = protectedValues.exp_month;
    const year = protectedValues.exp_year;
    if (
      typeof month === 'string' &&
      month.length > 0 &&
      typeof year === 'string' &&
      year.length > 0
    ) {
      return formatCardExpiry(month, year);
    }
    throw new Error('missing_protected_value');
  }

  throw new Error('unsupported_protected_field_group');
}

function flattenFilledFields(
  fieldKeys: ReadonlyArray<StoredSecretFieldKey>,
  targetRef: string
): ProtectedFilledField[] {
  return fieldKeys.map((fieldKey) => ({
    fieldKey,
    targetRef,
  }));
}

function buildProtectedValidationDetails(validationText?: string): {
  validationTextRedacted?: true;
} {
  return validationText ? { validationTextRedacted: true } : {};
}

function shouldIgnoreNativeInvalidForTarget(target: TargetDescriptor): boolean {
  return Array.isArray(target.framePath) && target.framePath.length > 0;
}

async function readValidationState(locator: Locator): Promise<{
  invalid: boolean;
  validationText?: string;
}> {
  const payload = await locator
    .evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        return null;
      }

      const maybeControl =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
          ? element
          : null;
      const validationMessage = maybeControl?.validationMessage?.trim() ?? '';
      const describedByIds = (element.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .map((value) => value.trim())
        .filter(Boolean);
      const describedByText = describedByIds
        .map((id) => element.ownerDocument?.getElementById(id)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ');
      const ariaInvalid = element.getAttribute('aria-invalid') === 'true';
      const candidate = validationMessage || describedByText || '';

      return {
        validationText: candidate || undefined,
        ariaInvalid,
        invalid:
          ariaInvalid ||
          Boolean(
            maybeControl &&
              typeof maybeControl.checkValidity === 'function' &&
              maybeControl.checkValidity() === false
          ),
      };
    })
    .catch(() => null);

  if (!payload) {
    return {
      invalid: false,
    };
  }

  return {
    invalid: payload.invalid,
    validationText:
      payload.validationText ||
      (payload.ariaInvalid ? 'Field rejected by client-side validation.' : undefined),
  };
}

function groupBindingsByTarget(
  fillableForm: PersistedFillableForm,
  session: BrowserSessionState
): Array<{
  targetRef: string;
  fields: FillableFormFieldBinding[];
  fieldKeys: StoredSecretFieldKey[];
  target: TargetDescriptor;
}> | null {
  const grouped = new Map<
    string,
    {
      targetRef: string;
      fields: FillableFormFieldBinding[];
      fieldKeys: StoredSecretFieldKey[];
      target: TargetDescriptor;
    }
  >();

  for (const field of fillableForm.fields) {
    const target = getTarget(session, field.targetRef);
    if (!target) {
      return null;
    }

    const existing = grouped.get(field.targetRef);
    if (existing) {
      existing.fields.push(field);
      existing.fieldKeys.push(field.fieldKey);
      continue;
    }

    grouped.set(field.targetRef, {
      targetRef: field.targetRef,
      fields: [field],
      fieldKeys: [field.fieldKey],
      target,
    });
  }

  return sortProtectedBindingsForExecution(fillableForm.purpose, [...grouped.values()]);
}

async function prepareBindings(
  session: BrowserSessionState,
  page: Page,
  fillableForm: PersistedFillableForm
): Promise<PreparedProtectedBinding[] | ProtectedFillExecutionResult> {
  const groupedBindings = groupBindingsByTarget(fillableForm, session);
  if (!groupedBindings) {
    const firstField = fillableForm.fields[0];
    return {
      kind: 'binding_stale',
      targetRef: firstField?.targetRef ?? 'unknown',
      fieldKeys: firstField ? [firstField.fieldKey] : [],
      reason: 'target_missing',
      attempts: [],
    };
  }

  const preparedBindings: PreparedProtectedBinding[] = [];

  for (const binding of groupedBindings) {
    const attempts: string[] = [];
    const { target } = binding;

    if (target.lifecycle !== 'live') {
      return {
        kind: 'binding_stale',
        targetRef: binding.targetRef,
        fieldKeys: [...binding.fieldKeys],
        reason: 'target_not_live',
        attempts,
      };
    }

    if (target.pageSignature && normalizePageSignature(page.url()) !== target.pageSignature) {
      attempts.push('stale.page-signature:before-fill');
      return {
        kind: 'binding_stale',
        targetRef: binding.targetRef,
        fieldKeys: [...binding.fieldKeys],
        reason: 'page_signature_mismatch',
        attempts,
      };
    }

    const surface = target.surfaceRef ? getSurface(session, target.surfaceRef) : null;
    const { baseRoot, locatorRoot, surfaceRoot } = await resolveInteractionRoots(
      page,
      target,
      surface,
      attempts
    );

    let resolvedLocator: Locator | null = null;
    let sawDomSignatureMismatch = false;
    let sawBlockedTarget = false;
    const action = actionForTarget(target);

    const resolution = await resolvePreparedLocatorCandidates({
      target,
      action,
      baseRoot,
      locatorRoot,
      surfaceRoot,
      attempts,
      prepareOptions: {
        allowReadonlyFallback: action === 'fill' && target.controlFamily === 'datepicker',
      },
      onPreparedLocator: async (preparedLocator, strategy) => {
        if (target.domSignature) {
          const liveSignature = await readLocatorDomSignature(preparedLocator).catch(() => null);
          if (liveSignature && liveSignature !== target.domSignature) {
            sawDomSignatureMismatch = true;
            attempts.push(`domSignature.mismatch:${strategy}`);
            return false;
          }
        }

        resolvedLocator = preparedLocator;
        attempts.push(`resolve:${strategy}`);
        return true;
      },
    });
    if (resolution.sawDisabledTarget || resolution.sawReadonlyTarget) {
      sawBlockedTarget = true;
    }

    if (!resolvedLocator) {
      return {
        kind: 'binding_stale',
        targetRef: binding.targetRef,
        fieldKeys: [...binding.fieldKeys],
        reason: sawDomSignatureMismatch
          ? 'dom_signature_mismatch'
          : sawBlockedTarget
            ? 'target_blocked'
            : 'locator_resolution_failed',
        attempts,
      };
    }

    preparedBindings.push({
      targetRef: binding.targetRef,
      fields: [...binding.fields],
      fieldKeys: [...binding.fieldKeys],
      action,
      target,
      root: locatorRoot,
      locator: resolvedLocator,
      attempts,
    });
  }

  return preparedBindings;
}

function staleReasonFromError(error: unknown): ProtectedBindingStaleReason | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('page_signature_mismatch')) {
    return 'page_signature_mismatch';
  }
  if (message.includes('dom_signature_mismatch')) {
    return 'dom_signature_mismatch';
  }
  if (message.includes('locator_resolution_failed')) {
    return 'locator_resolution_failed';
  }
  return null;
}

export async function executeProtectedFill(params: {
  session: BrowserSessionState;
  page: Page;
  fillableForm: PersistedFillableForm;
  protectedValues: Record<string, string>;
  fieldPolicies?: StoredSecretFieldPolicies;
}): Promise<ProtectedFillExecutionResult> {
  const preparedBindings = await prepareBindings(params.session, params.page, params.fillableForm);
  if (!Array.isArray(preparedBindings)) {
    return preparedBindings;
  }

  let assistedValues: Map<string, string>;
  try {
    assistedValues = await resolveAssistedProtectedFieldValues({
      session: params.session,
      page: params.page,
      bindings: preparedBindings.map((binding) => ({
        binding: binding.fields[0]!,
        target: binding.target,
      })),
      protectedValues: params.protectedValues,
      fieldPolicies: params.fieldPolicies,
    });
  } catch (error) {
    const assistiveRuntimeMissing =
      error instanceof AgentbrowseAssistiveRuntimeMissingError ||
      (error instanceof Error && error.name === 'AgentbrowseAssistiveRuntimeMissingError');

    if (assistiveRuntimeMissing) {
      assistedValues = new Map();
      for (const binding of preparedBindings) {
        for (const field of binding.fields) {
          const deterministicValue =
            resolveDeterministicProtectedBindingValue(
              field,
              params.protectedValues,
              binding.target
            ) ??
            ((field.valueHint ?? 'direct') === 'direct'
              ? params.protectedValues[field.fieldKey]
              : null);
          if (typeof deterministicValue !== 'string' || deterministicValue.trim().length === 0) {
            continue;
          }
          assistedValues.set(protectedBindingKey(field), deterministicValue.trim());
        }
      }
    } else {
      return {
        kind: 'unexpected_error',
        reason: 'assisted_value_resolution_failed',
      };
    }
  }

  const filledFields: ProtectedFilledField[] = [];

  for (const binding of preparedBindings) {
    let actionValue: string;
    let acceptanceProbe: Awaited<ReturnType<typeof createAcceptanceProbe>> | null = null;
    let acceptanceResult: Awaited<ReturnType<typeof waitForAcceptanceProbe>> | null = null;
    try {
      actionValue = resolveBindingValue(
        binding.fields,
        binding.target,
        params.protectedValues,
        params.fieldPolicies,
        assistedValues
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'missing_protected_value') {
        return {
          kind: 'unexpected_error',
          reason: 'missing_protected_value',
        };
      }
      if (message === 'deterministic_only_resolution_failed') {
        return {
          kind: 'unexpected_error',
          reason: 'deterministic_only_resolution_failed',
        };
      }
      if (message === 'assisted_value_resolution_failed') {
        return {
          kind: 'unexpected_error',
          reason: 'assisted_value_resolution_failed',
        };
      }
      return {
        kind: 'unexpected_error',
        reason: 'unsupported_protected_field_group',
      };
    }

    try {
      acceptanceProbe = await createAcceptanceProbe({
        session: params.session,
        page: params.page,
        target: binding.target,
        action: binding.action,
        actionValue,
        locator: binding.locator,
        beforePageObservation: null,
      });

      await applyActionWithFallbacks(
        params.page,
        binding.root,
        binding.locator,
        binding.action,
        actionValue,
        binding.attempts,
        binding.target.controlFamily,
        {
          guards: {
            assertStillValid: async (stage: string) => {
              await assertStoredBindingStillValid(
                params.page,
                binding.locator,
                binding.target,
                stage,
                {
                  errorForReason: (reason, validationStage) =>
                    `binding_stale:${reason}:${validationStage}`,
                }
              );
            },
          },
        }
      );

      if (acceptanceProbe) {
        acceptanceResult = await waitForAcceptanceProbe(acceptanceProbe);
        const acceptance = acceptanceResult;
        if (!acceptance.accepted) {
          const validationState = await readValidationState(acceptanceProbe.readLocator);
          return {
            kind: 'validation_failed',
            filledFields,
            fieldErrors: binding.fieldKeys.map((fieldKey) => ({
              fieldKey,
              targetRef: binding.targetRef,
              reason: validationState.validationText
                ? 'client_validation_rejected'
                : 'value_not_applied',
              ...buildProtectedValidationDetails(validationState.validationText),
            })),
          };
        }

        const validationState = await readValidationState(acceptanceProbe.readLocator);
        if (validationState.invalid && !shouldIgnoreNativeInvalidForTarget(binding.target)) {
          return {
            kind: 'validation_failed',
            filledFields,
            fieldErrors: binding.fieldKeys.map((fieldKey) => ({
              fieldKey,
              targetRef: binding.targetRef,
              reason: 'client_validation_rejected',
              ...buildProtectedValidationDetails(validationState.validationText),
            })),
          };
        }
      }

      filledFields.push(...flattenFilledFields(binding.fieldKeys, binding.targetRef));
    } catch (error) {
      if (acceptanceProbe) {
        acceptanceResult =
          acceptanceResult ?? (await waitForAcceptanceProbe(acceptanceProbe).catch(() => null));
        if (acceptanceResult?.accepted) {
          const validationState = await readValidationState(acceptanceProbe.readLocator);
          if (validationState.invalid && !shouldIgnoreNativeInvalidForTarget(binding.target)) {
            return {
              kind: 'validation_failed',
              filledFields,
              fieldErrors: binding.fieldKeys.map((fieldKey) => ({
                fieldKey,
                targetRef: binding.targetRef,
                reason: 'client_validation_rejected',
                ...buildProtectedValidationDetails(validationState.validationText),
              })),
            };
          }

          filledFields.push(...flattenFilledFields(binding.fieldKeys, binding.targetRef));
          continue;
        }
      }

      const staleReason = staleReasonFromError(error);
      if (staleReason) {
        return {
          kind: 'binding_stale',
          targetRef: binding.targetRef,
          fieldKeys: [...binding.fieldKeys],
          reason: staleReason,
          attempts: [...binding.attempts],
        };
      }

      return {
        kind: 'unexpected_error',
        reason: 'action_failed',
      };
    }
  }

  return {
    kind: 'success',
    filledFields,
  };
}

export const __testProtectedFill = {
  actionForTarget,
  formatCardExpiry,
  resolveBindingValue: (
    fieldKeys: ReadonlyArray<StoredSecretFieldKey>,
    protectedValues: Record<string, string>,
    target?: TargetDescriptor
  ) =>
    resolveBindingValue(
      fieldKeys.map((fieldKey) => ({
        fieldKey,
        targetRef: 't_test',
        valueHint: 'direct',
      })),
      target ??
        ({
          ref: 't_test',
          pageRef: 'p0',
          capability: 'actionable',
          lifecycle: 'live',
          availability: { state: 'available' },
          allowedActions: ['fill'],
          locatorCandidates: [],
          createdAt: 0,
        } as TargetDescriptor),
      protectedValues,
      undefined,
      new Map()
    ),
};
