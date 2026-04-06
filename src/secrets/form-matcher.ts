import { z } from 'zod';
import type { AgentbrowseAssistiveLlmClient } from '../assistive-runtime.js';
import { tryCreateAgentbrowseAssistiveLlmClient } from '../assistive-runtime.js';
import type { BrowserSessionState } from '../browser-session-state.js';
import type { TargetDescriptor, TargetAvailabilityState } from '../runtime-state.js';
import type {
  FillableFormFieldBinding,
  FillableFormStoredSecretCandidate,
  PersistedFillableForm,
  SecretCatalogSnapshot,
  StoredSecretFieldKey,
  StoredSecretKind,
} from './types.js';
import { IDENTITY_FIELD_KEYS, LOGIN_FIELD_KEYS, PAYMENT_CARD_FIELD_KEYS } from './types.js';
import {
  normalizeProtectedBindingValueHint,
  protectedBindingKey,
  protectedBindingValueHintSchema,
} from './protected-bindings.js';
import { inferProtectedFieldMeaningFromTarget } from './protected-field-semantics.js';

type FillableFormDraft = Omit<PersistedFillableForm, 'fillRef'>;

interface MatcherOptions {
  observedAt?: string;
  session?: BrowserSessionState;
}

interface FormTargetGroup {
  groupKey: string;
  targets: TargetDescriptor[];
}

type PaymentCardCoreFieldStatus = 'resolved' | 'ambiguous' | 'missing';

const PROMPT_VALUE_MAX_CHARS = 180;
const PROMPT_SIGNAL_MAX_CHARS = 220;
const PROMPT_SIGNAL_MAX_VALUES = 8;

const PAYMENT_CARD_CORE_FIELD_KEYS = new Set<StoredSecretFieldKey>([
  'pan',
  'exp_month',
  'exp_year',
]);
const EXPLICIT_PAYMENT_CARD_CORE_FIELD_KEYS = new Set<StoredSecretFieldKey>(['pan', 'cvv']);
const IDENTITY_ANCHOR_FIELD_KEYS = new Set<StoredSecretFieldKey>([
  'document_number',
  'date_of_birth',
  'nationality',
  'issuing_country',
]);
const IDENTITY_SUPPLEMENTAL_FIELD_KEYS = new Set<StoredSecretFieldKey>([
  'issue_date',
  'expiry_date',
]);
const IDENTITY_NAME_FIELD_KEYS = new Set<StoredSecretFieldKey>(['full_name']);
const EXPLICIT_PAYMENT_CARD_NAME_SIGNAL_RE =
  /\b(cardholder|card holder|name on card|cardholder name)\b/i;
const PAYMENT_CARD_PAN_SIGNAL_RE = /\b(card number|card no|cc-number|cc number)\b/i;
const PAYMENT_CARD_CVV_SIGNAL_RE = /\b(security code|cvv|cvc)\b/i;
const STRONG_PAYMENT_CARD_EXP_SIGNAL_RE =
  /\b(mm\s*\/\s*yy|mmyy|card exp(?:iry)?|card expiration|cc-exp)\b/i;
const GENERIC_SHELL_SELECTOR_ROOTS = new Set(['#__next', '#root', '#app', '#app-root']);

const protectedFormPlanSchema = z.object({
  confidence: z.enum(['high', 'medium', 'low']),
  bindings: z
    .array(
      z.object({
        targetRef: z.string(),
        fieldKey: z.string(),
        valueHint: protectedBindingValueHintSchema.optional(),
      })
    )
    .max(24),
});

function normalizeText(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
}

function compactPromptValue(
  value: string | undefined,
  maxChars = PROMPT_VALUE_MAX_CHARS
): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
}

function isTargetEligibleForProtectedFill(target: TargetDescriptor): boolean {
  if (target.lifecycle !== 'live') {
    return false;
  }

  if (!allowsProtectedAvailability(target.availability)) {
    return false;
  }

  return (
    target.allowedActions.includes('fill') ||
    target.allowedActions.includes('type') ||
    target.allowedActions.includes('select')
  );
}

function allowsProtectedAvailability(availability: TargetAvailabilityState | undefined): boolean {
  return availability?.state === undefined || availability.state === 'available';
}

