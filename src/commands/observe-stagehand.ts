import type { Page } from 'playwright-core';
import {
  inferAcceptancePolicyFromFacts,
  inferAllowedActionsFromFacts,
  inferAvailabilityFromFacts,
  inferControlFamilyFromFacts,
} from '../control-semantics.js';
import { buildLocator, resolveLocatorRoot } from './action-fallbacks.js';
import { buildObserveDisplayLabel, normalizeObserveLiveValue } from './observe-display-label.js';
import { normalizeStagehandSelector, readStagehandLocatorSnapshot } from './observe-inventory.js';

type StagehandObserveAction = {
  description?: string;
  selector?: string;
  method?: string;
  arguments?: unknown[];
};

export async function toStagehandDescriptor(
  pageRef: string,
  action: StagehandObserveAction,
  page: Page,
  pageSignature?: string
) {
  const normalizedSelector = normalizeStagehandSelector(
    typeof action.selector === 'string' ? action.selector.trim() : ''
  );
  const selector = normalizedSelector.selector;
  const locatorCandidates = selector
    ? [
        {
          strategy: selector.startsWith('xpath=') ? ('xpath' as const) : ('css' as const),
          value: selector,
          scope: 'root' as const,
        },
      ]
    : [];

  const stagehandLocator = selector
    ? buildLocator(resolveLocatorRoot(page, normalizedSelector.framePath), locatorCandidates[0]!)
    : null;
  const { domSignature, domFacts } = stagehandLocator
    ? await readStagehandLocatorSnapshot(stagehandLocator).catch(() => ({
        domSignature: null,
        domFacts: null,
      }))
    : {
        domSignature: null,
        domFacts: null,
      };
  const method = (action.method ?? '').trim().toLowerCase();
  const shadowOrUnsupported =
    method === 'not-supported' || /shadow dom|inside a shadow/i.test(action.description ?? '');
  const facts = {
    kind: domFacts?.kind ?? action.method,
    role: domFacts?.role,
    label: action.description ?? action.method,
    placeholder: domFacts?.placeholder,
    inputName: domFacts?.inputName,
    inputType: domFacts?.inputType,
    autocomplete: domFacts?.autocomplete,
    ariaAutocomplete: domFacts?.ariaAutocomplete,
    text: action.description ?? action.method,
    states: domFacts?.states,
    legacyMethod: method,
  };
  const allowedActions = inferAllowedActionsFromFacts(facts);
  const acceptancePolicy = inferAcceptancePolicyFromFacts(facts, allowedActions);
  const controlFamily = inferControlFamilyFromFacts(facts, allowedActions);
  const liveValue =
    normalizeObserveLiveValue(domFacts?.currentValue) ??
    normalizeObserveLiveValue(domFacts?.value) ??
    normalizeObserveLiveValue(domFacts?.text);
  const baseLabel = action.description ?? action.method ?? 'observed target';
  const displayLabel = buildObserveDisplayLabel(baseLabel, liveValue);
  const actionable =
    !shadowOrUnsupported && locatorCandidates.length > 0 && allowedActions.length > 0;
  const availability = inferAvailabilityFromFacts(domFacts?.states, undefined, {
    readonlyInteractive:
      controlFamily === 'select' ||
      controlFamily === 'datepicker' ||
      acceptancePolicy === 'selection' ||
      acceptancePolicy === 'date-selection',
  });

  return {
    pageRef,
    kind: domFacts?.kind ?? action.method,
    label: baseLabel,
    displayLabel,
    placeholder: domFacts?.placeholder,
    inputName: domFacts?.inputName,
    inputType: domFacts?.inputType,
    autocomplete: domFacts?.autocomplete,
    ariaAutocomplete: domFacts?.ariaAutocomplete,
    validation: undefined,
    capability: actionable ? ('actionable' as const) : ('informational' as const),
    lifecycle: 'live' as const,
    availability,
    allowedActions,
    controlFamily,
    acceptancePolicy,
    framePath: normalizedSelector.framePath,
    semantics: {
      name: action.description ?? action.method ?? 'observed target',
      role: domFacts?.role,
      states: domFacts?.states,
      source: 'stagehand' as const,
    },
    locatorCandidates,
    stagehandAction: action,
    createdAt: Date.now(),
    pageSignature,
    domSignature: domSignature ?? undefined,
  };
}

export const __testStagehandDescriptor = {
  toStagehandDescriptor,
  normalizeStagehandSelector,
  readStagehandLocatorSnapshot,
};
