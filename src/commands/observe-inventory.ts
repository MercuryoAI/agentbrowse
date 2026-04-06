import type { Frame, Locator } from 'playwright-core';
import type {
  TargetAcceptancePolicy,
  TargetAllowedAction,
  TargetAvailabilityState,
  TargetCapability,
  TargetContext,
  TargetContextNode,
  TargetControlFamily,
  TargetStructure,
  TargetValidationEvidence,
} from '../runtime-state.js';
import {
  inferAcceptancePolicyFromFacts,
  inferAllowedActionsFromFacts,
  inferAvailabilityFromFacts,
  inferControlFamilyFromFacts,
} from '../control-semantics.js';
import {
  LOCATOR_DOM_SIGNATURE_SCRIPT,
  normalizePageSignature,
  readLocatorDomSignature,
} from './descriptor-validation.js';
import { OBSERVE_DOM_LABEL_CONTRACT_HELPER_SCRIPT } from './observe-dom-label-contract.js';
import { TRANSPARENT_ACTIONABLE_CONTROL_HELPER_SCRIPT } from './user-actionable.js';

export type DomObservedContextNode = TargetContextNode & {
  selector?: string;
  fallbackLabel?: string;
};

export type DomObservedTargetContext = Omit<
  TargetContext,
  'item' | 'group' | 'container' | 'landmark'
> & {
  item?: DomObservedContextNode;
  group?: DomObservedContextNode;
  container?: DomObservedContextNode;
  landmark?: DomObservedContextNode;
  fallbackHintText?: string;
};

export type DomObservedTarget = {
  kind?: string;
  label?: string;
  fallbackLabel?: string;
  displayLabel?: string;
  currentValue?: string;
  interactionHint?: 'click';
  role?: string;
  text?: string;
  placeholder?: string;
  inputName?: string;
  inputType?: string;
  autocomplete?: string;
  ariaAutocomplete?: string;
  validation?: TargetValidationEvidence;
  title?: string;
  testId?: string;
  testIdAttribute?: 'data-testid' | 'data-test-id';
  selector?: string;
  framePath?: string[];
  frameUrl?: string;
  pageSignature?: string;
  domSignature?: string;
  semanticsSource?: 'dom' | 'aria-snapshot';
  states?: Record<string, string | boolean | number>;
  context?: DomObservedTargetContext;
  surfaceKind?: string;
  surfaceLabel?: string;
  fallbackSurfaceLabel?: string;
  surfaceSelector?: string;
  surfaceSelectors?: string[];
  surfacePriority?: number;
  descendantInteractiveCount?: number;
  descendantEditableCount?: number;
  ordinal?: number;
  capability?: TargetCapability;
  availability?: TargetAvailabilityState;
  controlFamily?: TargetControlFamily;
  allowedActions?: TargetAllowedAction[];
  acceptancePolicy?: TargetAcceptancePolicy;
  surfaceRef?: string;
  controlsSurfaceSelector?: string;
  formSelector?: string;
  structure?: TargetStructure;
  ownerIndex?: number;
};

type StagehandDomFacts = {
  kind?: string;
  role?: string;
  placeholder?: string;
  inputName?: string;
  inputType?: string;
  autocomplete?: string;
  ariaAutocomplete?: string;
  value?: string;
  text?: string;
  currentValue?: string;
  states?: Record<string, string | boolean | number>;
};

type StagehandLocatorSnapshot = {
  domSignature: string | null;
  domFacts: StagehandDomFacts | null;
};

export type DomTargetCollectionOptions = {
  includeActivationAffordances?: boolean;
  pageSignature?: string;
};

type DomTargetCollectionContext = {
  evaluate<T>(pageFunction: string): Promise<T>;
};

export type FrameHostDescriptor = {
  selector: string;
  userVisible: boolean;
};

type StructuredCellVariantEvidence = {
  role?: string;
  surfaceKind?: string;
  normalizedLabel?: string;
  className?: string;
  hasSeatAttribute?: boolean;
  hasSeatRowAttribute?: boolean;
  hasSeatColumnAttribute?: boolean;
  hasDateMetadata?: boolean;
};

export type DirectionalControlFallbackPosition = 'leading' | 'trailing' | 'upper' | 'lower';

export type DirectionalControlFallbackEvidence = {
  kind?: string;
  role?: string;
  groupLabel?: string;
  anchorText?: string;
  position?: DirectionalControlFallbackPosition;
};

export type DisabledStateSemanticEvidence = {
  tagName?: string;
  role?: string;
  inputType?: string;
  className?: string;
  datasetText?: string;
  dataState?: string;
  dataStatus?: string;
  ariaLabel?: string;
};

const DOM_TARGET_COLLECTION_LIMIT = 640;
const DOM_TARGET_OUTPUT_LIMIT = 480;
export function inferStructuredCellVariantFromEvidence(
  evidence: StructuredCellVariantEvidence
): 'date-cell' | 'seat-cell' | 'grid-cell' | undefined {
  const role = (evidence.role ?? '').toLowerCase();
  const surfaceKind = (evidence.surfaceKind ?? '').toLowerCase();
  const normalizedLabel = (evidence.normalizedLabel ?? '').replace(/\s+/g, ' ').trim();
  const className = (evidence.className ?? '').toLowerCase();
  const structuredSurface = surfaceKind === 'grid' || surfaceKind === 'datepicker';
  const hasDateMetadata = evidence.hasDateMetadata === true;
  const hasSeatMetadata = Boolean(
    evidence.hasSeatAttribute || evidence.hasSeatRowAttribute || evidence.hasSeatColumnAttribute
  );
  const seatIdentityLike =
    /(?:\bseat\s*\d{1,3}[a-z]?\b|место\s*\d{1,3}[a-z]?\b|\b\d{1,3}[a-z]\b|\b[a-z]\d{1,3}\b)/i.test(
      normalizedLabel
    );
  const seatClassLike = /seat|cabin|fare|row/.test(className);
  const compactDateCellLabel =
    /^(?:\d{1,2}|january|february|march|april|may|june|july|august|september|october|november|december|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)$/i.test(
      normalizedLabel
    ) || /^(?:\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)$/.test(normalizedLabel);
  const dateLike =
    surfaceKind === 'datepicker' ||
    (hasDateMetadata && role === 'gridcell') ||
    ((role === 'gridcell' || structuredSurface || hasDateMetadata) && compactDateCellLabel);

  if (dateLike) {
    return 'date-cell';
  }

  if (seatIdentityLike || hasSeatMetadata) {
    return 'seat-cell';
  }

  if (role === 'gridcell' && seatClassLike) {
    return 'seat-cell';
  }

  if (role === 'gridcell' && structuredSurface) {
    return 'grid-cell';
  }

  return undefined;
}

export function inferDirectionalControlFallbackFromEvidence(
  evidence: DirectionalControlFallbackEvidence
): string | undefined {
  const normalize = (value?: string): string | undefined => {
    const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
    return normalized || undefined;
  };
  const normalizedKind = normalize(evidence.kind)?.toLowerCase();
  const normalizedRole = normalize(evidence.role)?.toLowerCase();
  const buttonLike =
    normalizedKind === 'button' ||
    normalizedRole === 'button' ||
    (normalizedKind === 'input' && normalizedRole === 'button');
  if (!buttonLike) {
    return undefined;
  }

  const position = normalize(evidence.position)?.toLowerCase() as
    | DirectionalControlFallbackPosition
    | undefined;
  const anchorText = normalize(evidence.anchorText);
  const groupLabel = normalize(evidence.groupLabel);
  if (!position || !anchorText) {
    return undefined;
  }

  const monthYearLike =
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\b/i.test(
      anchorText
    );
  if (monthYearLike && (position === 'leading' || position === 'trailing')) {
    return position === 'leading' ? 'Previous month' : 'Next month';
  }

  const counterLike = /^\d{1,3}$/.test(anchorText);
  if (counterLike && groupLabel && (position === 'leading' || position === 'trailing')) {
    const subject = groupLabel.toLowerCase();
    return position === 'leading' ? `Decrease ${subject}` : `Increase ${subject}`;
  }

  return undefined;
}

export function inferDisabledStateFromSemanticEvidence(
  evidence: DisabledStateSemanticEvidence
): boolean {
  const normalize = (value?: string): string =>
    (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

  const tagName = normalize(evidence.tagName);
  const role = normalize(evidence.role);
  const inputType = normalize(evidence.inputType);
  const className = normalize(evidence.className);
  const nonClassBlob = [
    evidence.datasetText,
    evidence.dataState,
    evidence.dataStatus,
    evidence.ariaLabel,
  ]
    .map(normalize)
    .filter(Boolean)
    .join(' ');
  const fullSemanticBlob = [className, nonClassBlob].filter(Boolean).join(' ');
  const disabledLikeRe = /(?:disabled?|disable|inactive|unselectable)\b/;

  // Native fields should trust real DOM/ARIA/data-state signals, not styling classes
  // like Kupibilet's `ym-disable-keys`.
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return disabledLikeRe.test(nonClassBlob);
  }

  const collectionOrButtonLike =
    tagName === 'button' ||
    role === 'button' ||
    role === 'option' ||
    role === 'menuitem' ||
    role === 'listitem' ||
    role === 'gridcell' ||
    role === 'tab' ||
    role === 'radio' ||
    inputType === 'button' ||
    inputType === 'submit' ||
    inputType === 'reset';

  return disabledLikeRe.test(collectionOrButtonLike ? fullSemanticBlob : nonClassBlob);
}

const INFER_STRUCTURED_CELL_VARIANT_HELPER_SCRIPT = `const inferStructuredCellVariantFromEvidence = ${inferStructuredCellVariantFromEvidence.toString()};`;
const INFER_DISABLED_STATE_FROM_SEMANTIC_EVIDENCE_HELPER_SCRIPT = String.raw`
    const inferDisabledStateFromSemanticEvidence = (evidence) => {
      const normalizeDisabledSemanticValue = (value) =>
        (value || '').replace(/\s+/g, ' ').trim().toLowerCase();

      const tagName = normalizeDisabledSemanticValue(evidence?.tagName);
      const role = normalizeDisabledSemanticValue(evidence?.role);
      const inputType = normalizeDisabledSemanticValue(evidence?.inputType);
      const className = normalizeDisabledSemanticValue(evidence?.className);
      const nonClassBlob = [
        evidence?.datasetText,
        evidence?.dataState,
        evidence?.dataStatus,
        evidence?.ariaLabel,
      ]
        .map(normalizeDisabledSemanticValue)
        .filter(Boolean)
        .join(' ');
      const fullSemanticBlob = [className, nonClassBlob].filter(Boolean).join(' ');
      const disabledLikeRe = /(?:disabled?|disable|inactive|unselectable)\b/;

      if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
        return disabledLikeRe.test(nonClassBlob);
      }

      const collectionOrButtonLike =
        tagName === 'button' ||
        role === 'button' ||
        role === 'option' ||
        role === 'menuitem' ||
        role === 'listitem' ||
        role === 'gridcell' ||
        role === 'tab' ||
        role === 'radio' ||
        inputType === 'button' ||
        inputType === 'submit' ||
        inputType === 'reset';

      return disabledLikeRe.test(collectionOrButtonLike ? fullSemanticBlob : nonClassBlob);
    };
`;
const INFER_DIRECTIONAL_CONTROL_FALLBACK_HELPER_SCRIPT = String.raw`
    const inferDirectionalControlFallbackFromEvidence = (evidence) => {
      const normalizeDirectionalControlFallbackValue = (value) => {
        const normalized = (value || '').replace(/\s+/g, ' ').trim();
        return normalized || undefined;
      };

      const normalizedKind = normalizeDirectionalControlFallbackValue(evidence?.kind)?.toLowerCase();
      const normalizedRole = normalizeDirectionalControlFallbackValue(evidence?.role)?.toLowerCase();
      const buttonLike =
        normalizedKind === 'button' ||
        normalizedRole === 'button' ||
        (normalizedKind === 'input' && normalizedRole === 'button');
      if (!buttonLike) {
        return undefined;
      }

      const position = normalizeDirectionalControlFallbackValue(evidence?.position)?.toLowerCase();
      const anchorText = normalizeDirectionalControlFallbackValue(evidence?.anchorText);
      const groupLabel = normalizeDirectionalControlFallbackValue(evidence?.groupLabel);
      if (!position || !anchorText) {
        return undefined;
      }

      const monthYearLike =
        /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\b/i.test(
          anchorText
        );
      if (monthYearLike && (position === 'leading' || position === 'trailing')) {
        return position === 'leading' ? 'Previous month' : 'Next month';
      }

      const counterLike = /^\d{1,3}$/.test(anchorText);
      if (counterLike && groupLabel && (position === 'leading' || position === 'trailing')) {
        const subject = groupLabel.toLowerCase();
        return position === 'leading' ? 'Decrease ' + subject : 'Increase ' + subject;
      }

      return undefined;
    };
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeInheritedFramePath(framePath?: string[]): string[] | undefined {
  return Array.isArray(framePath) && framePath.length > 0 ? [...framePath] : undefined;
}

function normalizeInheritedFrameUrl(frameUrl?: string): string | undefined {
  return typeof frameUrl === 'string' && frameUrl.trim().length > 0 ? frameUrl : undefined;
}

function normalizeInheritedPageSignature(pageSignature?: string): string | undefined {
  return typeof pageSignature === 'string' && pageSignature.trim().length > 0
    ? pageSignature
    : undefined;
}

function applyInheritedDomTargetMetadata(
  target: DomObservedTarget,
  options?: {
    framePath?: string[];
    frameUrl?: string;
    pageSignature?: string;
  }
): DomObservedTarget {
  const normalizedFramePath =
    normalizeInheritedFramePath(options?.framePath) ??
    normalizeInheritedFramePath(target.framePath);
  const normalizedFrameUrl = normalizeInheritedFrameUrl(options?.frameUrl) ?? target.frameUrl;
  const normalizedPageSignature =
    normalizeInheritedPageSignature(options?.pageSignature) ?? target.pageSignature;

  return {
    ...target,
    framePath: normalizedFramePath,
    frameUrl: normalizedFrameUrl,
    pageSignature: normalizedPageSignature,
  };
}

function enrichObservedTargetSemantics(target: DomObservedTarget): DomObservedTarget {
  const facts = {
    kind: target.kind,
    role: target.role,
    label: target.label,
    interactionHint: target.interactionHint,
    placeholder: target.placeholder,
    inputName: target.inputName,
    inputType: target.inputType,
    autocomplete: target.autocomplete,
    ariaAutocomplete: target.ariaAutocomplete,
    states: target.states,
  };
  const allowedActions = inferAllowedActionsFromFacts(facts);
  const acceptancePolicy = inferAcceptancePolicyFromFacts(facts, allowedActions);
  const controlFamily = inferControlFamilyFromFacts(facts, allowedActions);
  const availability = inferAvailabilityFromFacts(facts.states, undefined, {
    readonlyInteractive:
      controlFamily === 'select' ||
      controlFamily === 'datepicker' ||
      acceptancePolicy === 'selection' ||
      acceptancePolicy === 'date-selection',
  });
  const capability = allowedActions.length > 0 ? 'actionable' : 'informational';

  return {
    ...target,
    capability,
    availability,
    controlFamily,
    allowedActions,
    acceptancePolicy,
  };
}

function hasStagehandDomFacts(domFacts: StagehandDomFacts | null): boolean {
  return Boolean(
    domFacts &&
      (domFacts.kind ||
        domFacts.role ||
        domFacts.placeholder ||
        domFacts.ariaAutocomplete ||
        domFacts.value ||
        domFacts.text ||
        domFacts.currentValue ||
        (domFacts.states && Object.keys(domFacts.states).length > 0))
  );
}

function scoreStagehandLocatorSnapshot(snapshot: StagehandLocatorSnapshot): number {
  let score = 0;
  if (snapshot.domSignature) {
    score += 1;
  }
  if (snapshot.domFacts?.kind) {
    score += 1;
  }
  if (snapshot.domFacts?.placeholder) {
    score += 1;
  }
  if (snapshot.domFacts?.ariaAutocomplete) {
    score += 1;
  }
  if (snapshot.domFacts?.value) {
    score += 1;
  }
  if (snapshot.domFacts?.text) {
    score += 1;
  }
  if (snapshot.domFacts?.currentValue) {
    score += 2;
  }
  if (snapshot.domFacts?.role) {
    score += 3;
  }
  if (snapshot.domFacts?.states && Object.keys(snapshot.domFacts.states).length > 0) {
    score += 3;
  }
  return score;
}

async function readStagehandLocatorSnapshotOnce(
  locator: Locator
): Promise<StagehandLocatorSnapshot> {
  return {
    domSignature: await readLocatorDomSignature(locator).catch(() => null),
    domFacts: await readStagehandDomFacts(locator).catch(() => null),
  };
}

export async function readStagehandLocatorSnapshot(
  locator: Locator
): Promise<StagehandLocatorSnapshot> {
  const target = locator.first();
  let best = await readStagehandLocatorSnapshotOnce(target);
  if (hasStagehandDomFacts(best.domFacts)) {
    return best;
  }

  await target.waitFor({ state: 'attached', timeout: 1200 }).catch(() => undefined);

  for (const delayMs of [0, 100, 250]) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    const snapshot = await readStagehandLocatorSnapshotOnce(target);
    if (scoreStagehandLocatorSnapshot(snapshot) > scoreStagehandLocatorSnapshot(best)) {
      best = snapshot;
    }
    if (hasStagehandDomFacts(snapshot.domFacts)) {
      return snapshot;
    }
  }

  return best;
}

const STAGEHAND_DOM_FACTS_SCRIPT = String.raw`
  ${OBSERVE_DOM_LABEL_CONTRACT_HELPER_SCRIPT}
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  const inputLike = element;
  const disabledProperty =
    typeof inputLike.disabled === 'boolean' ? inputLike.disabled : false;
  const readonlyProperty =
    'readOnly' in inputLike && typeof inputLike.readOnly === 'boolean' ? inputLike.readOnly : false;
  const disabled =
    element.getAttribute('aria-disabled') === 'true' || Boolean(disabledProperty);
  const readonly =
    element.hasAttribute('readonly') ||
    element.getAttribute('aria-readonly') === 'true' ||
    Boolean(readonlyProperty);
  const expandedValue = element.getAttribute('aria-expanded');
  const selectedValue = element.getAttribute('aria-selected');
  const checkedValue = element.getAttribute('aria-checked');
  const pressedValue = element.getAttribute('aria-pressed');
  const expanded =
    expandedValue === 'true' ? true : expandedValue === 'false' ? false : undefined;
  const selected =
    selectedValue === 'true' ? true : selectedValue === 'false' ? false : undefined;
  const checked =
    checkedValue === 'true' ? true : checkedValue === 'false' ? false : undefined;
  const pressed =
    pressedValue === 'true' ? true : pressedValue === 'false' ? false : undefined;
  const current =
    element.getAttribute('aria-current') ??
    (document.activeElement === element ? true : undefined);
  const states = {};
  const directValue =
    'value' in inputLike && typeof inputLike.value === 'string'
      ? observedNormalizeDescriptorText(inputLike.value)
      : undefined;
  const directText = observedNormalizeDescriptorText(element.innerText || element.textContent || '');
  const currentValue = observedPopupCurrentValueOf(element);

  if (expanded !== undefined) states.expanded = expanded;
  if (selected !== undefined) states.selected = selected;
  if (checked !== undefined) states.checked = checked;
  if (pressed !== undefined) states.pressed = pressed;
  if (current !== undefined) states.current = current;
  if (readonly) states.readonly = true;
  if (disabled) states.disabled = true;
  if (element.getAttribute('aria-disabled') === 'true') states.ariaDisabled = true;

  return {
    kind: element.tagName.toLowerCase(),
    role: element.getAttribute('role') || undefined,
    placeholder: element.getAttribute('placeholder') || undefined,
    inputName: element.getAttribute('name') || undefined,
    inputType: element.getAttribute('type') || undefined,
    autocomplete: element.getAttribute('autocomplete') || undefined,
    ariaAutocomplete: element.getAttribute('aria-autocomplete') || undefined,
    value: directValue || undefined,
    text: directText || undefined,
    currentValue: currentValue || undefined,
    states: Object.keys(states).length > 0 ? states : undefined,
  };
