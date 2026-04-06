import type {
  TargetAcceptancePolicy,
  TargetAllowedAction,
  TargetAvailabilityState,
  TargetCapability,
  TargetContext,
} from '../runtime-state.js';
import {
  inferAcceptancePolicyFromFacts,
  inferAllowedActionsFromFacts,
  inferAvailabilityFromFacts,
  inferControlFamilyFromFacts,
} from '../control-semantics.js';
import type { DomObservedTarget } from './observe-inventory.js';
import { buildSurfaceRef, buildSyntheticFormSurfaceId } from './observe-surfaces.js';

export function normalizeSemanticDuplicateLabel(target: DomObservedTarget): string {
  return (
    target.displayLabel ??
    target.label ??
    target.text ??
    target.placeholder ??
    target.title ??
    ''
  )
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function isPrimaryFormControlTarget(target: DomObservedTarget): boolean {
  const kind = (target.kind ?? '').trim().toLowerCase();
  const role = (target.role ?? '').trim().toLowerCase();
  const acceptancePolicy = (target.acceptancePolicy ?? '').trim().toLowerCase();

  if (target.allowedActions?.includes('fill') || target.allowedActions?.includes('type')) {
    return true;
  }
  if (target.allowedActions?.includes('select')) {
    return true;
  }
  if (acceptancePolicy === 'submit' || acceptancePolicy === 'date-selection') {
    return true;
  }
  if (
    acceptancePolicy === 'disclosure' &&
    Boolean(formGroupingKeyOf(target)) &&
    (kind === 'button' || role === 'button')
  ) {
    return true;
  }

  return (
    kind === 'input' ||
    kind === 'textarea' ||
    kind === 'select' ||
    role === 'textbox' ||
    role === 'combobox'
  );
}

function semanticFormContextKey(context: TargetContext | undefined): string | undefined {
  for (const node of [context?.landmark, context?.container, context?.group, context?.item]) {
    const kind = (node?.kind ?? '').trim().toLowerCase();
    if (kind !== 'form') {
      continue;
    }

    const label = (node?.label ?? node?.text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    return `${kind}|${label}`;
  }

  return undefined;
}

export function formGroupingKeyOf(target: DomObservedTarget): string | undefined {
  const formSelector = target.formSelector?.trim();
  if (formSelector) {
    return `selector:${formSelector}`;
  }

  const contextKey = semanticFormContextKey(target.context);
  return contextKey ? `context:${contextKey}` : undefined;
}

export function observedTargetKey(target: DomObservedTarget): string {
  return (
    target.selector ??
    target.domSignature ??
    `${target.formSelector ?? 'no-form'}|${target.ordinal ?? 'no-ordinal'}|${target.label ?? ''}`
  );
}

type EmbeddedControlSurfaceSeed = {
  clusterKey: string;
  surfaceRef: string;
  surfaceKind: string;
  surfaceLabel: string;
  surfaceSelector: string;
  surfacePriority: number;
};

function normalizeEmbeddedSurfaceText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
}

function embeddedSurfaceFrameKeyOf(target: DomObservedTarget): string {
  if (target.framePath?.length) {
    return target.framePath.join('>');
  }

  const frameUrl = normalizeEmbeddedSurfaceText(target.frameUrl);
  return frameUrl ? `url:${frameUrl}` : 'top';
}

function compactEmbeddedSurfaceLabel(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = normalizeEmbeddedSurfaceText(value);
    if (normalized && normalized.length <= 80) {
      return normalized;
    }
  }

  return undefined;
}

function isEmbeddedInteractiveControl(target: DomObservedTarget): boolean {
  if ((target.surfaceRef ?? '').trim().length > 0) {
    return false;
  }

  const allowedActions = target.allowedActions ?? [];
  if (allowedActions.length === 0) {
    return false;
  }

  const kind = (target.kind ?? '').trim().toLowerCase();
  const role = (target.role ?? '').trim().toLowerCase();
  if (kind === 'link' || role === 'link') {
    return false;
  }

  if (
    allowedActions.includes('fill') ||
    allowedActions.includes('type') ||
    allowedActions.includes('select')
  ) {
    return true;
  }

  return (
    kind === 'button' ||
    kind === 'radio' ||
    kind === 'checkbox' ||
    kind === 'input' ||
    kind === 'select' ||
    kind === 'textarea' ||
    role === 'button' ||
    role === 'radio' ||
    role === 'checkbox' ||
    role === 'textbox' ||
    role === 'combobox'
  );
}

