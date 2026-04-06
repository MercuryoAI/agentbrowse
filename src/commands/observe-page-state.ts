import type { ObservedPageSignal } from './observe-signals.js';

export type ObservePageSignalLike = Pick<ObservedPageSignal, 'kind' | 'text'>;

export type ObservePagePhase =
  | 'interactive'
  | 'validation_error'
  | 'challenge'
  | 'processing'
  | 'terminal_success'
  | 'terminal_failure'
  | 'ambiguous';

export type ObservePageState = {
  phase: ObservePagePhase;
  confidence: 'low' | 'medium' | 'high';
  dominantSignal: ObservePageSignalLike | null;
};

const STRONG_SUCCESS_TEXT_RE =
  /(?:payment\s+(?:successful|received)|receipt\s+sent|thanks?\s+for\s+your\s+order|order\s+(?:confirmed|complete(?:d)?|successful)|purchase\s+(?:complete(?:d)?|successful))/i;
const STRONG_FAILURE_TEXT_RE =
  /(?:declin(?:e|ed)|fail(?:ed|ure)|unable\s+to|could\s+not|was\s+not\s+processed|not\s+completed)/i;
const CHALLENGE_TEXT_RE =
  /(?:verification|verify|challenge|captcha|authentication|3d\s*secure|3ds|secure\s+code)/i;
const PROCESSING_TEXT_RE = /(?:processing|pending|loading|checking|please\s+wait|working)/i;
const VALIDATION_TEXT_RE =
  /(?:please\s+(?:enter|select|choose|fill)|required|invalid|incorrect|missing|try again|needs?\b)/i;
const NON_TERMINAL_TEXT_RE =
  /(?:order summary|recent supporters?|supporters|review your order|verification required)/i;
const WEAK_SUCCESS_TEXT_RE =
  /(?:success(?:ful|fully)?|thank\s+you|thanks|confirmed|complete(?:d)?|receipt)/i;

const STRONG_TERMINAL_SIGNAL_KINDS = new Set<ObservePageSignalLike['kind']>(['dialog', 'alert']);

function normalizeSignalText(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function findSignal(
  signals: ReadonlyArray<ObservePageSignalLike>,
  predicate: (signal: ObservePageSignalLike) => boolean
): ObservePageSignalLike | null {
  for (const signal of signals) {
    if (predicate(signal)) {
      return signal;
    }
  }
  return null;
}

export function classifyObservePageState(
  signals: ReadonlyArray<ObservePageSignalLike>
): ObservePageState {
  const normalizedSignals = signals
    .map((signal) => ({
      kind: signal.kind,
      text: normalizeSignalText(signal.text),
    }))
    .filter((signal) => signal.text.length > 0);

  const strongSuccess = findSignal(
    normalizedSignals,
    (signal) =>
      STRONG_TERMINAL_SIGNAL_KINDS.has(signal.kind) &&
      STRONG_SUCCESS_TEXT_RE.test(signal.text) &&
      !NON_TERMINAL_TEXT_RE.test(signal.text)
  );
  if (strongSuccess) {
    return {
      phase: 'terminal_success',
      confidence: 'high',
      dominantSignal: strongSuccess,
    };
  }

  const strongFailure = findSignal(
    normalizedSignals,
    (signal) =>
      STRONG_TERMINAL_SIGNAL_KINDS.has(signal.kind) &&
      STRONG_FAILURE_TEXT_RE.test(signal.text) &&
      !CHALLENGE_TEXT_RE.test(signal.text)
  );
  if (strongFailure) {
    return {
      phase: 'terminal_failure',
      confidence: 'high',
      dominantSignal: strongFailure,
    };
  }

  const validation = findSignal(
    normalizedSignals,
    (signal) =>
      VALIDATION_TEXT_RE.test(signal.text) &&
      !STRONG_SUCCESS_TEXT_RE.test(signal.text) &&
      !CHALLENGE_TEXT_RE.test(signal.text)
  );
  if (validation) {
    return {
      phase: 'validation_error',
      confidence: validation.kind === 'alert' ? 'high' : 'medium',
      dominantSignal: validation,
    };
  }

  const challenge = findSignal(normalizedSignals, (signal) => CHALLENGE_TEXT_RE.test(signal.text));
  if (challenge) {
    return {
      phase: 'challenge',
      confidence: challenge.kind === 'dialog' || challenge.kind === 'alert' ? 'high' : 'medium',
      dominantSignal: challenge,
    };
  }

  const processing = findSignal(normalizedSignals, (signal) =>
    PROCESSING_TEXT_RE.test(signal.text)
  );
  if (processing) {
    return {
      phase: 'processing',
      confidence: processing.kind === 'status' ? 'high' : 'medium',
      dominantSignal: processing,
    };
  }

  const weakSuccess = findSignal(
    normalizedSignals,
    (signal) => WEAK_SUCCESS_TEXT_RE.test(signal.text) && !NON_TERMINAL_TEXT_RE.test(signal.text)
  );
  if (weakSuccess) {
    return {
      phase: 'ambiguous',
      confidence: 'low',
      dominantSignal: weakSuccess,
    };
  }

  return {
    phase: 'interactive',
    confidence: 'low',
    dominantSignal: null,
  };
}

export function shouldSuppressFillableFormsForObserve(state: ObservePageState): boolean {
  return state.phase === 'terminal_success' && state.confidence === 'high';
}
