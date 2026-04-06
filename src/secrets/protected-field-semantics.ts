import { inferComparableValueTypeFromFacts } from '../control-semantics.js';
import type { TargetDescriptor } from '../runtime-state.js';
import type { ProtectedBindingValueHint, StoredSecretFieldKey, StoredSecretKind } from './types.js';

export interface ProtectedFieldMeaningHint {
  kind: StoredSecretKind;
  fieldKey: StoredSecretFieldKey;
  valueHint: ProtectedBindingValueHint;
}

const LOGIN_USERNAME_SIGNAL_RE =
  /\b(email|e-mail|username|user name|login|account(?: email| name)?|member(?: email| name| id)?)\b/i;
const LOGIN_PASSWORD_SIGNAL_RE = /\b(password|passcode|pass word)\b/i;

const PAYMENT_CARD_NAME_SIGNAL_RE =
  /\b(cardholder|card holder|name on card|cardholder name|full name)\b/i;
const PAYMENT_CARD_PAN_SIGNAL_RE = /\b(card number|card no|cc-number|cc number)\b/i;
const PAYMENT_CARD_EXP_SIGNAL_RE =
  /\b(expiration|expiry|exp(?:iry)? date|exp date|mm\s*\/\s*yy|mmyy|mm\/yy)\b/i;
const PAYMENT_CARD_CVV_SIGNAL_RE = /\b(security code|cvv|cvc)\b/i;

const IDENTITY_DOCUMENT_SIGNAL_RE =
  /\b(passport|document(?: number| no)?|id(?: number| no)?|identity(?: number)?)\b/i;
const IDENTITY_BIRTH_SIGNAL_RE = /\b(date of birth|birth date|dob)\b/i;
const IDENTITY_NATIONALITY_SIGNAL_RE = /\b(nationality|citizenship)\b/i;
const IDENTITY_ISSUING_COUNTRY_SIGNAL_RE =
  /\b(issuing country|country of issue|country\/region of issue|issuing state)\b/i;
const IDENTITY_ISSUE_DATE_SIGNAL_RE = /\b(issue date|date of issue)\b/i;
const IDENTITY_EXPIRY_DATE_SIGNAL_RE = /\b(expiry date|expiration date|date of expiry)\b/i;

function normalizeText(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
}