`;

function readStagehandDomFactsInBrowser(element: Element): StagehandDomFacts | null {
  return Function('element', STAGEHAND_DOM_FACTS_SCRIPT)(element) as StagehandDomFacts | null;
}

async function readStagehandDomFacts(locator: Locator): Promise<StagehandDomFacts | null> {
  return locator
    .evaluate(
      (element, source) => Function('element', source)(element) as StagehandDomFacts | null,
      STAGEHAND_DOM_FACTS_SCRIPT
    )
    .catch(() => null);
}

export function normalizeStagehandSelector(selector: string): {
  selector: string;
  framePath?: string[];
} {
  if (!selector.startsWith('xpath=')) {
    return { selector };
  }

  let remaining = selector.slice('xpath='.length).trim();
  const framePath: string[] = [];
  const frameBoundaryPattern = /^(.*?\/iframe\[\d+\])\/html\[1\]\/body\[1\](\/.*)$/;

  while (true) {
    const boundary = remaining.match(frameBoundaryPattern);
    if (!boundary) {
      break;
    }

    framePath.push(`xpath=${boundary[1]}`);
    remaining = `/html[1]/body[1]${boundary[2]}`;
  }

  return framePath.length > 0
    ? {
        selector: `xpath=${remaining}`,
        framePath,
      }
    : { selector };
}

async function collectDomTargetsFromDocument(
  context: DomTargetCollectionContext,
  options?: DomTargetCollectionOptions & {
    framePath?: string[];
    frameUrl?: string;
  }
): Promise<DomObservedTarget[]> {
  const includeActivationAffordances = options?.includeActivationAffordances === true;
  const inheritedFramePath = JSON.stringify(options?.framePath ?? []);
  const inheritedFrameUrl = JSON.stringify(options?.frameUrl ?? '');
  const inheritedPageSignature = JSON.stringify(options?.pageSignature ?? '');
  const observedTargets = await context.evaluate<DomObservedTarget[]>(String.raw`(() => {
    const includeActivationAffordances = ${includeActivationAffordances ? 'true' : 'false'};
    const inheritedFramePath = ${inheritedFramePath};
    const inheritedFrameUrl = ${inheritedFrameUrl};
    const inheritedPageSignature = ${inheritedPageSignature};
    const domSignatureOf = (element) => {
      ${LOCATOR_DOM_SIGNATURE_SCRIPT}
    };
    const selector =
      'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="option"], [role="gridcell"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
    const contextSelector =
      'main, aside, section, form, article, nav, [role="dialog"], [role="listbox"], [role="menu"], [role="grid"], [role="region"], [role="tabpanel"]';
    const collectionSelector =
      'ul, ol, table, tbody, [role="list"], [role="listbox"], [role="menu"], [role="grid"], [role="tablist"], [role="radiogroup"]';
    const itemSelector =
      'li, tr, td, article, [role="option"], [role="listitem"], [role="row"], [role="gridcell"], [role="tab"], [role="menuitem"], [role="radio"]';
    const headingSelector = 'h1, h2, h3, h4, h5, h6, [role="heading"], legend';
    const collectorElementLimit = ${DOM_TARGET_COLLECTION_LIMIT};
    const collectorOutputLimit = ${DOM_TARGET_OUTPUT_LIMIT};

    const cssEscape = (value) =>
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(value)
        : value.replace(/["\\]/g, '\\$&');

    const ownerWindowOf = (node) => node?.ownerDocument?.defaultView || window;
    const isHTMLElementNode = (value) => {
      const view = ownerWindowOf(value);
      return Boolean(view && value instanceof view.HTMLElement);
    };
    const isHTMLInputNode = (value) => {
      const view = ownerWindowOf(value);
      return Boolean(view && value instanceof view.HTMLInputElement);
    };
    const isHTMLLabelNode = (value) => {
      const view = ownerWindowOf(value);
      return Boolean(view && value instanceof view.HTMLLabelElement);
    };
    const isHTMLTextAreaNode = (value) => {
      const view = ownerWindowOf(value);
      return Boolean(view && value instanceof view.HTMLTextAreaElement);
    };
    const isHTMLSelectNode = (value) => {
      const view = ownerWindowOf(value);
      return Boolean(view && value instanceof view.HTMLSelectElement);
    };
    const isHTMLIFrameNode = (value) => {
      const view = ownerWindowOf(value);
      return Boolean(view && value instanceof view.HTMLIFrameElement);
    };
    const isShadowRootNode = (value) => {
      const view = ownerWindowOf(value);
      return Boolean(view && value instanceof view.ShadowRoot);
    };
    const composedParentElement = (element) => {
      if (!isHTMLElementNode(element)) return undefined;
      if (element.parentElement) return element.parentElement;
      const root = element.getRootNode?.();
      if (isShadowRootNode(root) && isHTMLElementNode(root.host)) {
        return root.host;
      }
      return undefined;
    };
    const composedClosest = (element, selectorValue) => {
      let current = element;

      while (isHTMLElementNode(current)) {
        const direct = current.closest?.(selectorValue);
        if (isHTMLElementNode(direct)) {
          return direct;
        }
        current = composedParentElement(current);
      }

      return undefined;
    };
    const associatedLabelControlOf = (element) => {
      if (!isHTMLLabelNode(element)) return undefined;

      const directControl = element.control;
      if (isHTMLElementNode(directControl)) {
        return directControl;
      }

      const nestedControl = element.querySelector?.('input, select, textarea');
      return isHTMLElementNode(nestedControl) ? nestedControl : undefined;
    };
    const labelBackedChoiceControlOf = (element) => {
      const control = associatedLabelControlOf(element);
      if (!isHTMLInputNode(control)) return undefined;

      const type = (control.type || '').toLowerCase();
      if (type === 'radio' || type === 'checkbox') {
        return control;
      }

      return undefined;
    };
    const hiddenChoiceSiblingControlOf = (element) => {
      if (!isHTMLElementNode(element)) return undefined;

      const parent = composedParentElement(element);
      if (!isHTMLElementNode(parent)) {
        return undefined;
      }

      const siblingChoiceControls = Array.from(parent.children).filter((candidate) => {
        if (candidate === element || !isHTMLInputNode(candidate)) {
          return false;
        }

        const type = (candidate.type || '').toLowerCase();
        if (type !== 'radio' && type !== 'checkbox') {
          return false;
        }

        const style = window.getComputedStyle(candidate);
        const rect = candidate.getBoundingClientRect();
        return (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.pointerEvents === 'none' ||
          Number(style.opacity || '1') < 0.05 ||
          rect.width < 4 ||
          rect.height < 4
        );
      });

      if (siblingChoiceControls.length !== 1) {
        return undefined;
      }

      const visibleNonChoiceSiblings = Array.from(parent.children).filter(
        (candidate) =>
          candidate !== siblingChoiceControls[0] &&
          isHTMLElementNode(candidate) &&
          isVisible(candidate)
      );

      if (visibleNonChoiceSiblings.length !== 1 || visibleNonChoiceSiblings[0] !== element) {
        return undefined;
      }

      return siblingChoiceControls[0];
    };
    const associatedChoiceControlOf = (element) => {
      if (isHTMLInputNode(element)) {
        const type = (element.type || '').toLowerCase();
        if (type === 'radio' || type === 'checkbox') {
          return element;
        }
      }

      return labelBackedChoiceControlOf(element) || hiddenChoiceSiblingControlOf(element);
    };
    ${TRANSPARENT_ACTIONABLE_CONTROL_HELPER_SCRIPT}
    ${OBSERVE_DOM_LABEL_CONTRACT_HELPER_SCRIPT}
    ${INFER_STRUCTURED_CELL_VARIANT_HELPER_SCRIPT}
    ${INFER_DISABLED_STATE_FROM_SEMANTIC_EVIDENCE_HELPER_SCRIPT}
    ${INFER_DIRECTIONAL_CONTROL_FALLBACK_HELPER_SCRIPT}

    const normalizeDescriptorText = (value) => observedNormalizeDescriptorText(value);

    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse'
      ) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }
      if (style.opacity === '0') {
        return isTransparentActionableControl(element);
      }
      return true;
    };

    const compactDateCellLabelRe =
      /^(?:\d{1,2}|january|february|march|april|may|june|july|august|september|october|november|december|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)$/i;

    const rawDescriptorLabelOf = (element) => {
      if (!isHTMLElementNode(element)) {
        return '';
      }

      return normalizeDescriptorText(
        element.getAttribute('aria-label') ||
          element.getAttribute('title') ||
          element.innerText ||
          element.textContent ||
          ''
      );
    };

    const compactDateTokenOf = (element) => {
      if (!isHTMLElementNode(element)) {
        return '';
      }

      const descriptorValues = [rawDescriptorLabelOf(element)].concat(
        Array.from(element.querySelectorAll('[aria-label]'))
          .slice(0, 6)
          .map((candidate) => normalizeDescriptorText(candidate.getAttribute('aria-label')))
      );

      for (const descriptorValue of descriptorValues) {
        if (!descriptorValue) {
          continue;
        }

        const monthMatch = descriptorValue.match(
          /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i
        );
        if (monthMatch) {
          return monthMatch[1].toLowerCase();
        }

        const dayMatch = descriptorValue.match(/\b(\d{1,2})\b/);
        if (dayMatch) {
          return dayMatch[1];
        }
      }

      return '';
    };

    const isDatepickerLikeContext = (parentGridCell, element) => {
      const contextNodes = [
        parentGridCell,
        element,
        composedClosest(parentGridCell, '[role="dialog"]'),
        composedClosest(parentGridCell, '[role="grid"]'),
      ];

      return contextNodes.some((candidate) => {
        if (!isHTMLElementNode(candidate)) {
          return false;
        }

        if (
          candidate.hasAttribute('data-day') ||
          candidate.hasAttribute('data-date') ||
          candidate.hasAttribute('data-iso')
        ) {
          return true;
        }

        const semanticBlob = normalizeDescriptorText(
          [
            candidate.getAttribute('role'),
            candidate.getAttribute('aria-label'),
            candidate.getAttribute('aria-roledescription'),
            candidate.getAttribute('data-testid'),
            candidate.getAttribute('id'),
            candidate.getAttribute('class'),
            candidate.getAttribute('data-iso'),
          ]
            .filter(Boolean)
            .join(' ')
        ).toLowerCase();

        if (
          /\b(date|calendar|month|departure|return|departing|arriving|outbound|inbound)\b/.test(
            semanticBlob
          ) ||
          /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(
            semanticBlob
          ) ||
          /\b\d{4}-\d{2}-\d{2}\b/.test(semanticBlob)
        ) {
          return true;
        }

        const descendantAria = normalizeDescriptorText(
          Array.from(candidate.querySelectorAll('[aria-label]'))
            .slice(0, 6)
            .map((child) => child.getAttribute('aria-label') || '')
            .join(' ')
        ).toLowerCase();

        return (
          /\b(date|calendar|month|departure|return|departing|arriving|outbound|inbound)\b/.test(
            descendantAria
          ) ||
          /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(
            descendantAria
          )
        );
      });
    };

    const isDuplicateDatepickerButtonCandidate = (element) => {
      if (!isHTMLElementNode(element)) {
        return false;
      }

      if ((element.getAttribute('role') || '').toLowerCase() !== 'button') {
        return false;
      }

      const parentGridCell = composedParentElement(element);
      if (
        !isHTMLElementNode(parentGridCell) ||
        (parentGridCell.getAttribute('role') || '').toLowerCase() !== 'gridcell'
      ) {
        return false;
      }

      const elementDateToken = compactDateTokenOf(element);
      const parentDateToken = compactDateTokenOf(parentGridCell);
      if (!elementDateToken || elementDateToken !== parentDateToken) {
        return false;
      }

      if (!compactDateCellLabelRe.test(elementDateToken)) {
        return false;
      }

      return isDatepickerLikeContext(parentGridCell, element);
    };

    const collectInteractiveElements = (
      root,
      limit = collectorElementLimit,
      acc = [],
      seen = new Set()
    ) => {
      if (!root?.querySelectorAll || acc.length >= limit) {
        return acc;
      }

      const matches = Array.from(root.querySelectorAll(selector)).concat(
        Array.from(root.querySelectorAll('*')).filter(
          (candidate) =>
            isHTMLElementNode(candidate) &&
            !candidate.matches?.(selector) &&
            !isHTMLLabelNode(candidate) &&
            Boolean(associatedChoiceControlOf(candidate))
        ),
        Array.from(root.querySelectorAll('label')).filter((candidate) =>
          isHTMLElementNode(candidate) && Boolean(associatedChoiceControlOf(candidate))
        )
      );
      for (const candidate of matches) {
        if (acc.length >= limit) break;
        if (!isHTMLElementNode(candidate) || seen.has(candidate)) continue;
        if (!isVisible(candidate)) continue;
        if (isDuplicateDatepickerButtonCandidate(candidate)) continue;
        seen.add(candidate);
        acc.push(candidate);
      }

      const descendants = Array.from(root.querySelectorAll('*'));
      for (const candidate of descendants) {
        if (acc.length >= limit) break;
        if (!isHTMLElementNode(candidate) || !candidate.shadowRoot) continue;
        collectInteractiveElements(candidate.shadowRoot, limit, acc, seen);
      }

      return acc;
    };

    const imageAltTextOf = (element) => {
      if (!isHTMLElementNode(element)) return undefined;

      const seen = new Set();
      const values = [];
      const push = (value) => {
        const normalized = normalizeDescriptorText(value);
        if (!normalized || normalized.length < 2 || normalized.length > 80) {
          return;
        }
        const key = normalized.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        values.push(normalized);
      };

      if (element.tagName.toLowerCase() === 'img') {
        push(element.getAttribute('alt'));
      }

      for (const candidate of Array.from(element.querySelectorAll('img[alt]')).slice(0, 6)) {
        if (!isHTMLElementNode(candidate)) continue;
        push(candidate.getAttribute('alt'));
      }

      return values.length > 0 ? values.join(' ') : undefined;
    };

    const visibleDescriptorTextOf = (element) => {
      const text = normalizeDescriptorText(element?.innerText || '');
      return text || undefined;
    };

    const visibleChildDescriptorTextOf = (element) => {
      if (!isHTMLElementNode(element)) {
        return undefined;
      }

      const values = [];
      const seen = new Set();
      const pushValue = (value) => {
        const normalized = normalizeDescriptorText(value || '');
        if (!normalized || seen.has(normalized)) {
          return;
        }
        seen.add(normalized);
        values.push(normalized);
      };

      for (const child of Array.from(element.children).slice(0, 6)) {
        if (!isHTMLElementNode(child) || !isVisible(child)) {
          continue;
        }
        pushValue(child.innerText || '');
        pushValue(imageAltTextOf(child));
        if (values.join(' ').length >= 160) {
          break;
        }
      }

      return values.length > 0 ? values.join(' ') : undefined;
    };

    const textOf = (element, options = {}) => {
      const container = options?.container === true;
      const tag = element?.tagName?.toLowerCase?.();
      if (tag && ['script', 'style', 'noscript', 'template'].includes(tag)) {
        return undefined;
      }
      const buttonLikeText =
        isHTMLInputNode(element) &&
        ['button', 'submit', 'reset'].includes((element.getAttribute('type') || 'text').trim().toLowerCase())
          ? normalizeDescriptorText(element.value || element.getAttribute('value') || '')
          : undefined;
      if (buttonLikeText) {
        return buttonLikeText;
      }
      const altValue = imageAltTextOf(element);
      const visibleText = visibleDescriptorTextOf(element);
      const childText = container ? visibleChildDescriptorTextOf(element) : undefined;
      const textValue = visibleText || childText;

      if (!textValue && !altValue) {
        return undefined;
      }
      if (!textValue) {
        return altValue;
      }
      if (!altValue || textValue.toLowerCase().includes(altValue.toLowerCase())) {
        return textValue;
      }
      return (altValue + ' ' + textValue).trim();
    };

    const isMeaningfulLabel = (value) => observedIsMeaningfulLabel(value);

    const inputTypeOf = (element) => observedInputTypeOf(element);

    const isButtonLikeInput = (element) => observedIsButtonLikeInput(element);

    const popupCurrentValueOf = (element) => observedPopupCurrentValueOf(element);

    const describedByTextOf = (element) => {
      const describedBy = element.getAttribute('aria-describedby')?.trim();
      if (!describedBy) return undefined;

      const text = describedBy
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .filter(Boolean)
        .join(' ')
        .trim();

      return isMeaningfulLabel(text) ? text : undefined;
    };

    const explicitLabelOf = (element) => observedExplicitLabelOf(element);

    const looseFieldLabelOf = (element) => observedLooseFieldLabelOf(element);

    const VALIDATION_TEXT_RE =
      /(?:required|invalid|incorrect|too\s+(?:short|long)|must|error|format|please\s+(?:enter|select|choose|fill)|невер|ошиб|обязател|заполн|введите|укажите|выберите|долж|нужно|формат|цифр|символ)/i;

    const syntheticLabelOf = (element) => {
      const tag = element.tagName.toLowerCase();
      const explicitRole = element.getAttribute('role')?.trim();
      const hasStructuredAffordance =
        element.hasAttribute('aria-haspopup') ||
        element.hasAttribute('aria-controls') ||
        element.hasAttribute('aria-expanded') ||
        element.hasAttribute('aria-pressed') ||
        element.hasAttribute('aria-selected') ||
        element.hasAttribute('aria-describedby');
      if (tag === 'input') {
        const inputType = inputTypeOf(element);
        if (isButtonLikeInput(element)) return 'Button';
        if (inputType === 'checkbox') return 'Checkbox';
        if (inputType === 'radio') return 'Radio';
        if (inputType === 'tel') return 'Phone input';
        if (inputType === 'email') return 'Email input';
        if (inputType === 'password') return 'Password input';
        if (inputType === 'search') return 'Search input';
        if (inputType === 'date') return 'Date input';
        return 'Text input';
      }
      if (tag === 'textarea') return 'Text area';
      if (tag === 'select' || explicitRole === 'combobox') return 'Combobox';
      if (explicitRole === 'textbox') return 'Text input';
      if ((tag === 'button' || explicitRole === 'button') && hasStructuredAffordance) {
        return 'Button';
      }
      if ((tag === 'a' || explicitRole === 'link') && hasStructuredAffordance) {
        return 'Link';
      }
      if (explicitRole === 'option') return 'Option';
      if (explicitRole === 'menuitem') return 'Menu item';
      if (explicitRole === 'gridcell') return 'Grid cell';
      return undefined;
    };

    const inferRole = (element) =>
      isHTMLElementNode(element) ? observedInferRole(element) || undefined : undefined;

    const kindOf = (element) => {
      const tag = element.tagName.toLowerCase();
      if (tag === 'input') return 'input';
      if (tag === 'textarea') return 'textarea';
      if (tag === 'select') return 'select';
      if (tag === 'a') return 'link';
      return inferRole(element) || tag;
    };

    const buildSelector = (element) => {
      const testIdAttributeOf = (candidate) => {
        if (candidate.hasAttribute('data-testid')) return 'data-testid';
        if (candidate.hasAttribute('data-test-id')) return 'data-test-id';
        return undefined;
      };
      const testIdSelectorOf = (candidate, value) => {
        const attribute = testIdAttributeOf(candidate);
        if (!attribute || !value) return undefined;
        return '[' + attribute + '="' + cssEscape(value) + '"]';
      };
      const queryRootOf = (candidate) => {
        const root = candidate.getRootNode?.();
        return root && typeof root.querySelectorAll === 'function' ? root : document;
      };

      const isSelectorUniqueFor = (candidate, selectorValue) => {
        const queryRoot = queryRootOf(candidate);
        try {
          const matches = Array.from(queryRoot.querySelectorAll(selectorValue));
          return matches.length === 1 && matches[0] === candidate;
        } catch {
          return false;
        }
      };

      if (element.id && isSelectorUniqueFor(element, '#' + cssEscape(element.id))) {
        return '#' + cssEscape(element.id);
      }

      const testId =
        element.getAttribute('data-testid')?.trim() || element.getAttribute('data-test-id')?.trim();
      if (testId) {
        const selectorValue = testIdSelectorOf(element, testId);
        if (isSelectorUniqueFor(element, selectorValue)) {
          return selectorValue;
        }
      }

      const name = element.getAttribute('name')?.trim();
      const tag = element.tagName.toLowerCase();
      if (name) {
        const selectorValue = tag + '[name="' + cssEscape(name) + '"]';
        if (isSelectorUniqueFor(element, selectorValue)) {
          return selectorValue;
        }
      }

      const segmentOf = (current) => {
        if (current.id && isSelectorUniqueFor(current, '#' + cssEscape(current.id))) {
          return '#' + cssEscape(current.id);
        }

        const currentTestId =
          current.getAttribute('data-testid')?.trim() ||
          current.getAttribute('data-test-id')?.trim();
        if (currentTestId) {
          const selectorValue = testIdSelectorOf(current, currentTestId);
          if (isSelectorUniqueFor(current, selectorValue)) {
            return selectorValue;
          }
        }

        const currentName = current.getAttribute('name')?.trim();
        const currentTag = current.tagName.toLowerCase();
        if (currentName) {
          const selectorValue = currentTag + '[name="' + cssEscape(currentName) + '"]';
          if (isSelectorUniqueFor(current, selectorValue)) {
            return selectorValue;
          }
        }

        const parent = current.parentElement;
        const root = current.getRootNode?.();
        const siblingPool = parent
          ? Array.from(parent.children)
          : isShadowRootNode(root)
            ? Array.from(root.children)
            : [];
        const siblings = siblingPool.filter((child) => child.tagName.toLowerCase() === currentTag);
        const index = siblings.indexOf(current) + 1;
        return currentTag + ':nth-of-type(' + Math.max(index, 1) + ')';
      };

      const path = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && path.length < 8) {
        path.unshift(segmentOf(current));
        if (current.id) {
          break;
        }
        current = current.parentElement;
      }
      if (path.length === 0) return undefined;

      const structuralSelector = path.join(' > ');
      return isSelectorUniqueFor(element, structuralSelector) ? structuralSelector : undefined;
    };

    const selectorFromRelation = (element, attribute) => {
      const relation = element.getAttribute(attribute)?.trim();
      if (!relation) return undefined;

      for (const id of relation.split(/\s+/)) {
        const related = document.getElementById(id);
        if (!isHTMLElementNode(related)) continue;
        const selector = buildSelector(related);
        if (selector) return selector;
      }

      return undefined;
    };

    const laneOf = (rect) => {
      const width = Math.max(window.innerWidth || 0, 1);
      const center = rect.left + rect.width / 2;
      if (center < width / 3) return 'left';
      if (center < (width * 2) / 3) return 'center';
      return 'right';
    };

    const bandOf = (rect) => {
      const height = Math.max(window.innerHeight || 0, 1);
      const center = rect.top + rect.height / 2;
      if (center < height / 3) return 'top';
      if (center < (height * 2) / 3) return 'middle';
      return 'bottom';
    };

    const readBooleanState = (element, attribute) => {
      const raw = element.getAttribute(attribute)?.trim();
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return undefined;
    };

    const parseColor = (value) => {
      if (!value || value === 'transparent') return null;

      const rgbaMatch = value.match(/rgba?\(([^)]+)\)/i);
      if (rgbaMatch) {
        const [r = '0', g = '0', b = '0', a = '1'] = rgbaMatch[1].split(',').map((part) => part.trim());
        return {
          r: Number(r),
          g: Number(g),
          b: Number(b),
          a: Number(a),
        };
      }

      const hexMatch = value.match(/^#([0-9a-f]{3,8})$/i);
      if (hexMatch) {
        const hex = hexMatch[1];
        if (hex.length === 3 || hex.length === 4) {
          const [r, g, b, a = 'f'] = hex.split('');
          return {
            r: Number.parseInt(r + r, 16),
            g: Number.parseInt(g + g, 16),
            b: Number.parseInt(b + b, 16),
            a: Number.parseInt(a + a, 16) / 255,
          };
        }
        if (hex.length === 6 || hex.length === 8) {
          return {
            r: Number.parseInt(hex.slice(0, 2), 16),
            g: Number.parseInt(hex.slice(2, 4), 16),
            b: Number.parseInt(hex.slice(4, 6), 16),
            a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
          };
        }
      }

      return null;
    };

    const luminanceOf = (color) => {
      if (!color || color.a <= 0) return null;
      return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
    };

    const visualOf = (element) => {
      const style = window.getComputedStyle(element);
      const background = parseColor(style.backgroundColor);
      const border = parseColor(style.borderColor);
      const backgroundLuminance = luminanceOf(background);
      const borderVisible = Boolean(border && border.a > 0.2 && style.borderStyle !== 'none' && Number.parseFloat(style.borderWidth || '0') > 0);

      let emphasis = 'normal';
      const opacity = Number.parseFloat(style.opacity || '1');
      const fontWeight = Number.parseInt(style.fontWeight || '400', 10);
      if (opacity < 0.7) {
        emphasis = 'muted';
      } else if (fontWeight >= 600) {
        emphasis = 'strong';
      }

      let fill = 'none';
      if (background && background.a > 0.05 && backgroundLuminance !== null) {
        if (backgroundLuminance <= 0.35) {
          fill = 'dark';
        } else if (backgroundLuminance <= 0.75) {
          fill = 'mid';
        } else {
          fill = 'light';
        }
      }

      return {
        emphasis,
        fill,
        outlined: borderVisible,
      };
    };

    const isStructuredContainer = (element) => {
      if (!isHTMLElementNode(element)) return false;

      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute('role')?.trim() || '';
      if (
        ['label', 'li', 'article', 'tr', 'fieldset', 'section', 'aside', 'form'].includes(tag) ||
        ['option', 'listitem', 'row', 'group', 'dialog', 'region', 'tabpanel', 'listbox', 'menu', 'grid'].includes(role)
      ) {
        return true;
      }

      const text = textOf(element, { container: true });
      if (!text) return false;

      const interactiveCount = element.querySelectorAll(selector).length;
      const hasHeading = Boolean(element.querySelector(headingSelector));
      return interactiveCount >= 2 && (hasHeading || text.length >= 40);
    };

    const hasSemanticInteractiveAncestor = (element) => {
      let current = composedParentElement(element);
      while (current) {
        if (current.matches?.(selector)) {
          return true;
        }
        current = composedParentElement(current);
      }
      return false;
    };

    const visibleInteractiveDescendantCountOf = (element) => {
      return Array.from(element.querySelectorAll(selector)).filter((candidate) => {
        return isHTMLElementNode(candidate) && isVisible(candidate);
      }).length;
    };

    const clickableSemanticBlobOf = (element) => {
      return [
        element.getAttribute('class') || '',
        Object.values(element.dataset || {}).join(' '),
        element.getAttribute('data-testid') || '',
        element.getAttribute('data-test-id') || '',
      ]
        .join(' ')
        .toLowerCase();
    };

    const viewportArea = () => {
      return Math.max(window.innerWidth || 0, 1) * Math.max(window.innerHeight || 0, 1);
    };

    const isBareFocusableClickTarget = (element) => {
      if (!isHTMLElementNode(element)) return false;
      if (!element.matches?.(selector)) return false;
      if (!element.hasAttribute('tabindex')) return false;

      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute('role')?.trim().toLowerCase() || '';
      if (role) return false;
      if (associatedChoiceControlOf(element)) return false;
      if (
        ['body', 'main', 'form', 'button', 'input', 'textarea', 'select', 'a', 'label'].includes(
          tag
        )
      ) {
        return false;
      }

      const contentEditable = element.getAttribute('contenteditable')?.trim().toLowerCase() || '';
      if (contentEditable === 'true' || contentEditable === 'plaintext-only') {
        return false;
      }

      const style = window.getComputedStyle(element);
      if (style.pointerEvents === 'none') return false;

      const rect = element.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (rect.width < 40 || rect.height < 20 || area < 1200) return false;

      const explicitClick =
        element.hasAttribute('onclick') || typeof element.onclick === 'function';
      const cursorClick = style.cursor === 'pointer';
      if (!explicitClick && !cursorClick) return false;

      const descriptorText = explicitLabelOf(element) || textOf(element) || syntheticLabelOf(element);
      if (!descriptorText) return false;

      const interactiveDescendants = visibleInteractiveDescendantCountOf(element);
      if (interactiveDescendants > 8) return false;
      if (!explicitClick && area >= viewportArea() * 0.75 && interactiveDescendants >= 2) {
        return false;
      }

      return true;
    };

    const isGenericClickableElement = (element) => {
      if (!isHTMLElementNode(element)) return false;
      if (element.matches?.(selector)) return false;
      if (hasSemanticInteractiveAncestor(element)) return false;

      const tag = element.tagName.toLowerCase();
      const associatedChoiceControl = associatedChoiceControlOf(element);
      if (['body', 'main', 'form'].includes(tag)) return false;
      if (tag === 'label' && !associatedChoiceControl) return false;

      const style = window.getComputedStyle(element);
      if (style.pointerEvents === 'none') return false;

      const rect = element.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (rect.width < 40 || rect.height < 20 || area < 1200) return false;

      const explicitClick =
        element.hasAttribute('onclick') || typeof element.onclick === 'function';
      const cursorClick = style.cursor === 'pointer';
      if (!explicitClick && !cursorClick) return false;

      const descriptorText = explicitLabelOf(element) || textOf(element) || syntheticLabelOf(element);
      if (!descriptorText) return false;

      const interactiveDescendants = visibleInteractiveDescendantCountOf(element);
      if (interactiveDescendants > 8) return false;
      if (!explicitClick && area >= viewportArea() * 0.75 && interactiveDescendants >= 2) {
        return false;
      }

      const structuredLike =
        isStructuredContainer(element) ||
        ['article', 'li'].includes(tag) ||
        /\b(card|item|result|fare|flight|ticket|offer|row)\b/.test(
          clickableSemanticBlobOf(element)
        );

      if (
        !structuredLike &&
        !explicitClick &&
        !associatedChoiceControl &&
        descriptorText.length < 12
      ) {
        return false;
      }

      return true;
    };

    const hasAcceptedGenericClickableAncestor = (element, accepted) => {
      return accepted.some((ancestor) => ancestor !== element && ancestor.contains(element));
    };

    const collectGenericClickableElements = (
      root,
      limit = collectorElementLimit,
      acc = [],
      seen = new Set()
    ) => {
      if (!root?.querySelectorAll || acc.length >= limit) {
        return acc;
      }

      const descendants = Array.from(root.querySelectorAll('*'));
      for (const candidate of descendants) {
        if (acc.length >= limit) break;
        if (!isHTMLElementNode(candidate) || seen.has(candidate)) continue;
        if (!isGenericClickableElement(candidate)) continue;
        if (hasAcceptedGenericClickableAncestor(candidate, acc)) continue;
        seen.add(candidate);
        acc.push(candidate);
      }

      for (const candidate of descendants) {
        if (acc.length >= limit) break;
        if (!isHTMLElementNode(candidate) || !candidate.shadowRoot) continue;
        collectGenericClickableElements(candidate.shadowRoot, limit, acc, seen);
      }

      return acc;
    };

    const containerOf = (element) => {
      let current = element.parentElement;
      let depth = 0;
      while (current && depth < 6) {
        if (isStructuredContainer(current)) {
          return current;
        }
        current = current.parentElement;
        depth += 1;
      }
      return undefined;
    };

    const groupOf = (element) => {
      if (element.matches?.(collectionSelector)) {
        return element;
      }

      return composedClosest(element, collectionSelector) || undefined;
    };

    const descriptiveItemOf = (element) => {
      const selfText = textOf(element);
      let current = composedParentElement(element);
      let depth = 0;

      while (current && depth < 5) {
        const currentText = textOf(current, { container: true });
        if (currentText && currentText !== selfText) {
          const interactiveCount = current.querySelectorAll(selector).length;
          const hasSiblingText = Array.from(current.children).some((child) => {
            if (!isHTMLElementNode(child)) return false;
            if (child === element || child.contains(element) || element.contains(child)) return false;
            return Boolean(textOf(child));
          });

          if (
            interactiveCount > 0 &&
            interactiveCount <= 4 &&
            currentText.length <= 180 &&
            (hasSiblingText || current.matches?.(itemSelector) || isStructuredContainer(current))
          ) {
            return current;
          }
        }

        current = composedParentElement(current);
        depth += 1;
      }

      return undefined;
    };

    const itemOf = (element) => {
      const descriptiveItem = descriptiveItemOf(element);
      if (descriptiveItem) {
        return descriptiveItem;
      }

      if (element.matches?.(itemSelector)) {
          const ancestorItem = composedClosest(composedParentElement(element), itemSelector);
        if (ancestorItem) {
          const selfText = textOf(element);
          const ancestorText = textOf(ancestorItem, { container: true });
          if (
            ancestorText &&
            ancestorText !== selfText &&
            ancestorText.length > (selfText?.length || 0)
          ) {
            return ancestorItem;
          }
        }

        return element;
      }

      return composedClosest(element, itemSelector) || undefined;
    };

    const directionalControlSelector =
      'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]';
    const weakDirectionalTextRe = /^[+\-<>‹›«»←→↑↓]+$/;

    const isButtonLikeDirectionalElement = (element) => {
      if (!isHTMLElementNode(element)) {
        return false;
      }

      const tag = element.tagName.toLowerCase();
      const role = (element.getAttribute('role') || '').trim().toLowerCase();
      if (tag === 'button') {
        return true;
      }
      if (tag === 'input') {
        return isButtonLikeInput(element);
      }
      return role === 'button';
    };

    const isWeakDirectionalText = (value) => {
      const normalized = normalizeDescriptorText(value || '');
      return Boolean(normalized) && weakDirectionalTextRe.test(normalized);
    };

    const directionalButtonsOf = (scope) => {
      if (!isHTMLElementNode(scope)) {
        return [];
      }

      return Array.from(scope.querySelectorAll(directionalControlSelector))
        .filter((candidate) => isHTMLElementNode(candidate))
        .filter((candidate) => isVisible(candidate))
        .filter((candidate) => isButtonLikeDirectionalElement(candidate))
        .slice(0, 6);
    };

    const directionalChildTextCandidatesOf = (scope, exclude = []) => {
      if (!isHTMLElementNode(scope)) {
        return [];
      }

      const excluded = exclude.filter((candidate) => isHTMLElementNode(candidate));
      const candidates = [];
      for (const child of Array.from(scope.children).slice(0, 12)) {
        if (!isHTMLElementNode(child) || !isVisible(child)) {
          continue;
        }
        if (
          excluded.some(
            (candidate) =>
              child === candidate || child.contains(candidate) || candidate.contains(child)
          )
        ) {
          continue;
        }
        if (isButtonLikeDirectionalElement(child)) {
          continue;
        }
        if (directionalButtonsOf(child).length > 0) {
          continue;
        }

        const text = normalizeDescriptorText(textOf(child, { container: true }) || '');
        if (!text || text.length > 48) {
          continue;
        }

        candidates.push({
          element: child,
          text,
          rect: child.getBoundingClientRect(),
        });
      }

      return candidates;
    };

    const directionalAxisOf = (buttons) => {
      if (buttons.length !== 2) {
        return undefined;
      }

      const firstRect = buttons[0].getBoundingClientRect();
      const secondRect = buttons[1].getBoundingClientRect();
      const deltaX = Math.abs(
        firstRect.left + firstRect.width / 2 - (secondRect.left + secondRect.width / 2)
      );
      const deltaY = Math.abs(
        firstRect.top + firstRect.height / 2 - (secondRect.top + secondRect.height / 2)
      );
      return deltaX >= deltaY ? 'horizontal' : 'vertical';
    };

    const orderedDirectionalButtonsOf = (buttons, axis) => {
      return [...buttons].sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return axis === 'vertical'
          ? leftRect.top - rightRect.top
          : leftRect.left - rightRect.left;
      });
    };

    const directionalPositionOf = (element, orderedButtons, axis) => {
      if (orderedButtons.length !== 2) {
        return undefined;
      }

      if (orderedButtons[0] === element) {
        return axis === 'vertical' ? 'upper' : 'leading';
      }
      if (orderedButtons[1] === element) {
        return axis === 'vertical' ? 'lower' : 'trailing';
      }
      return undefined;
    };

    const directionalAnchorCandidateOf = (cluster, orderedButtons, axis) => {
      if (!isHTMLElementNode(cluster) || orderedButtons.length !== 2) {
        return undefined;
      }

      const firstRect = orderedButtons[0].getBoundingClientRect();
      const secondRect = orderedButtons[1].getBoundingClientRect();
      const midpointX =
        (firstRect.left + firstRect.width / 2 + (secondRect.left + secondRect.width / 2)) / 2;
      const midpointY =
        (firstRect.top + firstRect.height / 2 + (secondRect.top + secondRect.height / 2)) / 2;

      const candidates = directionalChildTextCandidatesOf(cluster, orderedButtons)
        .filter((candidate) => {
          const centerX = candidate.rect.left + candidate.rect.width / 2;
          const centerY = candidate.rect.top + candidate.rect.height / 2;
          if (axis === 'vertical') {
            return (
              centerY >= Math.min(midpointY, secondRect.top + secondRect.height / 2) - 40 &&
              centerY <= Math.max(midpointY, firstRect.top + firstRect.height / 2) + 40 &&
              Math.abs(centerX - midpointX) <= Math.max(40, firstRect.width * 1.5)
            );
          }

          return (
            centerX >= Math.min(firstRect.left + firstRect.width / 2, midpointX) - 40 &&
            centerX <= Math.max(secondRect.left + secondRect.width / 2, midpointX) + 40 &&
            Math.abs(centerY - midpointY) <= Math.max(32, firstRect.height * 1.5)
          );
        })
        .sort((left, right) => {
          const leftCenterX = left.rect.left + left.rect.width / 2;
          const leftCenterY = left.rect.top + left.rect.height / 2;
          const rightCenterX = right.rect.left + right.rect.width / 2;
          const rightCenterY = right.rect.top + right.rect.height / 2;
          const leftDistance = Math.hypot(leftCenterX - midpointX, leftCenterY - midpointY);
          const rightDistance = Math.hypot(rightCenterX - midpointX, rightCenterY - midpointY);
          return leftDistance - rightDistance;
        });

      return candidates[0];
    };

    const stepperGroupLabelOf = (element, cluster, axis, anchorText) => {
      const scopes = [];
      const parent = composedParentElement(cluster);
      const grandParent = composedParentElement(parent);
      const item = itemOf(element);

      for (const scope of [parent, item, grandParent]) {
        if (
          isHTMLElementNode(scope) &&
          scope !== cluster &&
          !scopes.includes(scope)
        ) {
          scopes.push(scope);
        }
      }

      const anchorMonthLike = Boolean(
        inferDirectionalControlFallbackFromEvidence({
          kind: 'button',
          anchorText,
          position: 'leading',
        })
      );

      for (const scope of scopes) {
        const scopeRect = cluster.getBoundingClientRect();
        const clusterCenterX = scopeRect.left + scopeRect.width / 2;
        const clusterCenterY = scopeRect.top + scopeRect.height / 2;
        const ranked = directionalChildTextCandidatesOf(scope, [cluster])
          .filter((candidate) => candidate.text !== anchorText)
          .filter((candidate) => !/^\d{1,3}$/.test(candidate.text))
          .filter(
            (candidate) =>
              !Boolean(
                inferDirectionalControlFallbackFromEvidence({
                  kind: 'button',
                  anchorText: candidate.text,
                  position: 'leading',
                })
              ) || !anchorMonthLike
          )
          .sort((left, right) => {
            const leftRect = left.rect;
            const rightRect = right.rect;
            const leftCenterX = leftRect.left + leftRect.width / 2;
            const leftCenterY = leftRect.top + leftRect.height / 2;
            const rightCenterX = rightRect.left + rightRect.width / 2;
            const rightCenterY = rightRect.top + rightRect.height / 2;
            const leftBias =
              axis === 'vertical'
                ? leftRect.bottom <= scopeRect.top + 16
                  ? 0
                  : leftRect.right <= scopeRect.left + 16
                    ? 1
                    : 2
                : leftRect.right <= scopeRect.left + 16
                  ? 0
                  : leftRect.bottom <= scopeRect.top + 16
                    ? 1
                    : 2;
            const rightBias =
              axis === 'vertical'
                ? rightRect.bottom <= scopeRect.top + 16
                  ? 0
                  : rightRect.right <= scopeRect.left + 16
                    ? 1
                    : 2
                : rightRect.right <= scopeRect.left + 16
                  ? 0
                  : rightRect.bottom <= scopeRect.top + 16
                    ? 1
                    : 2;
            if (leftBias !== rightBias) {
              return leftBias - rightBias;
            }
            const leftDistance = Math.hypot(leftCenterX - clusterCenterX, leftCenterY - clusterCenterY);
            const rightDistance = Math.hypot(rightCenterX - clusterCenterX, rightCenterY - clusterCenterY);
            if (leftDistance !== rightDistance) {
              return leftDistance - rightDistance;
            }
            return left.text.length - right.text.length;
          });

        const subject = ranked[0]?.text;
        if (subject) {
          return subject;
        }
      }

      return undefined;
    };

    const directionalControlFallbackLabelOf = (element, directFallbackLabel) => {
      if (!isButtonLikeDirectionalElement(element)) {
        return undefined;
      }
      if (directFallbackLabel && !isWeakDirectionalText(directFallbackLabel)) {
        return undefined;
      }

      let current = composedParentElement(element);
      let depth = 0;
      while (current && depth < 4) {
        if (!isHTMLElementNode(current) || !isVisible(current)) {
          current = composedParentElement(current);
          depth += 1;
          continue;
        }

        const buttons = directionalButtonsOf(current);
        if (buttons.length !== 2 || !buttons.includes(element)) {
          current = composedParentElement(current);
          depth += 1;
          continue;
        }

        const axis = directionalAxisOf(buttons);
        if (!axis) {
          return undefined;
        }
        const orderedButtons = orderedDirectionalButtonsOf(buttons, axis);
        const position = directionalPositionOf(element, orderedButtons, axis);
        const anchorCandidate = directionalAnchorCandidateOf(current, orderedButtons, axis);
        const anchorText = anchorCandidate?.text;
        if (!position || !anchorText) {
          return undefined;
        }

        const groupLabel = /^\d{1,3}$/.test(anchorText)
          ? stepperGroupLabelOf(element, current, axis, anchorText)
          : undefined;
        const fallbackLabel = inferDirectionalControlFallbackFromEvidence({
          kind: element.tagName.toLowerCase(),
          role: element.getAttribute('role')?.trim() || undefined,
          groupLabel,
          anchorText,
          position,
        });
        if (fallbackLabel) {
          return fallbackLabel;
        }

        return undefined;
      }

      return undefined;
    };

    const normalizeText = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();

    const VALIDATION_CLASS_RE = /\b(?:error|invalid|warning|danger|alert|failed)\b/i;
    const validationFieldSelectors =
      'input, textarea, select, [role="textbox"], [contenteditable="true"], [aria-invalid="true"]';

    const relatedValidationMessagesOf = (element) => {
      if (!isHTMLElementNode(element)) {
        return [];
      }

      const values = [];
      const pushMessage = (value) => {
        const text = normalizeDescriptorText(value || '');
        if (!text || !VALIDATION_TEXT_RE.test(text)) {
          return;
        }
        if (values.includes(text)) {
          return;
        }
        values.push(text.slice(0, 240));
        if (values.length > 4) {
          values.length = 4;
        }
      };

      const describedBy = describedByTextOf(element);
      if (describedBy) {
        pushMessage(describedBy);
      }

      let anchor = element.parentElement;
      for (let depth = 0; anchor && depth < 4 && values.length < 4; depth += 1, anchor = anchor.parentElement) {
        const anchorFieldCount = anchor.querySelectorAll(validationFieldSelectors).length;
        if (anchorFieldCount === 0 || anchorFieldCount > 3) {
          continue;
        }

        for (const candidate of Array.from(anchor.children)) {
          if (!isHTMLElementNode(candidate)) {
            continue;
          }
          if (candidate === element || candidate.contains(element) || element.contains(candidate)) {
            continue;
          }
          if (!isVisible(candidate) || candidate.matches('label, legend')) {
            continue;
          }
          if (candidate.querySelector(validationFieldSelectors)) {
            continue;
          }
          pushMessage(textOf(candidate, { container: true }));
        }
      }

      return values;
    };

    const hasValidationStyling = (element) => {
      if (!isHTMLElementNode(element)) {
        return false;
      }

      let node = element;
      for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
        const classBlob =
          (node.getAttribute('class') || '') +
          ' ' +
          Object.values(node.dataset || {}).join(' ') +
          ' ' +
          (node.getAttribute('data-state') || '') +
          ' ' +
          (node.getAttribute('data-status') || '');
        if (VALIDATION_CLASS_RE.test(classBlob.toLowerCase())) {
          return true;
        }
      }

      return false;
    };

    const validationEvidenceOf = (element) => {
      if (!isHTMLElementNode(element)) {
        return undefined;
      }

      const required =
        element.getAttribute('aria-required') === 'true' ||
        (isHTMLInputNode(element) || isHTMLTextAreaNode(element) || isHTMLSelectNode(element)
          ? element.required
          : false);
      const invalid =
        element.getAttribute('aria-invalid') === 'true' ||
        ((isHTMLInputNode(element) || isHTMLTextAreaNode(element) || isHTMLSelectNode(element)) &&
          !element.checkValidity());
      const messages = relatedValidationMessagesOf(element);
      const errorStyling = hasValidationStyling(element);
      const message = messages[0];

      if (!required && !invalid && !errorStyling && !message) {
        return undefined;
      }

      return {
        invalid: invalid || undefined,
        required: required || undefined,
        message,
        errorStyling: errorStyling || undefined,
      };
    };

    const stateOf = (element) => {
      const states = {};
      const associatedChoiceControl = associatedChoiceControlOf(element);
      const role = inferRole(element) || inferRole(associatedChoiceControl);
      const tag = element.tagName.toLowerCase();

      const ariaDisabled = readBooleanState(element, 'aria-disabled');
      if (ariaDisabled !== undefined) states.disabled = ariaDisabled;

      if (element.matches?.(':disabled')) {
        states.disabled = true;
      }

      const style = window.getComputedStyle(element);
      if (style.pointerEvents === 'none') {
        states.disabled = true;
      }

      const ariaSelected = readBooleanState(element, 'aria-selected');
      if (ariaSelected !== undefined) states.selected = ariaSelected;

      const ariaExpanded = readBooleanState(element, 'aria-expanded');
      if (ariaExpanded !== undefined) states.expanded = ariaExpanded;

      const ariaPressed = readBooleanState(element, 'aria-pressed');
      if (ariaPressed !== undefined) states.pressed = ariaPressed;

      const ariaBusy = readBooleanState(element, 'aria-busy');
      if (ariaBusy !== undefined) states.busy = ariaBusy;

      const ariaReadonly = readBooleanState(element, 'aria-readonly');
      if (ariaReadonly !== undefined) states.readonly = ariaReadonly;

      const ariaChecked = element.getAttribute('aria-checked')?.trim();
      if (ariaChecked === 'true') states.checked = true;
      else if (ariaChecked === 'false') states.checked = false;
      else if (ariaChecked === 'mixed') states.checked = 'mixed';

      const ariaCurrent = element.getAttribute('aria-current')?.trim();
      if (ariaCurrent) {
        states.current = ariaCurrent === 'true' ? true : ariaCurrent;
      }

      if (isHTMLSelectNode(element) && typeof element.selectedIndex === 'number' && element.selectedIndex > 0) {
        states.hasSelection = true;
      }

      const className = (element.getAttribute('class') || '').toLowerCase();
      const dataset = Object.values(element.dataset || {})
        .join(' ')
        .toLowerCase();
      const dataState = (element.getAttribute('data-state') || '').toLowerCase();
      const dataStatus = (element.getAttribute('data-status') || '').toLowerCase();
      const ariaLabel = (element.getAttribute('aria-label') || '').toLowerCase();
      const semanticBlob = className + ' ' + dataset + ' ' + dataState + ' ' + dataStatus + ' ' + ariaLabel;
      const inputType = isHTMLInputNode(element) ? (element.type || '').toLowerCase() : undefined;

      if (/(?:selected|active|current)\b/.test(semanticBlob)) {
        if (states.selected === undefined) states.selected = true;
        if (states.current === undefined) states.current = true;
      }
      if (
        inferDisabledStateFromSemanticEvidence({
          tagName: tag,
          role,
          inputType,
          className,
          datasetText: dataset,
          dataState,
          dataStatus,
          ariaLabel,
        })
      ) {
        states.disabled = true;
        states.selectable = false;
      }
      if (/(?:occupied|unavailable|sold|taken|reserved|booked)\b/.test(semanticBlob)) {
        states.occupied = true;
        states.selectable = false;
        states.disabled = true;
      }
      if (/(?:premium|extra-legroom|comfort|preferred)\b/.test(semanticBlob)) {
        states.premium = true;
      }
      if (states.selectable === undefined && states.disabled !== true && states.occupied !== true) {
        if (role === 'gridcell' || tag === 'button') {
          states.selectable = true;
        }
      }

      if (isHTMLInputNode(element)) {
        const type = (element.type || 'text').toLowerCase();
        if (type === 'checkbox' || type === 'radio') {
          states.checked = element.indeterminate ? 'mixed' : element.checked;
        }
        if (element.readOnly) {
          states.readonly = true;
        }
      }

      if (isHTMLInputNode(associatedChoiceControl)) {
        const type = (associatedChoiceControl.type || 'text').toLowerCase();
        if (type === 'checkbox' || type === 'radio') {
          states.checked = associatedChoiceControl.indeterminate
            ? 'mixed'
            : associatedChoiceControl.checked;
        }
        if (associatedChoiceControl.disabled) {
          states.disabled = true;
        }
        if (associatedChoiceControl.readOnly) {
          states.readonly = true;
        }
      }

      if (isHTMLTextAreaNode(element) && element.readOnly) {
        states.readonly = true;
      }

      if (isHTMLSelectNode(element) && element.disabled) {
        states.disabled = true;
      }

      return Object.keys(states).length > 0 ? states : undefined;
    };

    const inferStructuredCell = (element, surface) => {
      if (!isHTMLElementNode(element)) return undefined;

      const role = inferRole(element) || '';
      const className = (element.getAttribute('class') || '').toLowerCase();
      const surfaceKind = inferSurfaceKind(surface);
      const seatValueLabel =
        element.getAttribute('data-seat-value')?.trim() ||
        element.getAttribute('data-seat')?.trim() ||
        undefined;
      const label =
        explicitLabelOf(element) || textOf(element) || seatValueLabel || syntheticLabelOf(element) || '';
      const normalizedLabel = label.replace(/\s+/g, ' ').trim();
      const explicitDateCellMetadata =
        element.hasAttribute('data-day') ||
        element.hasAttribute('data-date') ||
        element.hasAttribute('data-iso') ||
        element.hasAttribute('aria-rowindex') ||
        element.hasAttribute('aria-colindex') ||
        Boolean(
          composedClosest(
            element,
            '[data-day], [data-date], [data-iso], [aria-rowindex], [aria-colindex]'
          )
        );
      const structuredCellVariant = inferStructuredCellVariantFromEvidence({
        role,
        surfaceKind,
        normalizedLabel,
        className,
        hasSeatAttribute: element.hasAttribute('data-seat'),
        hasSeatRowAttribute: element.hasAttribute('data-row'),
        hasSeatColumnAttribute: element.hasAttribute('data-column'),
        hasDateMetadata: explicitDateCellMetadata,
      });

      if (!structuredCellVariant) {
        return undefined;
      }

      const row =
        element.getAttribute('aria-rowindex')?.trim() ||
        element.getAttribute('data-row')?.trim() ||
        composedClosest(element, '[aria-rowindex]')?.getAttribute?.('aria-rowindex')?.trim() ||
        label.match(/\b(\d{1,3})[a-z]\b/i)?.[1] ||
        undefined;
      const column =
        element.getAttribute('aria-colindex')?.trim() ||
        element.getAttribute('data-column')?.trim() ||
        label.match(/\b\d{1,3}([a-z])\b/i)?.[1]?.toUpperCase() ||
        undefined;
      const zone =
        element.getAttribute('data-zone')?.trim() ||
        composedClosest(element, '[data-zone]')?.getAttribute?.('data-zone')?.trim() ||
        contextNodeOf(groupOf(element))?.label ||
        contextNodeOf(containerOf(element))?.label ||
        undefined;

      return {
        family: 'structured-grid',
        variant: structuredCellVariant,
        row,
        column,
        zone,
        cellLabel: label || undefined,
      };
    };

    const modalBackdropAncestorOf = (surface) => {
      let current = surface?.parentElement;
      let depth = 0;
      while (current && depth < 6) {
        if (isHTMLElementNode(current) && isVisible(current)) {
          const style = window.getComputedStyle(current);
          const position = (style.position || '').toLowerCase();
          const rect = current.getBoundingClientRect();
          const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
          const coverage = (rect.width * rect.height) / viewportArea;
          if (
            position === 'fixed' &&
            coverage > 0.45 &&
            (style.backgroundColor &&
              style.backgroundColor !== 'transparent' &&
              style.backgroundColor !== 'rgba(0, 0, 0, 0)')
          ) {
            return current;
          }
        }

        current = current.parentElement;
        depth += 1;
      }

      return undefined;
    };

    const siblingModalBackdropOf = (surface) => {
      let current = surface;
      let depth = 0;
      while (current && depth < 16) {
        const parent = composedParentElement(current);
        if (isHTMLElementNode(parent)) {
          const siblings = Array.from(parent.children).filter(
            (candidate) => candidate !== current && isHTMLElementNode(candidate)
          );
          for (const sibling of siblings) {
            if (!isVisible(sibling)) {
              continue;
            }

            const style = window.getComputedStyle(sibling);
            const position = (style.position || '').toLowerCase();
            const rect = sibling.getBoundingClientRect();
            const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
            const coverage = (rect.width * rect.height) / viewportArea;
            const backgroundVisible =
              style.backgroundColor &&
              style.backgroundColor !== 'transparent' &&
              style.backgroundColor !== 'rgba(0, 0, 0, 0)';
            const opacity = parseFloat(style.opacity || '1');

            if (
              position === 'fixed' &&
              coverage > 0.45 &&
              backgroundVisible &&
              opacity >= 0.05
            ) {
              return sibling;
            }
          }
        }

        current = parent;
        depth += 1;
      }

      return undefined;
    };

    const surfacePositionTraitsOf = (surface) => {
      if (!isHTMLElementNode(surface) || !isVisible(surface)) return undefined;

      const style = window.getComputedStyle(surface);
      const position = (style.position || '').toLowerCase();
      const rect = surface.getBoundingClientRect();
      const interactiveCount = visibleInteractiveDescendantCountOf(surface);
      const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
      const coverage = (rect.width * rect.height) / viewportArea;
      const zIndexValue = Number(style.zIndex || '0');
      const hasCardChrome =
        style.boxShadow !== 'none' ||
        parseFloat(style.borderTopWidth || '0') > 0 ||
        parseFloat(style.borderRightWidth || '0') > 0 ||
        parseFloat(style.borderBottomWidth || '0') > 0 ||
        parseFloat(style.borderLeftWidth || '0') > 0 ||
        (style.backgroundColor &&
          style.backgroundColor !== 'transparent' &&
          style.backgroundColor !== 'rgba(0, 0, 0, 0)');

      if (rect.width < 180 || rect.height < 72 || interactiveCount < 1 || coverage > 0.45) {
        return undefined;
      }

      if (position === 'fixed') {
        return { kind: 'floating-panel', priority: 92 };
      }

      if (position === 'sticky') {
        return { kind: 'sticky-panel', priority: 88 };
      }

      if (position === 'absolute' && hasCardChrome && zIndexValue > 0) {
        return { kind: 'floating-panel', priority: 82 };
      }

      if (
        hasCardChrome &&
        coverage <= 0.35 &&
        interactiveCount >= 1 &&
        (modalBackdropAncestorOf(surface) || siblingModalBackdropOf(surface))
      ) {
        return { kind: 'floating-panel', priority: 90 };
      }

      return undefined;
    };

    const inferSurfaceKind = (surface) => {
      if (!isHTMLElementNode(surface)) return undefined;
      const positionedSurface = surfacePositionTraitsOf(surface);
      if (positionedSurface?.kind) return positionedSurface.kind;
      const role = surface.getAttribute('role')?.trim();
      if (role === 'dialog') return 'dialog';
      if (role === 'listbox') return 'listbox';
      if (role === 'menu') return 'menu';
      if (role === 'grid') return 'grid';
      if (role === 'tabpanel') return 'tabpanel';
      if (isGenericClickableElement(surface) && isStructuredContainer(surface)) return 'card';
      const className = (surface.getAttribute('class') || '').toLowerCase();
      if (className.includes('calendar') || className.includes('datepicker')) return 'datepicker';
      if (className.includes('popover')) return 'popover';
      if (className.includes('dropdown')) return 'dropdown';
      const tag = surface.tagName.toLowerCase();
      if (tag === 'article') return 'card';
      if (tag === 'fieldset') return 'group';
      if (tag === 'li') return 'listitem';
      if (tag === 'section' || tag === 'form' || tag === 'aside') return tag;
      return role || surface.tagName.toLowerCase();
    };

    const labelledByTextOf = (element) => {
      if (!isHTMLElementNode(element)) {
        return undefined;
      }

      const ariaLabelledby = element.getAttribute('aria-labelledby')?.trim();
      if (!ariaLabelledby) {
        return undefined;
      }

      const labelledByText = normalizeDescriptorText(
        ariaLabelledby
          .split(/\s+/)
          .map((id) => textOf(document.getElementById(id)))
          .filter(Boolean)
          .join(' ')
      );
      return labelledByText || undefined;
    };

    const headingLikeSelector = headingSelector + ', strong';

    const descendantHeadingLabelOf = (element) => {
      if (!isHTMLElementNode(element)) {
        return undefined;
      }

      const heading = element.querySelector(headingLikeSelector);
      if (!isHTMLElementNode(heading) || !isVisible(heading)) {
        return undefined;
      }

      return normalizeDescriptorText(heading.innerText || heading.textContent || '') || undefined;
    };

    const directSemanticLabelOf = (element) => {
      if (!isHTMLElementNode(element)) {
        return undefined;
      }

      const directLabel = normalizeDescriptorText(
        element.getAttribute('aria-label') ||
          element.getAttribute('title') ||
          labelledByTextOf(element) ||
          ''
      );
      if (directLabel) {
        return directLabel;
      }

      return descendantHeadingLabelOf(element);
    };

    const isCollectionLikeSurfaceElement = (element) => {
      if (!isHTMLElementNode(element) || !isVisible(element)) {
        return false;
      }

      const role = (element.getAttribute('role') || '').trim().toLowerCase();
      if (
        role === 'grid' ||
        role === 'listbox' ||
        role === 'menu' ||
        role === 'tabpanel' ||
        role === 'tablist'
      ) {
        return true;
      }

      const className = (element.getAttribute('class') || '').toLowerCase();
      if (className.includes('calendar') || className.includes('datepicker')) {
        return true;
      }

      const tag = element.tagName.toLowerCase();
      return (
        tag === 'table' ||
        tag === 'form' ||
        tag === 'fieldset' ||
        tag === 'ul' ||
        tag === 'ol'
      );
    };

    const primaryCollectionChildOf = (element) => {
      if (!isHTMLElementNode(element) || !isVisible(element)) {
        return undefined;
      }

      const directCollectionChildren = Array.from(element.children).filter(
        (child) => isHTMLElementNode(child) && isCollectionLikeSurfaceElement(child)
      );
      return directCollectionChildren.length === 1 ? directCollectionChildren[0] : undefined;
    };

    const inheritedSemanticLabelOf = (surface) => {
      if (!isHTMLElementNode(surface)) {
        return undefined;
      }

      let current = composedParentElement(surface);
      let depth = 0;
      while (current && depth < 2) {
        if (!isHTMLElementNode(current) || !isVisible(current)) {
          current = composedParentElement(current);
          depth += 1;
          continue;
        }

        const contextLabel = directSemanticLabelOf(current);
        const primaryCollectionChild = primaryCollectionChildOf(current);
        if (
          contextLabel &&
          isHTMLElementNode(primaryCollectionChild) &&
          (primaryCollectionChild === surface || primaryCollectionChild.contains(surface))
        ) {
          return contextLabel;
        }

        current = composedParentElement(current);
        depth += 1;
      }

      return undefined;
    };

    const surfaceFallbackLabelOf = (surface, surfaceKind) => {
      if (!isHTMLElementNode(surface)) {
        return undefined;
      }

      const kind = (surfaceKind || '').toLowerCase();
      const overlayLike =
        kind === 'dialog' ||
        kind === 'floating-panel' ||
        kind === 'sticky-panel' ||
        kind === 'listbox' ||
        kind === 'menu' ||
        kind === 'grid' ||
        kind === 'tabpanel' ||
        kind === 'popover' ||
        kind === 'dropdown' ||
        kind === 'datepicker' ||
        kind === 'form';
      if (!overlayLike) {
        return undefined;
      }

      return directSemanticLabelOf(surface) || inheritedSemanticLabelOf(surface);
    };

    const contextLabelOf = (element) => {
      if (!isHTMLElementNode(element)) {
        return undefined;
      }

      return directSemanticLabelOf(element);
    };

    const contextTextOf = (element) => {
      if (!isHTMLElementNode(element)) {
        return undefined;
      }

      const text = textOf(element, { container: true });
      if (!text) {
        return undefined;
      }
      return text.length <= 140 ? text : text.slice(0, 140);
    };

    const contextNodeOf = (element) => {
      if (!element) return undefined;

      const kind = element.getAttribute?.('role')?.trim() || element.tagName?.toLowerCase?.();
      const fallbackLabel = contextLabelOf(element);
      const text = contextTextOf(element);
      const selector = buildSelector(element);
      if (!kind && !fallbackLabel && !text && !selector) return undefined;
      return {
        kind: kind || undefined,
        label: fallbackLabel,
        text:
          text && (!fallbackLabel || text.toLowerCase() !== fallbackLabel.toLowerCase())
            ? text
            : undefined,
        selector,
        fallbackLabel,
      };
    };

    const pageSignature =
      inheritedPageSignature ||
      (() => {
        try {
          const url = new URL(window.location.href);
          return url.origin + url.pathname;
        } catch {
          return window.location.href;
        }
      })();

    const collectTargets = (doc) => {
      const seenElements = new Set();
      const overlaySurfaceSelector =
        '[role="dialog"], [aria-modal="true"], [role="listbox"], [role="menu"], [role="grid"], [role="tabpanel"], [class*="popover"], [class*="dropdown"], [class*="listbox"], [class*="calendar"], [class*="datepicker"]';

      const compactText = (value) => (value || '').replace(/\s+/g, ' ').trim();

      const surfacePriorityOf = (surface) => {
        if (!isHTMLElementNode(surface)) return 0;
        const positionedSurface = surfacePositionTraitsOf(surface);
        if (positionedSurface?.priority) return positionedSurface.priority;
        const role = surface.getAttribute('role')?.trim() || '';
        const className = (surface.getAttribute('class') || '').toLowerCase();
        if (role === 'dialog' || surface.getAttribute('aria-modal') === 'true') return 100;
        if (role === 'listbox' || role === 'menu') return 95;
        if (className.includes('calendar') || className.includes('datepicker')) return 90;
        if (className.includes('popover') || className.includes('dropdown')) return 85;
        if (role === 'grid' || role === 'tabpanel') return 80;
        if (isGenericClickableElement(surface) && isStructuredContainer(surface)) {
          const interactiveCount = visibleInteractiveDescendantCountOf(surface);
          return interactiveCount >= 1 && interactiveCount <= 6 ? 58 : 54;
        }
        const tag = surface.tagName.toLowerCase();
        const interactiveCount = surface.querySelectorAll(selector).length;
        if (tag === 'article' || tag === 'fieldset') return interactiveCount >= 2 ? 65 : 55;
        if (role === 'group' || role === 'region') return interactiveCount >= 2 ? 60 : 50;
        if (tag === 'li' || role === 'listitem' || role === 'row') return interactiveCount >= 2 ? 58 : 48;
        if (tag === 'section' || tag === 'form' || tag === 'aside') {
          return interactiveCount >= 2 && interactiveCount <= 8 ? 52 : 0;
        }
        return 0;
      };

      const surfaceKindOf = inferSurfaceKind;

      const visualSeatGridMeta = new WeakMap();

      const isPotentialVisualGridSurface = (element) => {
        if (!isHTMLElementNode(element) || !isVisible(element)) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        if (rect.width < 220 || rect.height < 160) {
          return false;
        }

        const role = element.getAttribute('role')?.trim() || '';
        const tag = element.tagName.toLowerCase();
        return (
          role === 'grid' ||
          ['article', 'section', 'main', 'form', 'aside', 'div'].includes(tag)
        );
      };

      const isVisualGridTokenElement = (element) => {
        if (!isHTMLElementNode(element) || !isVisible(element)) {
          return false;
        }
        if (element.matches?.(selector)) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 16 || rect.width > 88 || rect.height > 56) {
          return false;
        }
        const text = compactText(textOf(element));
        const axisLabelLike = /^\d{1,3}$/.test(text) || /^[a-z]$/i.test(text);
        const shorterSide = Math.min(rect.width, rect.height);
        const longerSide = Math.max(rect.width, rect.height);
        if (shorterSide <= 0 || longerSide / shorterSide > (axisLabelLike ? 4.5 : 2.6)) {
          return false;
        }
        if (rect.width * rect.height < 576) {
          return false;
        }

        return true;
      };

      const visualSeatGridTokenKindOf = (element) => {
        const text = compactText(textOf(element));
        if (!text) {
          return undefined;
        }
        if (/^\d{1,3}$/.test(text)) {
          return 'row';
        }
        if (/^[a-z]$/i.test(text)) {
          return 'column';
        }
        return undefined;
      };

      const visualSeatCellStateOf = (element) => {
        const style = window.getComputedStyle(element);
        const background = parseColor(style.backgroundColor);
        const hasFilledBackground = Boolean(background && background.a > 0.15);
        const glyphCount = element.querySelectorAll(
          'svg, path, use, circle, line, polyline, polygon'
        ).length;
        const states = {};
        const pointerEventsDisabled = style.pointerEvents === 'none';

        if (pointerEventsDisabled) {
          states.disabled = true;
          states.selectable = false;
        }

        if (glyphCount > 0 && !hasFilledBackground) {
          states.occupied = true;
          states.selectable = false;
          states.disabled = true;
          return states;
        }

        if (!pointerEventsDisabled) {
          states.selectable = true;
        }
        if (glyphCount > 0 && hasFilledBackground) {
          states.selected = true;
        }

        if (background && background.a > 0.15) {
          const warm = background.r > background.b + 40 && background.g > 60;
          if (warm) {
            states.premium = true;
          }
        }

        return states;
      };

      const visualSeatIdentityOf = (element) => {
        const explicitRow = element.getAttribute('data-row')?.trim();
        const explicitColumn = element.getAttribute('data-column')?.trim().toUpperCase();
        if (explicitRow && explicitColumn) {
          return {
            row: explicitRow,
            column: explicitColumn,
            label: explicitRow + explicitColumn,
          };
        }

        const candidates = [
          element.getAttribute('data-seat-value'),
          element.getAttribute('data-seat'),
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
        ];

        for (const candidate of candidates) {
          const normalized = compactText(candidate);
          if (!normalized) {
            continue;
          }

          const rowColumnMatch = normalized.match(/(?:^|\b)(\d{1,3})\s*([a-z])(?:\b|$)/i);
          if (rowColumnMatch) {
            const row = rowColumnMatch[1];
            const column = rowColumnMatch[2].toUpperCase();
            return {
              row,
              column,
              label: row + column,
            };
          }

          const columnRowMatch = normalized.match(/(?:^|\b)([a-z])\s*(\d{1,3})(?:\b|$)/i);
          if (columnRowMatch) {
            const row = columnRowMatch[2];
            const column = columnRowMatch[1].toUpperCase();
            return {
              row,
              column,
              label: row + column,
            };
          }
        }

        return undefined;
      };

      const isVisualSeatCellElement = (element) => {
        if (!isVisualGridTokenElement(element)) {
          return false;
        }
        if (hasSemanticInteractiveAncestor(element)) {
          return false;
        }

        const text = compactText(textOf(element));
        if (text) {
          return false;
        }

        const style = window.getComputedStyle(element);
        const background = parseColor(style.backgroundColor);
        const border = parseColor(style.borderColor);
        const glyphCount = element.querySelectorAll(
          'svg, path, use, circle, line, polyline, polygon'
        ).length;
        const borderVisible =
          Boolean(border && border.a > 0.2) &&
          style.borderStyle !== 'none' &&
          Number.parseFloat(style.borderWidth || '0') > 0;
        const backgroundVisible = Boolean(background && background.a > 0.15);

        if (!backgroundVisible && !borderVisible && glyphCount === 0) {
          return false;
        }
        if (element.children.length > 3) {
          return false;
        }

        return true;
      };

      const visualSeatGridOwnerSurfaceOf = (surface) => {
        let preferredArticle = undefined;
        let preferredSection = undefined;
        let preferredFallback = undefined;
        let current = surface;
        let depth = 0;
        while (current && depth < 8) {
          if (!isHTMLElementNode(current) || !isVisible(current)) {
            current = current?.parentElement ?? null;
            depth += 1;
            continue;
          }

          const tag = current.tagName.toLowerCase();
          if (tag === 'article' && !preferredArticle) {
            preferredArticle = current;
          } else if (tag === 'section' && !preferredSection) {
            preferredSection = current;
          } else if (!preferredFallback && ['main', 'form', 'aside'].includes(tag)) {
            preferredFallback = current;
          }

          current = current.parentElement;
          depth += 1;
        }

        return preferredArticle || preferredSection || preferredFallback || surface;
      };

      const chooseNearestHeader = (headers, rect, axis) => {
        if (headers.length === 0) {
          return undefined;
        }

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const ranked = headers
          .map((header) => {
            const headerCenterX = header.rect.left + header.rect.width / 2;
            const headerCenterY = header.rect.top + header.rect.height / 2;
            const primaryDistance =
              axis === 'column'
                ? Math.abs(headerCenterX - centerX)
                : Math.abs(headerCenterY - centerY);
            const secondaryDistance =
              axis === 'column'
                ? Math.max(0, rect.top - header.rect.bottom)
                : header.rect.left <= rect.left
                  ? Math.max(0, rect.left - header.rect.right)
                  : Math.max(0, header.rect.left - rect.right);
            return {
              header,
              primaryDistance,
              secondaryDistance,
            };
          })
          .sort((left, right) => {
            if (left.primaryDistance !== right.primaryDistance) {
              return left.primaryDistance - right.primaryDistance;
            }
            return left.secondaryDistance - right.secondaryDistance;
          });

        return ranked[0]?.header;
      };

      const groupHeadersByBand = (headers, axis) => {
        const sorted = [...headers].sort((left, right) => {
          const leftCenter =
            axis === 'column'
              ? left.rect.top + left.rect.height / 2
              : left.rect.left + left.rect.width / 2;
          const rightCenter =
            axis === 'column'
              ? right.rect.top + right.rect.height / 2
              : right.rect.left + right.rect.width / 2;
          return leftCenter - rightCenter;
        });
        const bands = [];

        for (const header of sorted) {
          const center =
            axis === 'column'
              ? header.rect.top + header.rect.height / 2
              : header.rect.left + header.rect.width / 2;
          const tolerance =
            axis === 'column'
              ? Math.max(14, header.rect.height)
              : Math.max(14, header.rect.width);
          const band = bands.find((candidate) => Math.abs(candidate.center - center) <= tolerance);
          if (band) {
            band.headers.push(header);
            const centers = band.headers.map((entry) =>
              axis === 'column'
                ? entry.rect.top + entry.rect.height / 2
                : entry.rect.left + entry.rect.width / 2
            );
            band.center = centers.reduce((sum, value) => sum + value, 0) / centers.length;
          } else {
            bands.push({
              center,
              headers: [header],
            });
          }
        }

        return bands
          .map((band) => ({
            center: band.center,
            headers:
              axis === 'column'
                ? [...band.headers].sort((left, right) => left.rect.left - right.rect.left)
                : [...band.headers].sort((left, right) => left.rect.top - right.rect.top),
          }))
          .sort((left, right) => left.center - right.center);
      };

      const analyzeVisualSeatGridSurface = (surface) => {
        if (!isPotentialVisualGridSurface(surface)) {
          return null;
        }

        const tokenNodes = Array.from(surface.querySelectorAll('*')).filter((candidate) =>
          isVisualGridTokenElement(candidate)
        );
        if (tokenNodes.length < 16) {
          return null;
        }

        const rowHeaders = [];
        const columnHeaders = [];
        const seatCells = [];

        for (const candidate of tokenNodes) {
          const rect = candidate.getBoundingClientRect();
          const tokenKind = visualSeatGridTokenKindOf(candidate);
          if (tokenKind === 'row') {
            rowHeaders.push({
              element: candidate,
              text: compactText(textOf(candidate)),
              rect,
            });
            continue;
          }
          if (tokenKind === 'column') {
            columnHeaders.push({
              element: candidate,
              text: compactText(textOf(candidate)).toUpperCase(),
              rect,
            });
            continue;
          }
          if (isVisualSeatCellElement(candidate)) {
            seatCells.push({
              element: candidate,
              rect,
            });
          }
        }

        if (seatCells.length < 8 || rowHeaders.length < 4 || columnHeaders.length < 4) {
          return null;
        }

        const columnBands = groupHeadersByBand(columnHeaders, 'column').filter(
          (band) => band.headers.length >= 4
        );
        if (columnBands.length === 0) {
          return null;
        }
        const topColumnHeaders = columnBands[0]?.headers ?? [];
        const bottomColumnHeaders = columnBands[columnBands.length - 1]?.headers ?? [];

        const ownerSurface = visualSeatGridOwnerSurfaceOf(surface);
        const descriptors = [];

        for (const seatCell of seatCells) {
          const explicitSeatIdentity = visualSeatIdentityOf(seatCell.element);
          const rowHeaderCandidates = rowHeaders.filter((header) => {
            const headerCenterY = header.rect.top + header.rect.height / 2;
            const seatCenterY = seatCell.rect.top + seatCell.rect.height / 2;
            return Math.abs(headerCenterY - seatCenterY) <= Math.max(12, seatCell.rect.height);
          });
          const preferredRowHeaders = rowHeaderCandidates.filter(
            (header) =>
              header.rect.right <= seatCell.rect.left + 4 ||
              header.rect.left >= seatCell.rect.right - 4
          );
          const rowHeader =
            chooseNearestHeader(
              preferredRowHeaders.length > 0 ? preferredRowHeaders : rowHeaderCandidates,
              seatCell.rect,
              'row'
            ) || undefined;
          const topColumnHeaderCandidates = topColumnHeaders.filter(
            (header) => header.rect.bottom <= seatCell.rect.top + 12
          );
          const bottomColumnHeaderCandidates = bottomColumnHeaders.filter(
            (header) => header.rect.top >= seatCell.rect.bottom - 12
          );
          const topColumnHeader =
            topColumnHeaders.length > 0
              ? chooseNearestHeader(
                  topColumnHeaderCandidates.length > 0 ? topColumnHeaderCandidates : topColumnHeaders,
                  seatCell.rect,
                  'column'
                )
              : undefined;
          const bottomColumnHeader =
            bottomColumnHeaders.length > 0
              ? chooseNearestHeader(
                  bottomColumnHeaderCandidates.length > 0
                    ? bottomColumnHeaderCandidates
                    : bottomColumnHeaders,
                  seatCell.rect,
                  'column'
                )
              : undefined;
          const columnHeader =
            explicitSeatIdentity?.column ||
            topColumnHeader?.text ||
            bottomColumnHeader?.text ||
            undefined;

          const row = explicitSeatIdentity?.row || rowHeader?.text;
          const column = explicitSeatIdentity?.column || columnHeader;
          if (!row || !column) {
            continue;
          }

          const label = explicitSeatIdentity?.label || row + column;
          const states = visualSeatCellStateOf(seatCell.element);
          descriptors.push({
            element: seatCell.element,
            meta: {
              kind: 'div',
              label,
              interactionHint: 'click',
              states,
              structure: {
                family: 'structured-grid',
                variant: 'seat-cell',
                row,
                column,
                cellLabel: label,
              },
              surface: ownerSurface,
              surfaceKind: 'grid',
              hintText: 'Seat map',
            },
          });
        }

        return descriptors.length >= 6 ? descriptors : null;
      };

      const collectVisualSeatGridElements = (
        root,
        limit = collectorElementLimit,
        acc = [],
        seen = new Set()
      ) => {
        if (!root?.querySelectorAll || acc.length >= limit) {
          return acc;
        }

        const tokenNodes = Array.from(root.querySelectorAll('*')).filter((candidate) =>
          isVisualGridTokenElement(candidate)
        );
        if (tokenNodes.length < 16) {
          return acc;
        }

        const candidateSurfaces = new Map();
        for (const tokenNode of tokenNodes) {
          let current = composedParentElement(tokenNode);
          let depth = 0;
          while (current && depth < 8) {
            if (isPotentialVisualGridSurface(current)) {
              candidateSurfaces.set(
                current,
                (candidateSurfaces.get(current) || 0) + 1
              );
            }
            current = composedParentElement(current);
            depth += 1;
          }
        }

        const rankedSurfaces = [...candidateSurfaces.entries()]
          .filter(([, count]) => count >= 16)
          .sort((left, right) => right[1] - left[1]);

        for (const [surface] of rankedSurfaces) {
          if (acc.length >= limit) {
            break;
          }

          const descriptors = analyzeVisualSeatGridSurface(surface);
          if (!descriptors) {
            continue;
          }

          for (const descriptor of descriptors) {
            if (acc.length >= limit) {
              break;
            }
            if (seen.has(descriptor.element)) {
              continue;
            }
            seen.add(descriptor.element);
            visualSeatGridMeta.set(descriptor.element, descriptor.meta);
            acc.push(descriptor.element);
          }
        }

        return acc;
      };

      const elements = collectInteractiveElements(doc, collectorElementLimit, [], seenElements)
        .concat(
          includeActivationAffordances
            ? collectGenericClickableElements(doc, collectorElementLimit, [], seenElements)
            : []
        )
        .concat(collectVisualSeatGridElements(doc, collectorElementLimit, [], seenElements))
        .filter((element) => isHTMLElementNode(element))
        .filter((element) => isVisible(element));

      const localSurfaceCandidateOf = (element) => {
        const ranked = [];
        const pushCandidate = (candidate, depth) => {
          if (
            !isHTMLElementNode(candidate) ||
            candidate === element ||
            !isVisible(candidate)
          ) {
            return;
          }

          const priority = surfacePriorityOf(candidate);
          if (priority <= 0) {
            return;
          }

          if (ranked.some((entry) => entry.element === candidate)) {
            return;
          }

          ranked.push({ element: candidate, priority, depth });
        };

        pushCandidate(itemOf(element), 0);
        pushCandidate(containerOf(element), 1);

        let current = composedParentElement(element);
        let depth = 0;
        while (current && depth < 16) {
          pushCandidate(current, depth + 2);
          current = composedParentElement(current);
          depth += 1;
        }

        ranked.sort((left, right) => {
          if (left.priority !== right.priority) {
            return right.priority - left.priority;
          }
          return left.depth - right.depth;
        });

        return ranked[0]?.element;
      };

      const surfaceSelectorsOf = (element, localSurface) => {
        const selectors = [];
        let current = element.parentElement;

        while (current) {
          if (current.matches?.(overlaySurfaceSelector)) {
            const selector = buildSelector(current);
            if (selector && !selectors.includes(selector)) {
              selectors.push(selector);
            }
          }
          current = current.parentElement;
        }

        if (localSurface) {
          const selector = buildSelector(localSurface);
          if (selector && !selectors.includes(selector)) {
            selectors.push(selector);
          }
        }

        return selectors.length > 0 ? selectors : undefined;
      };

      const targets = elements.map((element, ordinal) => {
        const visualSeatGrid = visualSeatGridMeta.get(element);
        const associatedChoiceControl = associatedChoiceControlOf(element);
        const genericClickable = isGenericClickableElement(element);
        const bareFocusableClickTarget = isBareFocusableClickTarget(element);
        const effectiveElement = element;
        const domSignature = domSignatureOf(effectiveElement);
        const genericCardLike =
          !associatedChoiceControl &&
          genericClickable &&
          (isStructuredContainer(element) ||
            /\b(card|item|result|fare|flight|ticket|offer|row)\b/.test(
              clickableSemanticBlobOf(element)
            ));
        const inferredKind =
          visualSeatGrid?.kind ||
          (associatedChoiceControl
            ? (associatedChoiceControl.type || '').toLowerCase() === 'checkbox'
              ? 'checkbox'
              : 'radio'
            : genericCardLike
              ? 'card'
              : kindOf(element));
        const rect = element.getBoundingClientRect();
        const container = containerOf(element);
        const landmark = composedClosest(element, contextSelector);
        const group = groupOf(element);
        const item = itemOf(element);
        const overlaySurface = composedClosest(element, overlaySurfaceSelector);
        const localSurface = localSurfaceCandidateOf(element);
        const selfSurface =
          genericClickable && !associatedChoiceControl && isStructuredContainer(element)
            ? element
            : undefined;
        const surface =
          visualSeatGrid?.surface ||
          (isHTMLElementNode(overlaySurface) ? overlaySurface : localSurface || selfSurface);
        const surfaceSelectors = surfaceSelectorsOf(element, localSurface || selfSurface);
        const structure = visualSeatGrid?.structure || inferStructuredCell(element, surface);
        const directFallbackLabel = explicitLabelOf(element) || looseFieldLabelOf(element);
        const directionalFallbackLabel = directionalControlFallbackLabelOf(
          element,
          directFallbackLabel
        );
        const fallbackLabel = directionalFallbackLabel || directFallbackLabel;
        const currentValue = popupCurrentValueOf(element);
        const role = inferRole(element) || inferRole(associatedChoiceControl);
        const surfaceKind = visualSeatGrid?.surfaceKind || surfaceKindOf(surface);
        const fallbackSurfaceLabel =
          (visualSeatGrid?.hintText ? 'Seat map' : undefined) ||
          surfaceFallbackLabelOf(surface, surfaceKind);
        const form = composedClosest(element, 'form');
        const testIdAttribute = element.hasAttribute('data-testid')
          ? 'data-testid'
          : element.hasAttribute('data-test-id')
            ? 'data-test-id'
            : undefined;
        return {
          kind: inferredKind,
          label: visualSeatGrid?.label || fallbackLabel,
          fallbackLabel: visualSeatGrid?.label || fallbackLabel,
          interactionHint:
            visualSeatGrid?.interactionHint ||
            (genericClickable || bareFocusableClickTarget ? 'click' : undefined),
          role,
          currentValue: currentValue || undefined,
          text: textOf(element),
          placeholder: element.getAttribute('placeholder')?.trim() || undefined,
          inputName:
            element.getAttribute('name')?.trim() ||
            associatedChoiceControl?.getAttribute('name')?.trim() ||
            undefined,
          inputType:
            element.getAttribute('type')?.trim() ||
            associatedChoiceControl?.getAttribute('type')?.trim() ||
            undefined,
          autocomplete: element.getAttribute('autocomplete')?.trim() || undefined,
          ariaAutocomplete: element.getAttribute('aria-autocomplete')?.trim() || undefined,
          validation: validationEvidenceOf(element),
          title: element.getAttribute('title')?.trim() || undefined,
          testId:
            element.getAttribute('data-testid')?.trim() ||
            element.getAttribute('data-test-id')?.trim() ||
            undefined,
          testIdAttribute,
          selector: buildSelector(element),
          framePath: inheritedFramePath.length > 0 ? inheritedFramePath : undefined,
          frameUrl: inheritedFrameUrl || undefined,
          pageSignature,
          domSignature,
          states:
            Object.keys({ ...(stateOf(element) || {}), ...(visualSeatGrid?.states || {}) }).length > 0
              ? { ...(stateOf(element) || {}), ...(visualSeatGrid?.states || {}) }
              : undefined,
          surfaceKind,
          surfaceLabel: fallbackSurfaceLabel,
          fallbackSurfaceLabel,
          surfaceSelector: surface ? buildSelector(surface) : undefined,
          surfaceSelectors,
          surfacePriority: surfacePriorityOf(surface),
          controlsSurfaceSelector:
            selectorFromRelation(element, 'aria-controls') || selectorFromRelation(element, 'aria-owns'),
          formSelector: form ? buildSelector(form) : undefined,
          descendantInteractiveCount: element.querySelectorAll(selector).length,
          descendantEditableCount: element.querySelectorAll(
            'input:not([type="hidden"]), textarea, select, [contenteditable="true"]'
          ).length,
          structure,
          ordinal,
          context: {
            item: contextNodeOf(item),
            group: contextNodeOf(group),
            container: contextNodeOf(container),
            landmark: contextNodeOf(landmark),
            layout: {
              lane: laneOf(rect),
              band: bandOf(rect),
            },
            hintText: describedByTextOf(element),
            fallbackHintText: visualSeatGrid?.hintText,
            visual: visualOf(element),
          },
        };
      });

      return targets;
    };

    const enrichDisplayLabels = (targets) => {
      const repeatedLabels = new Map();

      for (const target of targets) {
        const label = (target.label || '').trim().toLowerCase();
        if (!label) continue;
        repeatedLabels.set(label, (repeatedLabels.get(label) || 0) + 1);
      }

      const describeContext = (candidate) => {
        const item = candidate.context?.item;
        const group = candidate.context?.group;
        const container = candidate.context?.container;
        return (
          candidate.context?.hintText ||
          item?.label ||
          item?.text ||
          group?.label ||
          group?.text ||
          container?.label ||
          candidate.context?.hintText
        );
      };

      return targets.map((target) => {
        const label = (target.label || '').trim();
        if (!label) return target;

        const repeated = (repeatedLabels.get(label.toLowerCase()) || 0) > 1;
        if (!repeated) return target;

        const detail = describeContext(target);
        if (!detail || detail === label) return target;

        const compactDetail = detail.length <= 80 ? detail : detail.slice(0, 80);
        return {
          ...target,
          displayLabel: label + ' — ' + compactDetail,
        };
      });
    };

    const hasUsefulInventorySignal = (candidate) => {
      if (candidate.label || candidate.text || candidate.placeholder || candidate.title) {
        return true;
      }

      if (candidate.structure?.family) {
        return true;
      }

      if (candidate.states && Object.keys(candidate.states).length > 0) {
        return true;
      }

      const kind = (candidate.kind || '').toLowerCase();
      const role = (candidate.role || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(kind)) {
        return true;
      }
      if (['textbox', 'combobox', 'option', 'menuitem', 'gridcell'].includes(role)) {
        return true;
      }
      if (candidate.controlsSurfaceSelector) {
        return true;
      }

      return false;
    };

    const outputPriorityOf = (candidate) => {
      let score = candidate.surfacePriority || 0;

      if (candidate.controlsSurfaceSelector) {
        score += 24;
      }
      if (candidate.structure?.family) {
        score += 18;
      }
      if (candidate.validation?.message) {
        score += 12;
      }

      const kind = (candidate.kind || '').toLowerCase();
      const role = (candidate.role || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(kind)) {
        score += 14;
      }
      if (['textbox', 'combobox', 'option', 'menuitem', 'gridcell'].includes(role)) {
        score += 12;
      }

      const allowedByHint = (candidate.interactionHint || '').toLowerCase();
      if (allowedByHint === 'click' || allowedByHint === 'press') {
        score += 4;
      }

      return score;
    };

    const seen = new Set();
    return enrichDisplayLabels(collectTargets(document))
      .filter((candidate) => {
        const frameKey = candidate.framePath ? candidate.framePath.join(' -> ') : 'top';
        const key = frameKey + '|' + (candidate.selector || candidate.domSignature || '');
        if (!candidate.selector && !candidate.domSignature) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return hasUsefulInventorySignal(candidate);
      })
      .map((candidate, index) => ({ candidate, index }))
      .sort((left, right) => {
        const priorityDelta = outputPriorityOf(right.candidate) - outputPriorityOf(left.candidate);
        if (priorityDelta !== 0) {
          return priorityDelta;
        }

        return (left.candidate.ordinal ?? left.index) - (right.candidate.ordinal ?? right.index);
      })
      .slice(0, collectorOutputLimit)
      .sort((left, right) => {
        const ordinalDelta =
          (left.candidate.ordinal ?? left.index) - (right.candidate.ordinal ?? right.index);
        if (ordinalDelta !== 0) {
          return ordinalDelta;
        }

        return left.index - right.index;
      })
      .map(({ candidate }) => candidate);
  })()`);

  if (!Array.isArray(observedTargets)) {
    return [];
  }

  return observedTargets
    .filter((target): target is DomObservedTarget =>
      Boolean(target && typeof target === 'object' && typeof target.kind === 'string')
    )
    .map((target) =>
      enrichObservedTargetSemantics(
        applyInheritedDomTargetMetadata(target, {
          framePath: options?.framePath,
          frameUrl: options?.frameUrl,
          pageSignature: options?.pageSignature,
        })
      )
    );
}

const FRAME_HOST_DESCRIPTOR_SCRIPT = String.raw`
  const ownerWindowOf = (node) => node?.ownerDocument?.defaultView || window;
  const isHTMLElementNode = (value) => {
    const view = ownerWindowOf(value);
    return Boolean(view && value instanceof view.HTMLElement);
  };
  const isShadowRootNode = (value) => {
    const view = ownerWindowOf(value);
    return Boolean(view && value instanceof view.ShadowRoot);
  };
  const composedParentElement = (element) => {
    if (!isHTMLElementNode(element)) return undefined;
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode?.();
    if (isShadowRootNode(root) && isHTMLElementNode(root.host)) {
      return root.host;
    }
    return undefined;
  };
  const cssEscape = (value) =>
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(value)
      : String(value || '').replace(/["\\]/g, '\\$&');
  const queryRootOf = (candidate) => {
    const root = candidate.getRootNode?.();
    return root && typeof root.querySelectorAll === 'function' ? root : document;
  };
  const isUserVisible = (candidate) => {
    if (!isHTMLElementNode(candidate)) return false;

    const view = ownerWindowOf(candidate);
    const style = view?.getComputedStyle?.(candidate);
    if (!style) {
      return false;
    }
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false;
    }

    const opacity = Number(style.opacity || '1');
    if (Number.isFinite(opacity) && opacity <= 0.01) {
      return false;
    }

    if (candidate.getAttribute('aria-hidden') === 'true' || candidate.inert) {
      return false;
    }

    const rect = candidate.getBoundingClientRect();
    if (!rect || rect.width < 4 || rect.height < 4) {
      return false;
    }

    const viewportWidth =
      view?.innerWidth ||
      candidate.ownerDocument?.documentElement?.clientWidth ||
      0;
    const viewportHeight =
      view?.innerHeight ||
      candidate.ownerDocument?.documentElement?.clientHeight ||
      0;
    if (viewportWidth > 0 && viewportHeight > 0) {
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= viewportHeight || rect.left >= viewportWidth) {
        return false;
      }
    }

    return true;
  };
  const isSelectorUniqueFor = (candidate, selectorValue) => {
    const queryRoot = queryRootOf(candidate);
    try {
      const matches = Array.from(queryRoot.querySelectorAll(selectorValue));
      return matches.length === 1 && matches[0] === candidate;
    } catch {
      return false;
    }
  };

  if (!(element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement)) {
    return null;
  }

  const descriptorOf = (selector) =>
    selector
      ? {
          selector,
          userVisible: isUserVisible(element),
        }
      : null;

  const tag = element.tagName.toLowerCase();
  const testId =
    element.getAttribute('data-testid')?.trim() ||
    element.getAttribute('data-test-id')?.trim();
  const testIdAttribute = element.hasAttribute('data-testid')
    ? 'data-testid'
    : element.hasAttribute('data-test-id')
      ? 'data-test-id'
      : undefined;
  const name = element.getAttribute('name')?.trim();
  const title = element.getAttribute('title')?.trim();
  const src = element.getAttribute('src')?.trim();

  if (element.id && isSelectorUniqueFor(element, '#' + cssEscape(element.id))) {
    return descriptorOf('#' + cssEscape(element.id));
  }
  if (testId) {
    const selectorValue = testIdAttribute
      ? '[' + testIdAttribute + '="' + cssEscape(testId) + '"]'
      : undefined;
    if (isSelectorUniqueFor(element, selectorValue)) {
      return descriptorOf(selectorValue);
    }
  }
  if (name) {
    const selectorValue = tag + '[name="' + cssEscape(name) + '"]';
    if (isSelectorUniqueFor(element, selectorValue)) {
      return descriptorOf(selectorValue);
    }
  }
  if (title) {
    const selectorValue = tag + '[title="' + cssEscape(title) + '"]';
    if (isSelectorUniqueFor(element, selectorValue)) {
      return descriptorOf(selectorValue);
    }
  }
  if (src) {
    const selectorValue = tag + '[src="' + cssEscape(src) + '"]';
    if (isSelectorUniqueFor(element, selectorValue)) {
      return descriptorOf(selectorValue);
    }
  }

  const segmentOf = (current) => {
    if (current.id && isSelectorUniqueFor(current, '#' + cssEscape(current.id))) {
      return '#' + cssEscape(current.id);
    }

    const currentTestId =
      current.getAttribute('data-testid')?.trim() ||
      current.getAttribute('data-test-id')?.trim();
    const currentTestIdAttribute = current.hasAttribute('data-testid')
      ? 'data-testid'
      : current.hasAttribute('data-test-id')
        ? 'data-test-id'
        : undefined;
    if (currentTestId) {
      const selectorValue = currentTestIdAttribute
        ? '[' + currentTestIdAttribute + '="' + cssEscape(currentTestId) + '"]'
        : undefined;
      if (isSelectorUniqueFor(current, selectorValue)) {
        return selectorValue;
      }
    }

    const currentName = current.getAttribute('name')?.trim();
    const currentTitle = current.getAttribute('title')?.trim();
    const currentTag = current.tagName.toLowerCase();

    if (currentName) {
      const selectorValue = currentTag + '[name="' + cssEscape(currentName) + '"]';
      if (isSelectorUniqueFor(current, selectorValue)) {
        return selectorValue;
      }
    }

    if (currentTitle) {
      const selectorValue = currentTag + '[title="' + cssEscape(currentTitle) + '"]';
      if (isSelectorUniqueFor(current, selectorValue)) {
        return selectorValue;
      }
    }

    const parent = current.parentElement;
    const root = current.getRootNode?.();
    const siblingPool = parent
      ? Array.from(parent.children)
      : isShadowRootNode(root)
        ? Array.from(root.children)
        : [];
    const siblings = siblingPool.filter((child) => child.tagName.toLowerCase() === currentTag);
    const index = siblings.indexOf(current) + 1;
    return currentTag + ':nth-of-type(' + Math.max(index, 1) + ')';
  };

  const path = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && path.length < 8) {
    path.unshift(segmentOf(current));
    if (current.id) {
      break;
    }
    current = current.parentElement;
  }

  if (path.length === 0) return null;

  const structuralSelector = path.join(' > ');
  const selector = isSelectorUniqueFor(element, structuralSelector) ? structuralSelector : null;
  return descriptorOf(selector);
