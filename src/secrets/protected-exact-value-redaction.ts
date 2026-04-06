import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BrowserSessionState } from '../browser-session-state.js';
import type { ProtectedExactValueProfile, ProtectedExactValueRule } from '../runtime-state.js';
import type { StoredSecretFieldKey } from './types.js';

const INLINE_REDACTION_KEY_ENV = 'AGENTBROWSE_PROTECTED_REDACTION_KEY';
const REDACTION_KEY_PATH_ENV = 'AGENTBROWSE_PROTECTED_REDACTION_KEY_PATH';
const DEFAULT_REDACTION_KEY_FILENAME = 'protected-redaction.key';
const EMAIL_VALUE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DIGITS_WITH_COMMON_SEPARATORS_RE = /^[\d\s()+./-]+$/;
const EMAIL_FRAGMENT_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const EXPIRY_FRAGMENT_RE = /\b\d{1,2}\s*\/\s*(?:\d{2}|\d{4})\b/gu;
const REDACTED_TOKEN = '[redacted]';

let cachedPersistedRedactionKey: string | null = null;

function getDefaultRedactionKeyPath(): string {
  return join(homedir(), '.agentbrowse', DEFAULT_REDACTION_KEY_FILENAME);
}

function resolvePersistedRedactionKeyPath(): string {
  const configuredPath = process.env[REDACTION_KEY_PATH_ENV]?.trim();
  return configuredPath && configuredPath.length > 0
    ? configuredPath
    : getDefaultRedactionKeyPath();
}

function loadOrCreatePersistedRedactionKey(): string {
  if (cachedPersistedRedactionKey) {
    return cachedPersistedRedactionKey;
  }

  const keyPath = resolvePersistedRedactionKeyPath();
  if (existsSync(keyPath)) {
    const existing = readFileSync(keyPath, 'utf-8').trim();
    if (existing.length > 0) {
      cachedPersistedRedactionKey = existing;
      return existing;
    }
  }

  mkdirSync(join(keyPath, '..'), { recursive: true });
  const created = randomBytes(32).toString('hex');
  writeFileSync(keyPath, `${created}\n`, { mode: 0o600 });
  cachedPersistedRedactionKey = created;
  return created;
}

function resolveRedactionKey(): string {
  const inlineKey = process.env[INLINE_REDACTION_KEY_ENV]?.trim();
  if (inlineKey && inlineKey.length > 0) {
    return inlineKey;
  }

  return loadOrCreatePersistedRedactionKey();
}

export function createProtectedRedactionDigest(value: string): string {
  return createHmac('sha256', resolveRedactionKey()).update(value).digest('hex');
}

export function normalizeRedactionText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

export function normalizeRedactionDigits(value: string): string {
  return value.replace(/\D+/g, '');
}

export function normalizeRedactionEmail(value: string): string {
  return normalizeRedactionText(value).toLowerCase();
}

export function normalizeRedactionExpiryCandidate(value: string): string | null {
  const match = /^\s*(\d{1,2})\s*\/\s*(\d{2}|\d{4})\s*$/u.exec(value);
  if (!match) {
    return null;
  }

  const month = match[1]?.padStart(2, '0');
  const year = match[2];
  if (!month || !year) {
    return null;
  }

  return `${month}/${year}`;
}

function buildRule(
  matcher: ProtectedExactValueRule['matcher'],
  normalizedValue: string
): ProtectedExactValueRule | null {
  if (normalizedValue.length === 0) {
    return null;
  }

  return {
    matcher,
    digest: createProtectedRedactionDigest(normalizedValue),
    normalizedLength: normalizedValue.length,
  };
}

function addRule(
  rules: ProtectedExactValueRule[],
  matcher: ProtectedExactValueRule['matcher'],
  normalizedValue: string
): void {
  const rule = buildRule(matcher, normalizedValue);
  if (!rule) {
    return;
  }

  const key = JSON.stringify([rule.matcher, rule.digest, rule.normalizedLength]);
  if (
    rules.some((candidate) => {
      const candidateKey = JSON.stringify([
        candidate.matcher,
        candidate.digest,
        candidate.normalizedLength,
      ]);
      return candidateKey === key;
    })
  ) {
    return;
  }

  rules.push(rule);
}

function canPromoteTextValueToGlobalRule(
  fieldKey: StoredSecretFieldKey,
  normalizedValue: string
): boolean {
  if (fieldKey === 'cvv' || fieldKey === 'exp_month' || fieldKey === 'exp_year') {
    return false;
  }

  return normalizedValue.length >= 6 || /[\s@._:/\\-]/u.test(normalizedValue);
}