function directFieldSignals(target: TargetDescriptor): string[] {
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

function uniqueMeaningHints(
  hints: ReadonlyArray<ProtectedFieldMeaningHint>
): ProtectedFieldMeaningHint[] {
  const seen = new Set<string>();
  const result: ProtectedFieldMeaningHint[] = [];

  for (const hint of hints) {
    const key = `${hint.kind}:${hint.fieldKey}:${hint.valueHint}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(hint);
  }

  return result;
}

export function inferProtectedFieldMeaningFromTarget(
  target: TargetDescriptor
): ProtectedFieldMeaningHint[] {
  const autocomplete = normalizeText(target.autocomplete);
  const inputType = normalizeText(target.inputType);
  const inputName = normalizeText(target.inputName);
  const signals = directFieldSignals(target);
  const comparableValueType = inferComparableValueTypeFromFacts({
    kind: target.kind,
    role: target.semantics?.role,
    label: target.label,
    displayLabel: target.displayLabel,
    placeholder: target.placeholder,
    inputName: target.inputName,
    inputType: target.inputType,
    autocomplete: target.autocomplete,
    states: target.semantics?.states,
    structure: target.structure,
  });
  const hints: ProtectedFieldMeaningHint[] = [];

  if (
    autocomplete.includes('username') ||
    autocomplete.includes('email') ||
    inputType === 'email' ||
    /\b(user(name)?|login|email|account)\b/.test(inputName) ||
    signals.some((signal) => LOGIN_USERNAME_SIGNAL_RE.test(signal))
  ) {
    hints.push({ kind: 'login', fieldKey: 'username', valueHint: 'direct' });
  }

  if (
    autocomplete.includes('current-password') ||
    inputType === 'password' ||
    /\bpassword\b/.test(inputName) ||
    signals.some((signal) => LOGIN_PASSWORD_SIGNAL_RE.test(signal))
  ) {
    hints.push({ kind: 'login', fieldKey: 'password', valueHint: 'direct' });
  }

  if (autocomplete.includes('cc-number') || comparableValueType === 'card-number') {
    hints.push({ kind: 'payment_card', fieldKey: 'pan', valueHint: 'direct' });
  } else if (
    /\b(card[-_ ]?number|cardnumber|cc-?number)\b/.test(inputName) ||
    signals.some((signal) => PAYMENT_CARD_PAN_SIGNAL_RE.test(signal))
  ) {
    hints.push({ kind: 'payment_card', fieldKey: 'pan', valueHint: 'direct' });
  }

  if (autocomplete.includes('cc-exp') || comparableValueType === 'expiry') {
    hints.push({ kind: 'payment_card', fieldKey: 'exp_month', valueHint: 'direct' });
    hints.push({ kind: 'payment_card', fieldKey: 'exp_year', valueHint: 'direct' });
  } else if (
    /\b(exp|expiry|expiration)\b/.test(inputName) ||
    signals.some((signal) => PAYMENT_CARD_EXP_SIGNAL_RE.test(signal))
  ) {
    hints.push({ kind: 'payment_card', fieldKey: 'exp_month', valueHint: 'direct' });
    hints.push({ kind: 'payment_card', fieldKey: 'exp_year', valueHint: 'direct' });
  }

  if (autocomplete.includes('cc-csc') || comparableValueType === 'cvc') {
    hints.push({ kind: 'payment_card', fieldKey: 'cvv', valueHint: 'direct' });
  } else if (
    /\b(cvv|cvc|security)\b/.test(inputName) ||
    signals.some((signal) => PAYMENT_CARD_CVV_SIGNAL_RE.test(signal))
  ) {
    hints.push({ kind: 'payment_card', fieldKey: 'cvv', valueHint: 'direct' });
  }

  if (
    autocomplete.includes('cc-name') ||
    /\b(cardholder|card-holder|cc-name)\b/.test(inputName) ||
    signals.some((signal) => PAYMENT_CARD_NAME_SIGNAL_RE.test(signal))
  ) {
    hints.push({ kind: 'payment_card', fieldKey: 'cardholder', valueHint: 'direct' });
  }

  if (autocomplete.includes('given-name')) {
    hints.push({ kind: 'identity', fieldKey: 'full_name', valueHint: 'full_name.given' });
  }

  if (autocomplete.includes('family-name')) {
    hints.push({ kind: 'identity', fieldKey: 'full_name', valueHint: 'full_name.family' });
  }

  if (
    autocomplete === 'name' ||
    /\bfull_?name\b/.test(inputName) ||
    signals.some((signal) => /\bfull name\b/.test(signal))
  ) {
    hints.push({ kind: 'identity', fieldKey: 'full_name', valueHint: 'direct' });
  }

  if (
    /\b(first|given|forename)_?name\b/.test(inputName) ||
    signals.some((signal) => /\b(first name|given name|forename)\b/.test(signal))
  ) {
    hints.push({ kind: 'identity', fieldKey: 'full_name', valueHint: 'full_name.given' });
  }

  if (
    /\b(last|family|surname)_?name\b/.test(inputName) ||
    signals.some((signal) => /\b(last name|family name|surname)\b/.test(signal))
  ) {
    hints.push({ kind: 'identity', fieldKey: 'full_name', valueHint: 'full_name.family' });
  }

  if (
    autocomplete.includes('bday') ||
    (comparableValueType === 'date' &&
      (/\b(date_?of_?birth|birth_?date|dob)\b/.test(inputName) ||
        signals.some((signal) => IDENTITY_BIRTH_SIGNAL_RE.test(signal))))
  ) {
    hints.push({ kind: 'identity', fieldKey: 'date_of_birth', valueHint: 'direct' });
  }

  if (
    /\b(passport|document|identity|id)(?:_?number|_?no)?\b/.test(inputName) ||
    signals.some((signal) => IDENTITY_DOCUMENT_SIGNAL_RE.test(signal))
  ) {
    hints.push({ kind: 'identity', fieldKey: 'document_number', valueHint: 'direct' });
  }

  if (
    /\b(nationality|citizenship)\b/.test(inputName) ||
    signals.some((signal) => IDENTITY_NATIONALITY_SIGNAL_RE.test(signal))
  ) {
    hints.push({ kind: 'identity', fieldKey: 'nationality', valueHint: 'direct' });
  }

  if (
    /\b(issuing_?country|country_?of_?issue|issuing_?state)\b/.test(inputName) ||
    signals.some((signal) => IDENTITY_ISSUING_COUNTRY_SIGNAL_RE.test(signal))
  ) {
    hints.push({ kind: 'identity', fieldKey: 'issuing_country', valueHint: 'direct' });
  }

  if (
    comparableValueType === 'date' &&
    (/\b(issue(?:_?date)?)\b/.test(inputName) ||
      signals.some((signal) => IDENTITY_ISSUE_DATE_SIGNAL_RE.test(signal)))
  ) {
    hints.push({ kind: 'identity', fieldKey: 'issue_date', valueHint: 'direct' });
  }

  if (
    comparableValueType === 'date' &&
    (/\b(expiry|expiration)(?:_?date)?\b/.test(inputName) ||
      signals.some((signal) => IDENTITY_EXPIRY_DATE_SIGNAL_RE.test(signal)))
  ) {
    hints.push({ kind: 'identity', fieldKey: 'expiry_date', valueHint: 'direct' });
  }

  return uniqueMeaningHints(hints);
}