`;

export async function readFrameHostDescriptor(frame: Frame): Promise<FrameHostDescriptor | null> {
  const frameElement = await frame.frameElement().catch(() => null);
  if (!frameElement) {
    return null;
  }

  try {
    const descriptor = await frameElement.evaluate(
      (element, source) => Function('element', source)(element) as FrameHostDescriptor | null,
      FRAME_HOST_DESCRIPTOR_SCRIPT
    );
    if (
      !descriptor ||
      typeof descriptor !== 'object' ||
      typeof descriptor.selector !== 'string' ||
      descriptor.selector.length === 0 ||
      typeof descriptor.userVisible !== 'boolean'
    ) {
      return null;
    }
    return descriptor;
  } catch {
    return null;
  } finally {
    await frameElement.dispose().catch(() => undefined);
  }
}

export async function collectDomTargets(
  page: {
    evaluate<T>(pageFunction: string): Promise<T>;
    mainFrame?: () => Frame;
    url?: () => string;
  },
  options?: DomTargetCollectionOptions
): Promise<DomObservedTarget[]> {
  const topLevelPageSignature =
    typeof page.url === 'function' ? normalizePageSignature(page.url()) : options?.pageSignature;

  if (typeof page.mainFrame !== 'function') {
    return collectDomTargetsFromDocument(page, {
      ...options,
      pageSignature: topLevelPageSignature,
    });
  }

  const collected: DomObservedTarget[] = [];
  const includeActivationAffordances = options?.includeActivationAffordances === true;

  const walk = async (frame: Frame, framePath?: string[]): Promise<void> => {
    if (collected.length >= DOM_TARGET_COLLECTION_LIMIT) {
      return;
    }

    const frameUrl = frame.url().trim() || undefined;
    const targets = await collectDomTargetsFromDocument(frame, {
      includeActivationAffordances,
      pageSignature: topLevelPageSignature,
      framePath,
      frameUrl,
    }).catch(() => []);
    for (const target of targets) {
      if (collected.length >= DOM_TARGET_COLLECTION_LIMIT) {
        break;
      }
      collected.push(target);
    }

    if (collected.length >= DOM_TARGET_COLLECTION_LIMIT) {
      return;
    }

    for (const childFrame of frame.childFrames().slice(0, 20)) {
      if (collected.length >= DOM_TARGET_COLLECTION_LIMIT) {
        break;
      }

      const frameHost = await readFrameHostDescriptor(childFrame);
      if (!frameHost?.selector || !frameHost.userVisible) {
        continue;
      }

      await walk(childFrame, [...(framePath ?? []), frameHost.selector]);
    }
  };

  await walk(page.mainFrame());
  return collected;
}

export const __testDomTargetCollection = {
  collectDomTargetsFromDocument,
  inferStructuredCellVariantFromEvidence,
  inferDirectionalControlFallbackFromEvidence,
  locatorDomSignatureScript: LOCATOR_DOM_SIGNATURE_SCRIPT,
};

export const __testStagehandDescriptor = {
  normalizeStagehandSelector,
  readStagehandDomFacts,
  readStagehandDomFactsInBrowser,
  stagehandDomFactsScript: STAGEHAND_DOM_FACTS_SCRIPT,
};