function addGlobalRulesForField(
  rules: ProtectedExactValueRule[],
  fieldKey: StoredSecretFieldKey,
  rawValue: string
): void {
  const normalizedText = normalizeRedactionText(rawValue);
  if (normalizedText.length === 0) {
    return;
  }

  if (fieldKey === 'pan') {
    const digits = normalizeRedactionDigits(rawValue);
    if (digits.length >= 13) {
      addRule(rules, 'digits', digits);
    }
    return;
  }

  if (EMAIL_VALUE_RE.test(normalizedText)) {
    addRule(rules, 'email', normalizeRedactionEmail(normalizedText));
    return;
  }

  const digits = normalizeRedactionDigits(rawValue);
  if (
    DIGITS_WITH_COMMON_SEPARATORS_RE.test(rawValue) &&
    digits.length >= 6 &&
    fieldKey !== 'cvv' &&
    fieldKey !== 'exp_month' &&
    fieldKey !== 'exp_year'
  ) {
    addRule(rules, 'digits', digits);
    return;
  }

  if (canPromoteTextValueToGlobalRule(fieldKey, normalizedText)) {
    addRule(rules, 'text', normalizedText);
  }
}

function formatCardExpiry(month: string, year: string): string {
  const normalizedMonth = month.trim().padStart(2, '0');
  const trimmedYear = year.trim();
  const shortYear = trimmedYear.length > 2 ? trimmedYear.slice(-2) : trimmedYear.padStart(2, '0');
  return `${normalizedMonth}/${shortYear}`;
}

function formatCardExpiryFullYear(month: string, year: string): string | null {
  const normalizedMonth = month.trim().padStart(2, '0');
  const trimmedYear = year.trim();
  if (trimmedYear.length === 4) {
    return `${normalizedMonth}/${trimmedYear}`;
  }
  return null;
}

export function buildProtectedExactValueProfile(
  protectedValues: Partial<Record<StoredSecretFieldKey, string>>
): ProtectedExactValueProfile {
  const rules: ProtectedExactValueRule[] = [];

  for (const [fieldKey, rawValue] of Object.entries(protectedValues)) {
    if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
      continue;
    }

    addGlobalRulesForField(rules, fieldKey as StoredSecretFieldKey, rawValue);
  }

  const expMonth = protectedValues.exp_month;
  const expYear = protectedValues.exp_year;
  if (
    typeof expMonth === 'string' &&
    expMonth.trim().length > 0 &&
    typeof expYear === 'string' &&
    expYear.trim().length > 0
  ) {
    addRule(rules, 'expiry', formatCardExpiry(expMonth, expYear));
    const fullYearVariant = formatCardExpiryFullYear(expMonth, expYear);
    if (fullYearVariant) {
      addRule(rules, 'expiry', fullYearVariant);
    }
  }

  return {
    version: 1,
    rules,
  };
}

function listSpanBoundaries(value: string): { starts: number[]; ends: number[] } {
  const starts: number[] = [];
  const ends: number[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const isWord = Boolean(char && /[\p{L}\p{N}]/u.test(char));
    if (!isWord) {
      continue;
    }

    const previousChar = value[index - 1];
    const nextChar = value[index + 1];
    if (!previousChar || !/[\p{L}\p{N}]/u.test(previousChar)) {
      starts.push(index);
    }
    if (!nextChar || !/[\p{L}\p{N}]/u.test(nextChar)) {
      ends.push(index + 1);
    }
  }

  return { starts, ends };
}

function replaceRanges(value: string, replacements: Array<{ start: number; end: number }>): string {
  if (replacements.length === 0) {
    return value;
  }

  const deduped = replacements
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .filter((range, index, ranges) => {
      const previous = ranges[index - 1];
      return !previous || previous.start !== range.start || previous.end !== range.end;
    });

  let output = value;
  for (let index = deduped.length - 1; index >= 0; index -= 1) {
    const range = deduped[index]!;
    output = `${output.slice(0, range.start)}${REDACTED_TOKEN}${output.slice(range.end)}`;
  }

  return output;
}