function selectorSignalFragments(selector: string): string[] {
  const fragments: string[] = [];
  for (const match of selector.matchAll(/\[name="([^"]+)"\]/g)) {
    fragments.push(match[1] ?? '');
  }
  for (const match of selector.matchAll(/#([a-zA-Z0-9_-]+)/g)) {
    fragments.push(match[1] ?? '');
  }
  return fragments;
}

function selectorRootOf(target: Pick<TargetDescriptor, 'context'>): string | null {
  const selectors = [
    target.context?.item?.selector,
    target.context?.container?.selector,
    target.context?.landmark?.selector,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  for (const selector of selectors) {
    for (const match of selector.matchAll(/#[A-Za-z0-9_-]+/g)) {
      const candidate = match[0]?.trim().toLowerCase();
      if (!candidate || GENERIC_SHELL_SELECTOR_ROOTS.has(candidate)) {
        continue;
      }
      return match[0];
    }
  }

  return null;
}

function signalValuesOf(target: TargetDescriptor): string[] {
  const values = new Set<string>();

  const push = (value: string | undefined): void => {
    const normalized = normalizeText(value);
    if (normalized) {
      values.add(
        normalized.length > PROMPT_SIGNAL_MAX_CHARS
          ? `${normalized.slice(0, PROMPT_SIGNAL_MAX_CHARS - 1)}…`
          : normalized
      );
    }
  };

  push(target.label);
  push(target.displayLabel);
  push(target.kind);
  push(target.semantics?.role);
  push(target.semantics?.name);
  push(target.context?.hintText);
  push(target.context?.group?.label);
  push(target.context?.group?.text);
  push(target.context?.container?.label);
  push(target.context?.container?.text);
  push(target.context?.landmark?.label);
  push(target.context?.landmark?.text);

  for (const candidate of target.locatorCandidates) {
    push(candidate.name);
    push(candidate.value);
    if (candidate.strategy === 'css' || candidate.strategy === 'xpath') {
      for (const fragment of selectorSignalFragments(candidate.value)) {
        push(fragment);
      }
    }
  }

  return [...values];
}

function directFieldSignalValuesOf(target: TargetDescriptor): string[] {
  const values = new Set<string>();

  const push = (value: string | undefined): void => {
    const normalized = normalizeText(value);
    if (normalized) {
      values.add(normalized);
    }
  };

  push(target.label);
  push(target.displayLabel);
  push(target.placeholder);
  push(target.inputName);
  push(target.inputType);
  push(target.autocomplete);
  push(target.semantics?.name);

  return [...values];
}

function targetHasInferredProtectedMeaning(
  target: TargetDescriptor,
  kind: StoredSecretKind,
  fieldKeys?: ReadonlySet<StoredSecretFieldKey>
): boolean {
  return inferProtectedFieldMeaningFromTarget(target).some((hint) => {
    if (hint.kind !== kind) {
      return false;
    }
    return !fieldKeys || fieldKeys.has(hint.fieldKey);
  });
}

function targetLooksLikePaymentCardCore(target: TargetDescriptor): boolean {
  return targetHasInferredProtectedMeaning(target, 'payment_card', PAYMENT_CARD_CORE_FIELD_KEYS);
}

function targetLooksRelevantToPaymentCard(target: TargetDescriptor): boolean {
  return (
    targetLooksLikeExplicitPaymentCardTarget(target) ||
    targetLooksLikePaymentCardCore(target) ||
    targetHasInferredProtectedMeaning(target, 'payment_card')
  );
}

function deterministicPaymentCardFieldKeysForTarget(
  target: TargetDescriptor
): StoredSecretFieldKey[] {
  return inferProtectedFieldMeaningFromTarget(target)
    .filter((hint) => hint.kind === 'payment_card')
    .map((hint) => hint.fieldKey);
}

function collectPaymentCardFieldTargets(
  plannerGroup: FormTargetGroup
): Map<StoredSecretFieldKey, Set<string>> {
  const fieldTargets = new Map<StoredSecretFieldKey, Set<string>>();

  for (const target of plannerGroup.targets) {
    for (const fieldKey of deterministicPaymentCardFieldKeysForTarget(target)) {
      const refs = fieldTargets.get(fieldKey) ?? new Set<string>();
      refs.add(target.ref);
      fieldTargets.set(fieldKey, refs);
    }
  }

  return fieldTargets;
}

function paymentCardCoreFieldStatuses(
  plannerGroup: FormTargetGroup
): Map<StoredSecretFieldKey, PaymentCardCoreFieldStatus> {
  const fieldTargets = collectPaymentCardFieldTargets(plannerGroup);
  const statuses = new Map<StoredSecretFieldKey, PaymentCardCoreFieldStatus>();

  for (const fieldKey of PAYMENT_CARD_CORE_FIELD_KEYS) {
    const refs = fieldTargets.get(fieldKey);
    if (!refs || refs.size === 0) {
      statuses.set(fieldKey, 'missing');
      continue;
    }

    statuses.set(fieldKey, refs.size === 1 ? 'resolved' : 'ambiguous');
  }

  return statuses;
}

function paymentCardClusterKeysOf(
  target: Pick<TargetDescriptor, 'surfaceRef' | 'controlsSurfaceSelector' | 'framePath'>
): string[] {
  const keys = new Set<string>();
  const push = (prefix: string, value: string | null | undefined): void => {
    const normalized = normalizeText(value ?? undefined);
    if (normalized) {
      keys.add(`${prefix}:${normalized}`);
    }
  };

  push('surface', target.surfaceRef);
  push('controls-surface', target.controlsSurfaceSelector);
  push('frame', frameKeyOf(target));

  return [...keys];
}

function sharesPaymentCardCluster(
  left: Pick<TargetDescriptor, 'surfaceRef' | 'controlsSurfaceSelector' | 'framePath'>,
  right: Pick<TargetDescriptor, 'surfaceRef' | 'controlsSurfaceSelector' | 'framePath'>
): boolean {
  const leftKeys = paymentCardClusterKeysOf(left);
  if (leftKeys.length === 0) {
    return false;
  }

  const rightKeys = new Set(paymentCardClusterKeysOf(right));
  return leftKeys.some((key) => rightKeys.has(key));
}

function targetCouldBeUnresolvedPaymentCardField(target: TargetDescriptor): boolean {
  if (targetLooksRelevantToPaymentCard(target)) {
    return false;
  }

  const autocomplete = normalizeText(target.autocomplete);
  const signals = signalValuesOf(target);
  if (normalizeText(target.inputType) === 'email' || autocomplete.includes('email')) {
    return false;
  }

  if (
    autocomplete.includes('tel') ||
    signals.some((signal) => /\b(phone|mobile|telephone|tel)\b/.test(signal))
  ) {
    return false;
  }

  if (targetLooksLikeLoginUsernameTarget(target) || targetLooksLikeLoginPasswordTarget(target)) {
    return false;
  }

  if (
    targetLooksLikeIdentityAnchorTarget(target) ||
    targetLooksLikeIdentitySupplementalTarget(target)
  ) {
    return false;
  }

  const inputType = normalizeText(target.inputType);
  if (inputType === 'hidden' || inputType === 'search' || inputType === 'url') {
    return false;
  }

  return true;
}

function unresolvedPaymentCardClusterTargets(
  group: FormTargetGroup,
  relevantTargets: ReadonlyArray<TargetDescriptor>
): TargetDescriptor[] {
  const relevantTargetRefs = new Set(relevantTargets.map((target) => target.ref));

  return group.targets.filter((target) => {
    if (relevantTargetRefs.has(target.ref)) {
      return false;
    }

    if (!targetCouldBeUnresolvedPaymentCardField(target)) {
      return false;
    }

    return relevantTargets.some((relevantTarget) =>
      sharesPaymentCardCluster(target, relevantTarget)
    );
  });
}

function deterministicPaymentCardPlan(
  plannerGroup: FormTargetGroup,
  fullGroup: FormTargetGroup
): {
  confidence: 'high';
  fields: FillableFormFieldBinding[];
} | null {
  const fieldTargets = collectPaymentCardFieldTargets(plannerGroup);

  for (const fieldKey of PAYMENT_CARD_CORE_FIELD_KEYS) {
    const refs = fieldTargets.get(fieldKey);
    if (!refs || refs.size !== 1) {
      return null;
    }
  }

  const bindings: FillableFormFieldBinding[] = [];
  const targetByRef = new Map(fullGroup.targets.map((target) => [target.ref, target]));
  const seen = new Set<string>();
  const push = (fieldKey: StoredSecretFieldKey, targetRef: string): void => {
    const key = protectedBindingKey({ fieldKey, targetRef, valueHint: 'direct' });
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    bindings.push({
      fieldKey,
      targetRef,
      label: targetByRef.get(targetRef)?.displayLabel ?? targetByRef.get(targetRef)?.label,
      required: targetByRef.get(targetRef)?.validation?.required,
      valueHint: 'direct',
    });
  };

  push('pan', [...fieldTargets.get('pan')!][0]!);
  const expiryTargetRef = [...fieldTargets.get('exp_month')!][0]!;
  push('exp_month', expiryTargetRef);
  push('exp_year', expiryTargetRef);
  const cvvRefs = fieldTargets.get('cvv');
  if (cvvRefs?.size === 1) {
    push('cvv', [...cvvRefs][0]!);
  }

  const cardholderRefs = fieldTargets.get('cardholder');
  if (cardholderRefs?.size === 1) {
    push('cardholder', [...cardholderRefs][0]!);
  }

  const sortedBindings = bindings.sort((left, right) => {
    const leftPriority = canonicalFieldOrder('payment_card').indexOf(left.fieldKey);
    const rightPriority = canonicalFieldOrder('payment_card').indexOf(right.fieldKey);
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return left.targetRef.localeCompare(right.targetRef);
  });

  return {
    confidence: 'high',
    fields: dropSuspiciousIframePaymentCardBindings(sortedBindings, fullGroup, targetByRef),
  };
}

function targetLooksLikeExplicitPaymentCardTarget(target: TargetDescriptor): boolean {
  const autocomplete = normalizeText(target.autocomplete);
  const inputName = normalizeText(target.inputName);
  const signals = directFieldSignalValuesOf(target);
  const frameKey = normalizeText(frameKeyOf(target) ?? undefined);

  if (targetLooksLikeExplicitPaymentCardCoreTarget(target) || autocomplete.includes('cc-name')) {
    return true;
  }

  if (signals.some((signal) => EXPLICIT_PAYMENT_CARD_NAME_SIGNAL_RE.test(signal))) {
    return true;
  }

  if (/\b(cardholder|card-holder|cc-name)\b/.test(inputName)) {
    return true;
  }

  return /\bcard[-_ ]?(number|expiry|exp|cvc|cvv|security|holder)\b/.test(frameKey);
}

function targetLooksLikeExplicitPaymentCardCoreTarget(target: TargetDescriptor): boolean {
  const autocomplete = normalizeText(target.autocomplete);
  const inputName = normalizeText(target.inputName);
  const signals = directFieldSignalValuesOf(target);
  const frameKey = normalizeText(frameKeyOf(target) ?? undefined);

  if (
    autocomplete.includes('cc-number') ||
    autocomplete.includes('cc-exp') ||
    autocomplete.includes('cc-csc')
  ) {
    return true;
  }

  if (
    targetHasInferredProtectedMeaning(target, 'payment_card', EXPLICIT_PAYMENT_CARD_CORE_FIELD_KEYS)
  ) {
    return true;
  }

  if (signals.some((signal) => PAYMENT_CARD_PAN_SIGNAL_RE.test(signal))) {
    return true;
  }
  if (signals.some((signal) => PAYMENT_CARD_CVV_SIGNAL_RE.test(signal))) {
    return true;
  }
  if (signals.some((signal) => STRONG_PAYMENT_CARD_EXP_SIGNAL_RE.test(signal))) {
    return true;
  }

  if (/\b(card(number)?|cc-?number|cvv|cvc|security)\b/.test(inputName)) {
    return true;
  }
  if (/\bcc[-_ ]?exp\b/.test(inputName)) {
    return true;
  }

  return /\bcard[-_ ]?(number|expiry|exp|cvc|cvv|security)\b/.test(frameKey);
}

function targetLooksLikeIdentityAnchorTarget(target: TargetDescriptor): boolean {
  return targetHasInferredProtectedMeaning(target, 'identity', IDENTITY_ANCHOR_FIELD_KEYS);
}

function targetLooksLikeIdentitySupplementalTarget(target: TargetDescriptor): boolean {
  if (targetLooksLikeExplicitPaymentCardTarget(target)) {
    return false;
  }

  return targetHasInferredProtectedMeaning(target, 'identity', IDENTITY_SUPPLEMENTAL_FIELD_KEYS);
}

function targetLooksLikeIdentityNameTarget(target: TargetDescriptor): boolean {
  if (targetLooksLikeExplicitPaymentCardTarget(target)) {
    return false;
  }

  return targetHasInferredProtectedMeaning(target, 'identity', IDENTITY_NAME_FIELD_KEYS);
}

function targetLooksLikePotentialIdentityNameTarget(target: TargetDescriptor): boolean {
  if (targetLooksLikeExplicitPaymentCardTarget(target)) {
    return false;
  }

  if (targetLooksLikeIdentityNameTarget(target)) {
    return true;
  }

  const signals = directFieldSignalValuesOf(target);
  return signals.some((signal) =>
    /\b(full name|first name|given name|middle name|last name|family name|surname|forename)\b/.test(
      signal
    )
  );
}

function targetLooksLikePotentialIdentityDobPartTarget(target: TargetDescriptor): boolean {
  if (targetLooksLikeExplicitPaymentCardTarget(target)) {
    return false;
  }

  if (
    !(
      target.controlFamily === 'select' ||
      target.controlFamily === 'datepicker' ||
      target.kind === 'select' ||
      target.allowedActions.includes('select')
    )
  ) {
    return false;
  }

  const signals = directFieldSignalValuesOf(target);
  return signals.some((signal) => /\b(day|month|year)\b/.test(signal));
}

type IdentityBindingSpec = {
  fieldKey: StoredSecretFieldKey;
  valueHint?: FillableFormFieldBinding['valueHint'];
};

function deterministicIdentityBindingsForTarget(target: TargetDescriptor): IdentityBindingSpec[] {
  return inferProtectedFieldMeaningFromTarget(target)
    .filter((hint) => hint.kind === 'identity')
    .map((hint) => ({
      fieldKey: hint.fieldKey,
      valueHint: hint.valueHint,
    }));
}

function deterministicIdentityPlan(
  plannerGroup: FormTargetGroup,
  fullGroup: FormTargetGroup
): {
  confidence: 'high';
  fields: FillableFormFieldBinding[];
} | null {
  const fieldTargets = new Map<
    string,
    {
      fieldKey: StoredSecretFieldKey;
      targetRef: string;
      valueHint: FillableFormFieldBinding['valueHint'];
    }
  >();

  for (const target of plannerGroup.targets) {
    for (const binding of deterministicIdentityBindingsForTarget(target)) {
      const key = protectedBindingKey({
        fieldKey: binding.fieldKey,
        targetRef: target.ref,
        valueHint: binding.valueHint ?? 'direct',
      });
      if (fieldTargets.has(key)) {
        return null;
      }
      fieldTargets.set(key, {
        fieldKey: binding.fieldKey,
        targetRef: target.ref,
        valueHint: normalizeProtectedBindingValueHint(binding.fieldKey, binding.valueHint),
      });
    }
  }

  if (fieldTargets.size === 0) {
    return null;
  }

  const targetByRef = new Map(fullGroup.targets.map((target) => [target.ref, target]));
  const fields: FillableFormFieldBinding[] = [];

  for (const binding of fieldTargets.values()) {
    const target = targetByRef.get(binding.targetRef);
    fields.push({
      fieldKey: binding.fieldKey,
      targetRef: binding.targetRef,
      label: target?.displayLabel ?? target?.label,
      required: target?.validation?.required,
      valueHint: binding.valueHint,
    });
  }

  const boundTargetRefs = new Set(fields.map((field) => field.targetRef));
  const hasUnresolvedPlannerRelevantTargets = fullGroup.targets.some((target) => {
    if (boundTargetRefs.has(target.ref)) {
      return false;
    }

    return (
      targetLooksLikePotentialIdentityNameTarget(target) ||
      targetLooksLikePotentialIdentityDobPartTarget(target) ||
      targetLooksLikeIdentityAnchorTarget(target) ||
      targetLooksLikeIdentitySupplementalTarget(target)
    );
  });

  if (hasUnresolvedPlannerRelevantTargets) {
    return null;
  }

  return {
    confidence: 'high',
    fields: fields.sort((left, right) => {
      const leftPriority = canonicalFieldOrder('identity').indexOf(left.fieldKey);
      const rightPriority = canonicalFieldOrder('identity').indexOf(right.fieldKey);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return left.targetRef.localeCompare(right.targetRef);
    }),
  };
}

function targetLooksLikeLoginUsernameTarget(target: TargetDescriptor): boolean {
  return inferProtectedFieldMeaningFromTarget(target).some(
    (hint) => hint.kind === 'login' && hint.fieldKey === 'username'
  );
}

function targetLooksLikeLoginPasswordTarget(target: TargetDescriptor): boolean {
  return inferProtectedFieldMeaningFromTarget(target).some(
    (hint) => hint.kind === 'login' && hint.fieldKey === 'password'
  );
}

function deterministicLoginFieldKeysForTarget(target: TargetDescriptor): StoredSecretFieldKey[] {
  return inferProtectedFieldMeaningFromTarget(target)
    .filter((hint) => hint.kind === 'login')
    .map((hint) => hint.fieldKey);
}

function deterministicLoginPlan(
  plannerGroup: FormTargetGroup,
  fullGroup: FormTargetGroup
): {
  confidence: 'high';
  fields: FillableFormFieldBinding[];
} | null {
  const fieldTargets = new Map<StoredSecretFieldKey, Set<string>>();

  for (const target of plannerGroup.targets) {
    for (const fieldKey of deterministicLoginFieldKeysForTarget(target)) {
      const refs = fieldTargets.get(fieldKey) ?? new Set<string>();
      refs.add(target.ref);
      fieldTargets.set(fieldKey, refs);
    }
  }

  const usernameRefs = fieldTargets.get('username');
  const passwordRefs = fieldTargets.get('password');
  if (!usernameRefs || usernameRefs.size !== 1 || !passwordRefs || passwordRefs.size !== 1) {
    return null;
  }

  const targetByRef = new Map(fullGroup.targets.map((target) => [target.ref, target]));
  const fields: FillableFormFieldBinding[] = [
    {
      fieldKey: 'username',
      targetRef: [...usernameRefs][0]!,
      label:
        targetByRef.get([...usernameRefs][0]!)?.displayLabel ??
        targetByRef.get([...usernameRefs][0]!)?.label,
      required: targetByRef.get([...usernameRefs][0]!)?.validation?.required,
      valueHint: 'direct',
    },
    {
      fieldKey: 'password',
      targetRef: [...passwordRefs][0]!,
      label:
        targetByRef.get([...passwordRefs][0]!)?.displayLabel ??
        targetByRef.get([...passwordRefs][0]!)?.label,
      required: targetByRef.get([...passwordRefs][0]!)?.validation?.required,
      valueHint: 'direct',
    },
  ];

  return {
    confidence: 'high',
    fields,
  };
}

function loginPlannerGroup(group: FormTargetGroup): FormTargetGroup | null {
  const relevantTargets = group.targets.filter(
    (target) =>
      targetLooksLikeLoginUsernameTarget(target) || targetLooksLikeLoginPasswordTarget(target)
  );
  if (relevantTargets.length === 0) {
    return null;
  }

  const hasPasswordAnchor = relevantTargets.some((target) =>
    targetLooksLikeLoginPasswordTarget(target)
  );
  if (!hasPasswordAnchor) {
    return null;
  }

  return {
    groupKey: group.groupKey,
    targets: relevantTargets,
  };
}

function identityPlannerGroup(group: FormTargetGroup): FormTargetGroup | null {
  const identityAnchorTargets = group.targets.filter(
    (target) =>
      !targetLooksLikeExplicitPaymentCardTarget(target) &&
      targetLooksLikeIdentityAnchorTarget(target)
  );
  if (identityAnchorTargets.length === 0) {
    return null;
  }

  const hasPotentialNameTarget = group.targets.some(targetLooksLikePotentialIdentityNameTarget);
  if (!hasPotentialNameTarget) {
    return null;
  }

  return {
    groupKey: group.groupKey,
    targets: group.targets.filter((target) => !targetLooksLikeExplicitPaymentCardTarget(target)),
  };
}

interface PlannerGroupCandidate {
  kind: StoredSecretKind;
  plannerGroup: FormTargetGroup;
}

function plannerGroupForKind(
  kind: StoredSecretKind,
  group: FormTargetGroup
): FormTargetGroup | null {
  switch (kind) {
    case 'login':
      return loginPlannerGroup(group);
    case 'payment_card': {
      const relevantTargets = group.targets.filter((target) =>
        targetLooksRelevantToPaymentCard(target)
      );
      if (relevantTargets.length === 0) {
        return null;
      }

      const hasCoreAnchor = relevantTargets.some((target) =>
        targetLooksLikeExplicitPaymentCardCoreTarget(target)
      );
      if (!hasCoreAnchor) {
        return null;
      }

      const relevantGroup = {
        groupKey: group.groupKey,
        targets: relevantTargets,
      };
      const coreStatuses = paymentCardCoreFieldStatuses(relevantGroup);
      const hasAmbiguousCoreField = [...coreStatuses.values()].some(
        (status) => status === 'ambiguous'
      );
      const hasMissingCoreField = [...coreStatuses.values()].some((status) => status === 'missing');
      const unresolvedTargets = unresolvedPaymentCardClusterTargets(group, relevantTargets);

      if (hasMissingCoreField && !hasAmbiguousCoreField && unresolvedTargets.length === 0) {
        return null;
      }

      return {
        groupKey: group.groupKey,
        targets: [...relevantTargets, ...unresolvedTargets],
      };
    }
    case 'identity':
      return identityPlannerGroup(group);
    default:
      return group;
  }
}

function formGroupKeyOf(target: TargetDescriptor): string {
  for (const node of [target.context?.group, target.context?.container, target.context?.item]) {
    if (normalizeText(node?.kind) !== 'form') {
      continue;
    }

    const label = normalizeText(node?.label ?? node?.text);
    if (label) {
      return `form:${label}`;
    }
  }

  if (normalizeText(target.context?.landmark?.kind) === 'form') {
    const landmarkLabel = normalizeText(target.context?.landmark?.label);
    if (landmarkLabel) {
      return `form:${landmarkLabel}`;
    }
  }

  const selectorRoot = selectorRootOf(target);
  if (selectorRoot) {
    return `selector-root:${selectorRoot}`;
  }

  if (target.surfaceRef) {
    return `surface:${target.surfaceRef}`;
  }

  return `page:${target.pageRef}`;
}

function groupTargetsByForm(targets: ReadonlyArray<TargetDescriptor>): FormTargetGroup[] {
  const groups = new Map<string, TargetDescriptor[]>();

  for (const target of targets) {
    if (!isTargetEligibleForProtectedFill(target)) {
      continue;
    }

    const groupKey = formGroupKeyOf(target);
    const group = groups.get(groupKey) ?? [];
    group.push(target);
    groups.set(groupKey, group);
  }

  return [...groups.entries()].map(([groupKey, groupTargets]) => ({
    groupKey,
    targets: groupTargets,
  }));
}

function canonicalFieldOrder(kind: StoredSecretKind): ReadonlyArray<StoredSecretFieldKey> {
  switch (kind) {
    case 'login':
      return LOGIN_FIELD_KEYS;
    case 'identity':
      return IDENTITY_FIELD_KEYS;
    case 'payment_card':
      return PAYMENT_CARD_FIELD_KEYS;
  }
}

function purposePrompt(kind: StoredSecretKind): string {
  switch (kind) {
    case 'login':
      return [
        'Purpose: login form.',
        'Expected canonical fields: username, password.',
        'Match email/login/account fields to username when clearly used for sign-in.',
        'Do not invent additional fields.',
      ].join('\n');
    case 'identity':
      return [
        'Purpose: identity or traveler details form.',
        'Expected canonical fields: full_name, document_number, date_of_birth, nationality, issue_date, expiry_date, issuing_country.',
        'full_name may be one direct full-name field or two split fields:',
        '- First/Given name -> fieldKey=full_name, valueHint=full_name.given',
        '- Last/Family/Surname -> fieldKey=full_name, valueHint=full_name.family',
        'date_of_birth may be one direct field or three split controls:',
        '- Day control -> fieldKey=date_of_birth, valueHint=date_of_birth.day',
        '- Month control -> fieldKey=date_of_birth, valueHint=date_of_birth.month',
        '- Year control -> fieldKey=date_of_birth, valueHint=date_of_birth.year',
        'Do not confuse contact fields like email, phone, address, city, country/region with identity fields.',
        'Do not treat generic contact-only forms as identity forms.',
      ].join('\n');
    case 'payment_card':
      return [
        'Purpose: payment card form.',
        'Expected canonical fields: pan, exp_month, exp_year.',
        'cardholder and cvv are optional when the page does not expose them.',
        'A single expiry field may map to both exp_month and exp_year.',
        'Do not confuse promo codes or billing ZIP/postcode with card data.',
      ].join('\n');
  }
}

function buildTargetSummary(target: TargetDescriptor): string {
  const parts = [`targetRef=${JSON.stringify(target.ref)}`];

  const push = (key: string, value: string | undefined): void => {
    const compact = compactPromptValue(value);
    if (compact) {
      parts.push(`${key}=${JSON.stringify(compact)}`);
    }
  };

  if (target.kind) parts.push(`kind=${JSON.stringify(target.kind)}`);
  push('label', target.label);
  push('displayLabel', target.displayLabel);
  push('role', target.semantics?.role);
  push('semanticsName', target.semantics?.name);
  push('hintText', target.context?.hintText);
  push('groupLabel', target.context?.group?.label);
  push('groupText', target.context?.group?.text);
  if (target.context?.container?.label) {
    push('containerLabel', target.context.container.label);
  }
  if (target.context?.container?.text) {
    push('containerText', target.context.container.text);
  }
  if (target.context?.landmark?.label) {
    push('landmarkLabel', target.context.landmark.label);
  }
  if (target.allowedActions.length > 0) {
    parts.push(`allowedActions=${JSON.stringify(target.allowedActions)}`);
  }
  if (target.controlFamily) {
    parts.push(`controlFamily=${JSON.stringify(target.controlFamily)}`);
  }

  const signals = signalValuesOf(target);
  if (signals.length > 0) {
    parts.push(`signals=${JSON.stringify(signals.slice(0, PROMPT_SIGNAL_MAX_VALUES))}`);
  }

  return parts.join(' | ');
}

function buildMatcherPrompt(kind: StoredSecretKind, group: FormTargetGroup): string {
  return [
    'You are matching protected form fields from an already discovered deterministic DOM inventory.',
    'Return only bindings that are clearly supported by the visible field labels, placeholders, context, and locator-derived signals.',
    'Fail closed. If the form is ambiguous, return low confidence with no bindings.',
    'Use only the provided targetRef values.',
    'For direct matches, omit valueHint or use valueHint=direct.',
    purposePrompt(kind),
    '',
    `Form group key: ${group.groupKey}`,
    'Targets:',
    ...group.targets.map((target) => buildTargetSummary(target)),
  ].join('\n');
}

function sanitizeBindings(
  kind: StoredSecretKind,
  group: FormTargetGroup,
  bindings: ReadonlyArray<z.infer<typeof protectedFormPlanSchema>['bindings'][number]>
): FillableFormFieldBinding[] {
  const allowedFieldKeys = new Set(canonicalFieldOrder(kind));
  const allowedTargetRefs = new Set(group.targets.map((target) => target.ref));
  const uniqueBindings = new Map<string, FillableFormFieldBinding>();
  const targetByRef = new Map(group.targets.map((target) => [target.ref, target]));

  for (const binding of bindings) {
    if (!allowedTargetRefs.has(binding.targetRef)) {
      continue;
    }

    if (!allowedFieldKeys.has(binding.fieldKey as StoredSecretFieldKey)) {
      continue;
    }

    const fieldKey = binding.fieldKey as StoredSecretFieldKey;
    const normalizedValueHint = normalizeProtectedBindingValueHint(fieldKey, binding.valueHint);
    const key = protectedBindingKey({
      fieldKey,
      targetRef: binding.targetRef,
      valueHint: normalizedValueHint,
    });
    if (uniqueBindings.has(key)) {
      continue;
    }

    uniqueBindings.set(key, {
      fieldKey,
      targetRef: binding.targetRef,
      label:
        targetByRef.get(binding.targetRef)?.displayLabel ??
        targetByRef.get(binding.targetRef)?.label,
      required: targetByRef.get(binding.targetRef)?.validation?.required,
      valueHint: normalizedValueHint,
    });
  }

  return [...uniqueBindings.values()].sort((left, right) => {
    const leftPriority = canonicalFieldOrder(kind).indexOf(left.fieldKey);
    const rightPriority = canonicalFieldOrder(kind).indexOf(right.fieldKey);
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return left.targetRef.localeCompare(right.targetRef);
  });
}

function isCredibleKindMatch(
  kind: StoredSecretKind,
  fieldBindings: ReadonlyArray<FillableFormFieldBinding>
): boolean {
  if (fieldBindings.length === 0) {
    return false;
  }

  const fieldKeys = new Set(fieldBindings.map((field) => field.fieldKey));

  switch (kind) {
    case 'login':
      return fieldKeys.has('username') && fieldKeys.has('password');
    case 'payment_card':
      return fieldKeys.has('pan') && fieldKeys.has('exp_month') && fieldKeys.has('exp_year');
    case 'identity': {
      const anchorKeys = new Set<StoredSecretFieldKey>([
        'document_number',
        'date_of_birth',
        'nationality',
        'issue_date',
        'expiry_date',
        'issuing_country',
      ]);
      const hasAnchor = [...fieldKeys].some((fieldKey) => anchorKeys.has(fieldKey));
      const hasDirectFullName = fieldBindings.some(
        (field) => field.fieldKey === 'full_name' && (field.valueHint ?? 'direct') === 'direct'
      );
      const hasGivenName = fieldBindings.some(
        (field) => field.fieldKey === 'full_name' && field.valueHint === 'full_name.given'
      );
      const hasFamilyName = fieldBindings.some(
        (field) => field.fieldKey === 'full_name' && field.valueHint === 'full_name.family'
      );
      const hasCompleteName = hasDirectFullName || (hasGivenName && hasFamilyName);
      return hasAnchor && hasCompleteName;
    }
  }
}

function frameKeyOf(target: Pick<TargetDescriptor, 'framePath'>): string | null {
  if (!target.framePath || target.framePath.length === 0) {
    return null;
  }

  return target.framePath.join('>');
}

function targetLooksLikeIframeEnrollmentField(target: TargetDescriptor): boolean {
  const autocomplete = normalizeText(target.autocomplete);
  const signals = signalValuesOf(target);

  if (normalizeText(target.inputType) === 'email' || autocomplete.includes('email')) {
    return true;
  }

  if (
    autocomplete.includes('tel') ||
    signals.some((signal) => /\b(phone|mobile|telephone|tel)\b/.test(signal))
  ) {
    return true;
  }

  return false;
}

function dropSuspiciousIframePaymentCardBindings(
  fields: ReadonlyArray<FillableFormFieldBinding>,
  group: FormTargetGroup,
  targetByRef: ReadonlyMap<string, TargetDescriptor>
): FillableFormFieldBinding[] {
  const iframeEnrollmentFrames = new Set<string>();

  for (const target of group.targets) {
    const frameKey = frameKeyOf(target);
    if (!frameKey) {
      continue;
    }

    if (targetLooksLikeIframeEnrollmentField(target)) {
      iframeEnrollmentFrames.add(frameKey);
    }
  }

  if (iframeEnrollmentFrames.size === 0) {
    return [...fields];
  }

  return fields.filter((field) => {
    if (PAYMENT_CARD_CORE_FIELD_KEYS.has(field.fieldKey)) {
      return true;
    }

    if (field.fieldKey !== 'cardholder') {
      return true;
    }

    const target = targetByRef.get(field.targetRef);
    const frameKey = target ? frameKeyOf(target) : null;
    if (!frameKey) {
      return true;
    }

    return !iframeEnrollmentFrames.has(frameKey);
  });
}

function formScopeRef(
  fields: ReadonlyArray<FillableFormFieldBinding>,
  targetByRef: ReadonlyMap<string, TargetDescriptor>
): string | undefined {
  const surfaceRefs = new Set<string>();

  for (const field of fields) {
    const surfaceRef = targetByRef.get(field.targetRef)?.surfaceRef;
    if (surfaceRef) {
      surfaceRefs.add(surfaceRef);
    }
  }

  return surfaceRefs.size === 1 ? [...surfaceRefs][0] : undefined;
}

function buildStoredSecretCandidates(
  catalog: SecretCatalogSnapshot,
  kind: StoredSecretKind,
  confidence: 'high' | 'medium',
  matchedFieldKeys: ReadonlySet<StoredSecretFieldKey>
): FillableFormStoredSecretCandidate[] {
  return catalog.storedSecrets
    .filter(
      (secret) =>
        secret.kind === kind && secret.fieldKeys.some((fieldKey) => matchedFieldKeys.has(fieldKey))
    )
    .map((secret) => ({
      storedSecretRef: secret.storedSecretRef,
      kind: secret.kind,
      scope: secret.scope,
      displayName: secret.displayName,
      matchConfidence: confidence,
      intentRequired: secret.intentRequired,
      fieldKeys: [...secret.fieldKeys],
      fieldPolicies: secret.fieldPolicies ? { ...secret.fieldPolicies } : undefined,
    }));
}

function hasApplicableStoredSecretKind(
  catalog: SecretCatalogSnapshot,
  kind: StoredSecretKind
): boolean {
  return catalog.storedSecrets.some((secret) => secret.kind === kind);
}

const ORDERED_PROTECTED_KINDS: StoredSecretKind[] = ['login', 'identity', 'payment_card'];

function purposesByPriority(catalog: SecretCatalogSnapshot | null): StoredSecretKind[] {
  if (!catalog) {
    return ORDERED_PROTECTED_KINDS;
  }

  return ORDERED_PROTECTED_KINDS.filter((kind) => hasApplicableStoredSecretKind(catalog, kind));
}

async function planBindingsForGroup(
  getClient: (() => AgentbrowseAssistiveLlmClient | null) | null,
  kind: StoredSecretKind,
  plannerGroup: FormTargetGroup,
  fullGroup: FormTargetGroup
): Promise<{
  confidence: 'high' | 'medium' | 'low';
  fields: FillableFormFieldBinding[];
} | null> {
  if (kind === 'login') {
    const deterministicPlan = deterministicLoginPlan(plannerGroup, fullGroup);
    if (deterministicPlan) {
      return deterministicPlan;
    }
  }

  if (kind === 'payment_card') {
    const deterministicPlan = deterministicPaymentCardPlan(plannerGroup, fullGroup);
    if (deterministicPlan) {
      return deterministicPlan;
    }
  }

  if (kind === 'identity') {
    const deterministicPlan = deterministicIdentityPlan(plannerGroup, fullGroup);
    if (deterministicPlan) {
      return deterministicPlan;
    }
  }

  const client = getClient?.() ?? null;
  if (!client) {
    return null;
  }

  const result = await client.createChatCompletion<z.infer<typeof protectedFormPlanSchema>>({
    logger: () => {},
    options: {
      messages: [{ role: 'user', content: buildMatcherPrompt(kind, plannerGroup) }],
      response_model: {
        name: 'ProtectedFormPlan',
        schema: protectedFormPlanSchema,
      },
    },
  });

  return {
    confidence: result.data.confidence,
    fields:
      kind === 'payment_card'
        ? dropSuspiciousIframePaymentCardBindings(
            sanitizeBindings(kind, plannerGroup, result.data.bindings),
            fullGroup,
            new Map(fullGroup.targets.map((target) => [target.ref, target]))
          )
        : sanitizeBindings(kind, plannerGroup, result.data.bindings),
  };
}

function plannerGroupsForGroup(
  group: FormTargetGroup,
  catalog: SecretCatalogSnapshot | null
): PlannerGroupCandidate[] {
  const candidates: PlannerGroupCandidate[] = [];

  for (const kind of purposesByPriority(catalog)) {
    const plannerGroup = plannerGroupForKind(kind, group);
    if (!plannerGroup || plannerGroup.targets.length === 0) {
      continue;
    }
    candidates.push({ kind, plannerGroup });
  }

  return candidates;
}

export async function matchStoredSecretsToObservedTargets(
  pageRef: string,
  targets: ReadonlyArray<TargetDescriptor>,
  catalog: SecretCatalogSnapshot | null,
  options: MatcherOptions = {}
): Promise<FillableFormDraft[]> {
  let client: AgentbrowseAssistiveLlmClient | null | undefined;
  const getClient = (): AgentbrowseAssistiveLlmClient | null => {
    if (client !== undefined) {
      return client;
    }

    try {
      client = tryCreateAgentbrowseAssistiveLlmClient({ session: options.session });
    } catch {
      client = null;
    }

    return client;
  };
  const targetByRef = new Map(targets.map((target) => [target.ref, target]));
  const groups = groupTargetsByForm(targets);
  const nextObservedAt = options.observedAt ?? new Date().toISOString();
  const forms: FillableFormDraft[] = [];

  for (const group of groups) {
    for (const { kind, plannerGroup } of plannerGroupsForGroup(group, catalog)) {
      const planned = await planBindingsForGroup(
        catalog || kind === 'payment_card' ? getClient : null,
        kind,
        plannerGroup,
        group
      ).catch(() => null);
      if (!planned || planned.confidence === 'low') {
        continue;
      }

      if (!isCredibleKindMatch(kind, planned.fields)) {
        continue;
      }

      const matchedFieldKeys = new Set(planned.fields.map((field) => field.fieldKey));
      const storedSecretCandidates = catalog
        ? buildStoredSecretCandidates(catalog, kind, planned.confidence, matchedFieldKeys)
        : [];

      forms.push({
        pageRef,
        scopeRef: formScopeRef(planned.fields, targetByRef),
        purpose: kind,
        fields: planned.fields,
        storedSecretCandidates,
        observedAt: nextObservedAt,
      });
    }
  }

  return forms;
}

export const __testFormMatcher = {
  buildMatcherPrompt,
  formGroupKeyOf,
  groupTargetsByForm,
  sanitizeBindings,
  selectorSignalFragments,
  signalValuesOf,
};