function embeddedSurfaceSeedOf(target: DomObservedTarget): EmbeddedControlSurfaceSeed | undefined {
  if (!isEmbeddedInteractiveControl(target)) {
    return undefined;
  }

  const selectorCandidates = [
    {
      selector: normalizeEmbeddedSurfaceText(target.context?.group?.selector),
      kind: normalizeEmbeddedSurfaceText(target.context?.group?.kind)?.toLowerCase(),
      label: compactEmbeddedSurfaceLabel(
        target.context?.group?.label,
        target.context?.landmark?.label,
        target.context?.container?.label,
        target.context?.hintText
      ),
    },
    {
      selector: normalizeEmbeddedSurfaceText(target.context?.container?.selector),
      kind: normalizeEmbeddedSurfaceText(target.context?.container?.kind)?.toLowerCase(),
      label: compactEmbeddedSurfaceLabel(
        target.context?.container?.label,
        target.context?.landmark?.label,
        target.context?.hintText
      ),
    },
  ];

  const surfaceSeed = selectorCandidates.find((candidate) => candidate.selector);
  if (!surfaceSeed?.selector) {
    return undefined;
  }

  const pageKey = normalizeEmbeddedSurfaceText(target.pageSignature) ?? 'unknown-page';
  const frameKey = embeddedSurfaceFrameKeyOf(target);
  const surfaceKind =
    surfaceSeed.kind && !['div', 'tbody', 'table', 'tr', 'td', 'span'].includes(surfaceSeed.kind)
      ? surfaceSeed.kind
      : 'group';

  return {
    clusterKey: `${pageKey}|${frameKey}|${surfaceSeed.selector}`,
    surfaceRef: `${pageKey}|${frameKey}|embedded|${surfaceSeed.selector}`,
    surfaceKind,
    surfaceLabel: surfaceSeed.label ?? 'Embedded controls',
    surfaceSelector: surfaceSeed.selector,
    surfacePriority: 56,
  };
}

function materializeEmbeddedControlSurfaces(
  targets: ReadonlyArray<DomObservedTarget>
): DomObservedTarget[] {
  const clusterCounts = new Map<string, number>();
  const seedsByIndex = new Map<number, EmbeddedControlSurfaceSeed>();

  for (const [index, target] of targets.entries()) {
    const seed = embeddedSurfaceSeedOf(target);
    if (!seed) {
      continue;
    }

    seedsByIndex.set(index, seed);
    clusterCounts.set(seed.clusterKey, (clusterCounts.get(seed.clusterKey) ?? 0) + 1);
  }

  return targets.map((target, index) => {
    const seed = seedsByIndex.get(index);
    if (!seed || (clusterCounts.get(seed.clusterKey) ?? 0) < 2) {
      return target;
    }

    return {
      ...target,
      surfaceRef: target.surfaceRef ?? seed.surfaceRef,
      surfaceKind: target.surfaceKind ?? seed.surfaceKind,
      surfaceLabel: target.surfaceLabel ?? seed.surfaceLabel,
      surfaceSelector: target.surfaceSelector ?? seed.surfaceSelector,
      surfacePriority: target.surfacePriority ?? seed.surfacePriority,
    };
  });
}