function applyTextRule(value: string, rule: ProtectedExactValueRule): string {
  const boundaries = listSpanBoundaries(value);
  if (boundaries.starts.length === 0 || boundaries.ends.length === 0) {
    return value;
  }

  const replacements: Array<{ start: number; end: number }> = [];
  for (const start of boundaries.starts) {
    for (const end of boundaries.ends) {
      if (end <= start) {
        continue;
      }

      const candidate = normalizeRedactionText(value.slice(start, end));
      if (candidate.length === 0) {
        continue;
      }
      if (candidate.length > rule.normalizedLength) {
        break;
      }
      if (candidate.length !== rule.normalizedLength) {
        continue;
      }

      if (createProtectedRedactionDigest(candidate) === rule.digest) {
        replacements.push({ start, end });
        break;
      }
    }
  }

  return replaceRanges(value, replacements);
}

function applyDigitsRule(value: string, rule: ProtectedExactValueRule): string {
  const replacements: Array<{ start: number; end: number }> = [];
  const digitRunRe = /\d(?:[\d\s()./+:-]*\d)?/gu;
  for (const match of value.matchAll(digitRunRe)) {
    const candidate = match[0];
    if (!candidate) {
      continue;
    }

    const normalizedDigits = normalizeRedactionDigits(candidate);
    if (normalizedDigits.length !== rule.normalizedLength) {
      continue;
    }
    if (createProtectedRedactionDigest(normalizedDigits) !== rule.digest) {
      continue;
    }

    const start = match.index ?? -1;
    if (start < 0) {
      continue;
    }
    replacements.push({ start, end: start + candidate.length });
  }

  return replaceRanges(value, replacements);
}

function applyEmailRule(value: string, rule: ProtectedExactValueRule): string {
  const replacements: Array<{ start: number; end: number }> = [];
  for (const match of value.matchAll(EMAIL_FRAGMENT_RE)) {
    const candidate = match[0];
    if (!candidate) {
      continue;
    }

    const normalizedEmail = normalizeRedactionEmail(candidate);
    if (normalizedEmail.length !== rule.normalizedLength) {
      continue;
    }
    if (createProtectedRedactionDigest(normalizedEmail) !== rule.digest) {
      continue;
    }

    const start = match.index ?? -1;
    if (start < 0) {
      continue;
    }
    replacements.push({ start, end: start + candidate.length });
  }

  return replaceRanges(value, replacements);
}

function applyExpiryRule(value: string, rule: ProtectedExactValueRule): string {
  const replacements: Array<{ start: number; end: number }> = [];
  for (const match of value.matchAll(EXPIRY_FRAGMENT_RE)) {
    const candidate = match[0];
    if (!candidate) {
      continue;
    }

    const normalizedExpiry = normalizeRedactionExpiryCandidate(candidate);
    if (!normalizedExpiry || normalizedExpiry.length !== rule.normalizedLength) {
      continue;
    }
    if (createProtectedRedactionDigest(normalizedExpiry) !== rule.digest) {
      continue;
    }

    const start = match.index ?? -1;
    if (start < 0) {
      continue;
    }
    replacements.push({ start, end: start + candidate.length });
  }

  return replaceRanges(value, replacements);
}

function applyRule(value: string, rule: ProtectedExactValueRule): string {
  if (value.length === 0) {
    return value;
  }

  if (rule.matcher === 'text') {
    return applyTextRule(value, rule);
  }
  if (rule.matcher === 'digits') {
    return applyDigitsRule(value, rule);
  }
  if (rule.matcher === 'email') {
    return applyEmailRule(value, rule);
  }
  return applyExpiryRule(value, rule);
}

function activeExactValueRules(session: BrowserSessionState): ProtectedExactValueRule[] {
  const rules = new Map<string, ProtectedExactValueRule>();
  for (const exposure of Object.values(session.runtime?.protectedExposureByPage ?? {})) {
    for (const rule of exposure.exactValueProfile?.rules ?? []) {
      const key = JSON.stringify([rule.matcher, rule.digest, rule.normalizedLength]);
      rules.set(key, rule);
    }
  }

  return [...rules.values()];
}

function scrubOutputValue<T>(value: T, rules: ReadonlyArray<ProtectedExactValueRule>): T {
  if (typeof value === 'string') {
    let scrubbed: string = value;
    for (const rule of rules) {
      scrubbed = applyRule(scrubbed, rule);
    }
    return scrubbed as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => scrubOutputValue(entry, rules)) as T;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const nextRecord: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    nextRecord[key] = scrubOutputValue(entry, rules);
  }

  return nextRecord as T;
}

export function scrubProtectedExactValues<T>(session: BrowserSessionState, payload: T): T {
  const rules = activeExactValueRules(session);
  if (rules.length === 0) {
    return payload;
  }

  return scrubOutputValue(payload, rules);
}

export const __testProtectedExactValueRedaction = {
  REDACTED_TOKEN,
};