function parseNumericAmount(value: string): number | null {
  const normalized = value.replace(/,/g, '.').trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseGoalAmount(instruction: string): number | null {
  const normalized = instruction.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const currencyPattern =
    /\b(\d+(?:[.,]\d+)?)\s*(?:usd|us dollars?|united states dollars?|dollars?)\b|\$(\d+(?:[.,]\d+)?)/i;
  const match = normalized.match(currencyPattern);
  if (!match) {
    return null;
  }

  return parseNumericAmount(match[1] ?? match[2] ?? '');
}

function goalLooksLikePurchaseStart(instruction: string): boolean {
  return /\b(start|buy|support|purchase|pay|checkout|donat(?:e|ion))\b/i.test(instruction);
}

function targetLabelAmount(target: DomObservedTarget): number | null {
  const candidates = [
    target.label,
    target.displayLabel,
    target.text,
    target.placeholder,
    target.title,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const candidate of candidates) {
    const currencyMatch = candidate.match(
      /\b(\d+(?:[.,]\d+)?)\s*(?:usd|us dollars?|united states dollars?|dollars?)\b|\$(\d+(?:[.,]\d+)?)/i
    );
    if (currencyMatch) {
      return parseNumericAmount(currencyMatch[1] ?? currencyMatch[2] ?? '');
    }

    const exactNumeric = parseNumericAmount(candidate);
    if (exactNumeric !== null) {
      return exactNumeric;
    }
  }

  return null;
}

function isExactAmountSubmitTarget(target: DomObservedTarget, amount: number): boolean {
  const acceptancePolicy = (target.acceptancePolicy ?? '').trim().toLowerCase();
  const labelAmount = targetLabelAmount(target);
  if (labelAmount !== amount) {
    return false;
  }

  if (acceptancePolicy === 'submit') {
    return true;
  }

  const label = `${target.label ?? ''} ${target.displayLabel ?? ''}`.toLowerCase();
  return /\b(support|pay|buy|checkout|donate)\b/.test(label);
}

function isExactAmountSelectionTarget(target: DomObservedTarget, amount: number): boolean {
  const acceptancePolicy = (target.acceptancePolicy ?? '').trim().toLowerCase();
  const inputType = (target.inputType ?? '').trim().toLowerCase();
  return (
    targetLabelAmount(target) === amount &&
    (acceptancePolicy === 'selection' || inputType === 'radio')
  );
}

export function prioritizeGoalActionTargets(
  instruction: string,
  selectedTargets: ReadonlyArray<DomObservedTarget>
): DomObservedTarget[] {
  const goalAmount = parseGoalAmount(instruction);
  if (goalAmount === null || !goalLooksLikePurchaseStart(instruction)) {
    return [...selectedTargets];
  }

  const hasExactSubmit = selectedTargets.some((target) =>
    isExactAmountSubmitTarget(target, goalAmount)
  );
  if (!hasExactSubmit) {
    return [...selectedTargets];
  }

  return [...selectedTargets]
    .map((target, index) => ({ target, index }))
    .sort((left, right) => {
      const leftIsSubmit = isExactAmountSubmitTarget(left.target, goalAmount);
      const rightIsSubmit = isExactAmountSubmitTarget(right.target, goalAmount);
      if (leftIsSubmit !== rightIsSubmit) {
        return leftIsSubmit ? -1 : 1;
      }

      const leftIsSelection = isExactAmountSelectionTarget(left.target, goalAmount);
      const rightIsSelection = isExactAmountSelectionTarget(right.target, goalAmount);
      if (leftIsSelection !== rightIsSelection) {
        return leftIsSelection ? 1 : -1;
      }

      return left.index - right.index;
    })
    .map(({ target }) => target);
}

function semanticCompressionKey(target: DomObservedTarget): string | null {
  const band = target.context?.layout?.band;
  if (band !== 'bottom') {
    return null;
  }

  const kind = (target.kind ?? '').trim().toLowerCase();
  if (kind !== 'link' && kind !== 'button') {
    return null;
  }

  const label = normalizeSemanticDuplicateLabel(target);
  if (!label) {
    return null;
  }

  return `${kind}|${label}`;
}

export function compressSemanticallyDuplicateTargets(
  targets: ReadonlyArray<DomObservedTarget>
): DomObservedTarget[] {
  const repeatedKeys = new Map<string, number>();

  for (const target of targets) {
    const key = semanticCompressionKey(target);
    if (!key) {
      continue;
    }
    repeatedKeys.set(key, (repeatedKeys.get(key) || 0) + 1);
  }

  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = semanticCompressionKey(target);
    if (!key || (repeatedKeys.get(key) || 0) <= 1) {
      return true;
    }
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function inferAllowedActions(target: DomObservedTarget): TargetAllowedAction[] {
  return inferAllowedActionsFromFacts({
    kind: target.kind,
    role: target.role,
    label: target.label,
    displayLabel: target.displayLabel,
    interactionHint: target.interactionHint,
    text: target.text,
    placeholder: target.placeholder,
    inputName: target.inputName,
    inputType: target.inputType,
    autocomplete: target.autocomplete,
    ariaAutocomplete: target.ariaAutocomplete,
    surfaceKind: target.surfaceKind,
    controlsSurfaceSelector: target.controlsSurfaceSelector,
    states: target.states,
    structure: target.structure,
  });
}

function inferAvailability(target: DomObservedTarget): TargetAvailabilityState {
  const allowedActions = inferAllowedActions(target);
  const controlFamily = inferControlFamilyFromFacts(
    {
      kind: target.kind,
      role: target.role,
      label: target.label,
      displayLabel: target.displayLabel,
      interactionHint: target.interactionHint,
      text: target.text,
      placeholder: target.placeholder,
      inputName: target.inputName,
      inputType: target.inputType,
      autocomplete: target.autocomplete,
      ariaAutocomplete: target.ariaAutocomplete,
      surfaceKind: target.surfaceKind,
      controlsSurfaceSelector: target.controlsSurfaceSelector,
      states: target.states,
      structure: target.structure,
    },
    allowedActions
  );
  const acceptancePolicy = inferAcceptancePolicy(target, allowedActions);
  return inferAvailabilityFromFacts(target.states, target.context?.hintText, {
    readonlyInteractive:
      controlFamily === 'select' ||
      controlFamily === 'datepicker' ||
      acceptancePolicy === 'selection' ||
      acceptancePolicy === 'date-selection',
  });
}

function inferAcceptancePolicy(
  target: DomObservedTarget,
  allowedActions: ReadonlyArray<TargetAllowedAction>
): TargetAcceptancePolicy | undefined {
  return inferAcceptancePolicyFromFacts(
    {
      kind: target.kind,
      role: target.role,
      label: target.label,
      displayLabel: target.displayLabel,
      interactionHint: target.interactionHint,
      text: target.text,
      placeholder: target.placeholder,
      inputName: target.inputName,
      inputType: target.inputType,
      autocomplete: target.autocomplete,
      ariaAutocomplete: target.ariaAutocomplete,
      surfaceKind: target.surfaceKind,
      controlsSurfaceSelector: target.controlsSurfaceSelector,
      states: target.states,
      structure: target.structure,
    },
    allowedActions
  );
}

function inferCapability(
  target: DomObservedTarget,
  allowedActions: ReadonlyArray<TargetAllowedAction>
): TargetCapability {
  const hasExecutionPath = allowedActions.length > 0;
  if (!hasExecutionPath) {
    return 'informational';
  }

  const label = target.label ?? target.displayLabel ?? target.text ?? '';
  const descendantInteractiveCount = target.descendantInteractiveCount ?? 0;
  const giantContainerLike =
    label.length > 180 && descendantInteractiveCount >= 4 && allowedActions.includes('click');

  if (giantContainerLike) {
    return 'scope';
  }

  return 'actionable';
}

export function annotateDomTargets(targets: ReadonlyArray<DomObservedTarget>): DomObservedTarget[] {
  const annotated = materializeEmbeddedControlSurfaces(
    targets.map((target) => {
      const allowedActions = inferAllowedActions(target);
      const controlFamily = inferControlFamilyFromFacts(
        {
          kind: target.kind,
          role: target.role,
          label: target.label,
          displayLabel: target.displayLabel,
          interactionHint: target.interactionHint,
          text: target.text,
          placeholder: target.placeholder,
          inputName: target.inputName,
          inputType: target.inputType,
          autocomplete: target.autocomplete,
          ariaAutocomplete: target.ariaAutocomplete,
          surfaceKind: target.surfaceKind,
          controlsSurfaceSelector: target.controlsSurfaceSelector,
          states: target.states,
          structure: target.structure,
        },
        allowedActions
      );
      const availability = inferAvailability(target);
      const capability = inferCapability(target, allowedActions);
      const acceptancePolicy = inferAcceptancePolicy(target, allowedActions);
      const explicitSurfaceRef = buildSurfaceRef(target);
      const syntheticFormSurfaceRef =
        explicitSurfaceRef === undefined ? buildSyntheticFormSurfaceId(target) : undefined;
      const surfaceRef = explicitSurfaceRef ?? syntheticFormSurfaceRef;
      const surfaceKind = target.surfaceKind ?? (syntheticFormSurfaceRef ? 'form' : undefined);
      const surfaceLabel =
        target.surfaceLabel ??
        (syntheticFormSurfaceRef
          ? (target.context?.landmark?.label ?? target.context?.group?.label ?? 'Form')
          : undefined);
      const surfacePriority = target.surfacePriority ?? (surfaceKind === 'form' ? 70 : undefined);

      return {
        ...target,
        surfaceKind,
        surfaceLabel,
        surfacePriority,
        capability,
        availability,
        allowedActions,
        controlFamily,
        acceptancePolicy,
        surfaceRef,
      };
    })
  );

  return annotated.map((target, index, current) => {
    if (
      !target.surfaceRef ||
      !target.acceptancePolicy ||
      !(target.acceptancePolicy === 'selection' || target.acceptancePolicy === 'date-selection')
    ) {
      return target;
    }

    const ownerIndex = current.findIndex((candidate, candidateIndex) => {
      if (candidateIndex === index) return false;
      const controllerSelectorCandidates = [
        target.controlsSurfaceSelector,
        target.surfaceSelector,
        candidate.surfaceSelector,
      ];
      if (target.structure?.family === 'structured-grid') {
        controllerSelectorCandidates.push(...(target.surfaceSelectors ?? []));
      }
      const explicitController = controllerSelectorCandidates
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .some((selector) => candidate.controlsSurfaceSelector === selector);
      const sameSurface = candidate.surfaceRef === target.surfaceRef;
      if (!explicitController && !sameSurface) return false;
      if (candidate.allowedActions?.includes('fill')) return true;
      if (candidate.allowedActions?.includes('select')) return true;
      if (candidate.structure?.family === 'structured-grid') return false;
      if (candidate.capability === 'informational' && !explicitController) return false;
      return (
        candidate.allowedActions?.includes('click') &&
        ['input', 'select', 'button', 'combobox'].includes((candidate.kind || '').toLowerCase())
      );
    });

    return ownerIndex >= 0 ? { ...target, ownerIndex } : target;
  });
}

export function orderBySurfaceCompetition(
  targets: ReadonlyArray<DomObservedTarget>
): DomObservedTarget[] {
  const iframeFieldLike = (target: DomObservedTarget): boolean => {
    const kind = (target.kind ?? '').toLowerCase();
    const role = (target.role ?? '').toLowerCase();
    return (
      Boolean(target.framePath?.length) &&
      (target.allowedActions?.includes('fill') ||
        target.allowedActions?.includes('type') ||
        target.allowedActions?.includes('select') ||
        ['input', 'textarea', 'select', 'combobox'].includes(kind) ||
        ['textbox', 'combobox'].includes(role))
    );
  };

  return [...targets].sort((left, right) => {
    const leftPriority = left.surfacePriority ?? 0;
    const rightPriority = right.surfacePriority ?? 0;
    let leftScore = leftPriority * 10;
    let rightScore = rightPriority * 10;

    if (leftPriority >= 80) {
      leftScore += 3_000;
    } else if (leftPriority >= 50) {
      leftScore += 2_000;
    } else if (left.surfaceRef) {
      leftScore += 1_000;
    }

    if (rightPriority >= 80) {
      rightScore += 3_000;
    } else if (rightPriority >= 50) {
      rightScore += 2_000;
    } else if (right.surfaceRef) {
      rightScore += 1_000;
    }

    if (left.capability === 'actionable') {
      leftScore += 150;
    } else if (left.capability === 'scope') {
      leftScore += 75;
    }
    if (right.capability === 'actionable') {
      rightScore += 150;
    } else if (right.capability === 'scope') {
      rightScore += 75;
    }

    if (left.allowedActions?.includes('fill') || left.allowedActions?.includes('select')) {
      leftScore += 40;
    }
    if (right.allowedActions?.includes('fill') || right.allowedActions?.includes('select')) {
      rightScore += 40;
    }

    if (isPrimaryFormControlTarget(left) && formGroupingKeyOf(left)) {
      leftScore += 900;
    }
    if (isPrimaryFormControlTarget(right) && formGroupingKeyOf(right)) {
      rightScore += 900;
    }

    if (iframeFieldLike(left)) {
      leftScore += 1_200;
    }
    if (iframeFieldLike(right)) {
      rightScore += 1_200;
    }

    if (left.ownerIndex !== undefined) {
      leftScore -= 5;
    }
    if (right.ownerIndex !== undefined) {
      rightScore -= 5;
    }

    const scoreDelta = rightScore - leftScore;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    if (leftPriority !== rightPriority) {
      return rightPriority - leftPriority;
    }

    return (left.ordinal ?? 0) - (right.ordinal ?? 0);
  });
}
