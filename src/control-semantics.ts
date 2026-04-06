import type {
  TargetAcceptancePolicy,
  TargetAllowedAction,
  TargetAvailabilityState,
  TargetControlFamily,
  TargetStructure,
} from './runtime-state.js';

export type TargetStateFacts = Record<string, string | boolean | number>;

export type TargetSemanticsFacts = {
  kind?: string;
  role?: string;
  label?: string;
  displayLabel?: string;
  interactionHint?: 'click';
  text?: string;
  placeholder?: string;
  inputName?: string;
  inputType?: string;
  autocomplete?: string;
  ariaAutocomplete?: string;
  surfaceKind?: string;
  controlsSurfaceSelector?: string;
  states?: TargetStateFacts;
  structure?: TargetStructure;
  legacyMethod?: string;
};

export type ComparableValueType = 'phone' | 'card-number' | 'expiry' | 'cvc' | 'date';

const DATE_LIKE_LABEL_RE =
  /(?:\b\d{1,2}\b|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр|january|february|march|april|may|june|july|august|september|october|november|december|date|дата|calendar|datepicker|календар)/i;

const SUBMIT_LABEL_RE =
  /(?:buy|book|continue|search|find|open|submit|next|pay|купить|забронировать|продолжить|найти|открыть|оплатить)/i;
const PREREQUISITE_HINT_RE =
  /(?:choose|select|pick|set|enter|fill|complete)\b.*\b(?:first|before)\b|(?:first|before)\b.*\b(?:choose|select|pick|set|enter|fill|complete)\b|(?:сначала|сперва)\b.*\b(?:выберите|заполните|укажите|введите|завершите)\b|\b(?:выберите|заполните|укажите|введите|завершите)\b.*\b(?:сначала|сперва)\b|required first|available after|unlock/i;
const PHONE_FIELD_RE = /\b(phone|mobile|telephone|tel)\b/i;
const CARD_NUMBER_FIELD_RE = /\b(card.?number|cc.?number|cardnumber|pan|cc-number)\b/i;
const CARD_EXPIRY_FIELD_RE =
  /\b(exp(?:iry|iration)(?: date)?|cc-exp|valid\s+thru|valid\s+through|mm\s*\/\s*yy(?:yy)?)\b/i;
const CARD_CVC_FIELD_RE = /\b(cvc|cvv|cc-csc|security code|card cvc)\b/i;
const DATE_VALUE_MASK_RE =
  /(?:^|\b)(?:dd|d|дд|д)\s*[./-]\s*(?:mm|m|мм|м)\s*[./-]\s*(?:yyyy|yyy|yy|y|гггг|гг|г)(?:\b|$)/i;
const NON_CARD_DATE_FIELD_RE =
  /\b(?:birth|dob|date|issued|expires|expiry|expiration|expir)\b|(?:дата|рожд|срок)/i;
function normalizeText(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function primaryLabel(facts: TargetSemanticsFacts): string {
  return facts.label ?? facts.displayLabel ?? facts.text ?? facts.placeholder ?? '';
}

function valueTypeHintBlob(facts: TargetSemanticsFacts): string {
  return [
    facts.label,
    facts.displayLabel,
    facts.text,
    facts.placeholder,
    facts.inputName,
    facts.autocomplete,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .trim();
}

export function inferComparableValueTypeFromFacts(
  facts: TargetSemanticsFacts
): ComparableValueType | undefined {
  const inputType = normalizeText(facts.inputType);
  const autocomplete = normalizeText(facts.autocomplete);
  const hintBlob = valueTypeHintBlob(facts);

  if (inputType === 'tel' || autocomplete.includes('tel') || PHONE_FIELD_RE.test(hintBlob)) {
    return 'phone';
  }

  if (autocomplete.includes('cc-number') || CARD_NUMBER_FIELD_RE.test(hintBlob)) {
    return 'card-number';
  }

  const cardExpiryLike =
    autocomplete.includes('cc-exp') ||
    (inputType !== 'date' &&
      CARD_EXPIRY_FIELD_RE.test(hintBlob) &&
      (autocomplete.startsWith('cc-') ||
        /\b(card|credit|debit)\b/i.test(hintBlob) ||
        /\bmm\s*\/\s*yy(?:yy)?\b/i.test(hintBlob)));
  if (cardExpiryLike) {
    return 'expiry';
  }

  if (autocomplete.includes('cc-csc') || CARD_CVC_FIELD_RE.test(hintBlob)) {
    return 'cvc';
  }

  const nonCardDateLike =
    inputType === 'date' ||
    DATE_VALUE_MASK_RE.test(hintBlob) ||
    (NON_CARD_DATE_FIELD_RE.test(hintBlob) &&
      !autocomplete.startsWith('cc-') &&
      !/\b(card|credit|debit|cvc|cvv|security code)\b/i.test(hintBlob));
  if (nonCardDateLike) {
    return 'date';
  }

  return undefined;
}

function isPopupBackedTextEntry(facts: TargetSemanticsFacts): boolean {
  const kind = normalizeText(facts.kind);
  const role = normalizeText(facts.role);
  const surfaceKind = normalizeText(facts.surfaceKind);

  if (
    (kind === 'input' || kind === 'textarea' || role === 'textbox') &&
    (Boolean(facts.controlsSurfaceSelector) ||
      surfaceKind === 'listbox' ||
      surfaceKind === 'menu' ||
      facts.states?.expanded !== undefined)
  ) {
    return true;
  }

  return false;
}

function isPopupBackedComboboxFacts(facts: TargetSemanticsFacts): boolean {
  const kind = normalizeText(facts.kind);
  const role = normalizeText(facts.role);
  const surfaceKind = normalizeText(facts.surfaceKind);

  if (kind !== 'combobox' && role !== 'combobox') {
    return false;
  }

  return (
    Boolean(facts.controlsSurfaceSelector) ||
    surfaceKind === 'listbox' ||
    surfaceKind === 'menu' ||
    surfaceKind === 'floating-panel' ||
    facts.states?.expanded !== undefined
  );
}

function isSearchableComboboxFacts(facts: TargetSemanticsFacts): boolean {
  const ariaAutocomplete = normalizeText(facts.ariaAutocomplete);

  if (!isPopupBackedComboboxFacts(facts)) {
    return false;
  }

  return (
    ariaAutocomplete === 'list' || ariaAutocomplete === 'both' || ariaAutocomplete === 'inline'
  );
}

function isSelectLikePopupOwner(facts: TargetSemanticsFacts): boolean {
  const kind = normalizeText(facts.kind);

  if (kind === 'select') {
    return true;
  }

  if (isPopupBackedComboboxFacts(facts)) {
    return true;
  }

  return isPopupBackedTextEntry(facts) && facts.states?.readonly === true;
}

function isButtonLikeInputFacts(facts: TargetSemanticsFacts): boolean {
  return (
    normalizeText(facts.kind) === 'input' &&
    ['button', 'submit', 'reset'].includes(normalizeText(facts.inputType))
  );
}

function isSelectionItemLikeFacts(facts: TargetSemanticsFacts): boolean {
  return isPopupSelectionListitemFacts(facts) || isLegacySelectionItemLikeFacts(facts);
}

function isLegacySelectionItemLikeFacts(facts: TargetSemanticsFacts): boolean {
  const kind = normalizeText(facts.kind);
  const role = normalizeText(facts.role);

  return (
    kind === 'option' ||
    role === 'option' ||
    role === 'menuitem' ||
    facts.structure?.family === 'structured-grid'
  );
}

function isPopupSelectionListitemFacts(facts: TargetSemanticsFacts): boolean {
  const kind = normalizeText(facts.kind);
  const role = normalizeText(facts.role);
  const surfaceKind = normalizeText(facts.surfaceKind);

  return (
    (kind === 'listitem' || role === 'listitem') &&
    (surfaceKind === 'floating-panel' ||
      surfaceKind === 'listbox' ||
      surfaceKind === 'menu' ||
      facts.states?.selected === true ||
      facts.states?.current === true ||
      facts.states?.selectable === true)
  );
}

function isBinaryToggleControlFacts(facts: TargetSemanticsFacts): boolean {
  const kind = normalizeText(facts.kind);
  const role = normalizeText(facts.role);
  const inputType = normalizeText(facts.inputType);

  return (
    kind === 'checkbox' ||
    kind === 'radio' ||
    role === 'checkbox' ||
    role === 'radio' ||
    role === 'switch' ||
    kind === 'tab' ||
    role === 'tab' ||
    inputType === 'checkbox' ||
    inputType === 'radio'
  );
}

function isDisclosureLikeTriggerFacts(
  facts: TargetSemanticsFacts,
  controlFamily: TargetControlFamily | undefined
): boolean {
  const kind = normalizeText(facts.kind);
  const role = normalizeText(facts.role);
  const inputType = normalizeText(facts.inputType);
  const popupBacked =
    Boolean(facts.controlsSurfaceSelector) || facts.states?.expanded !== undefined;

  if (!popupBacked) {
    return false;
  }

  if (isSelectionItemLikeFacts(facts) || controlFamily === 'text-input') {
    return false;
  }

  if (controlFamily === 'select' || controlFamily === 'datepicker') {
    return true;
  }

  return (
    kind === 'button' ||
    role === 'button' ||
    kind === 'link' ||
    role === 'link' ||
    kind === 'combobox' ||
    role === 'combobox' ||
    kind === 'select' ||
    isButtonLikeInputFacts(facts) ||
    inputType === 'button' ||
    isPopupBackedTextEntry(facts)
  );
}

function isToggleLikeControlFacts(
  facts: TargetSemanticsFacts,
  controlFamily: TargetControlFamily | undefined
): boolean {
  const states = facts.states;
  if (!states) {
    return false;
  }

  if (states.checked !== undefined || isBinaryToggleControlFacts(facts)) {
    return true;
  }

  if (states.selected !== undefined) {
    if (
      isSelectionItemLikeFacts(facts) ||
      controlFamily === 'select' ||
      controlFamily === 'datepicker' ||
      isDisclosureLikeTriggerFacts(facts, controlFamily)
    ) {
      return false;
    }
    return true;
  }

  if (states.pressed !== undefined) {
    return !isDisclosureLikeTriggerFacts(facts, controlFamily);
  }

  return false;
}

export function isLikelyDateLikeLabel(value: string | undefined): boolean {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    return false;
  }
  if (/^\+?\d{1,4}$/.test(trimmed)) {
    return false;
  }
  if (/\+\d{1,4}\b/.test(trimmed)) {
    return false;
  }
  return DATE_LIKE_LABEL_RE.test(trimmed);
}

export function inferAllowedActionsFromFacts(facts: TargetSemanticsFacts): TargetAllowedAction[] {
  const kind = normalizeText(facts.kind);
  const role = normalizeText(facts.role);
  const interactionHint = normalizeText(facts.interactionHint);
  const legacyMethod = normalizeText(facts.legacyMethod);
  const selectLikePopupOwner = isSelectLikePopupOwner(facts);
  const buttonLikeInput = isButtonLikeInputFacts(facts);
  const checkedToggle =
    facts.states?.checked !== undefined ||
    kind === 'checkbox' ||
    kind === 'radio' ||
    role === 'checkbox' ||
    role === 'radio' ||
    role === 'switch';
  const actions = new Set<TargetAllowedAction>();

  if (selectLikePopupOwner) {
    actions.add('click');
    actions.add('select');
    actions.add('press');
    if (facts.surfaceKind === 'datepicker' || isLikelyDateLikeLabel(primaryLabel(facts))) {
      actions.add('fill');
    }
    if ((kind === 'combobox' || role === 'combobox') && isSearchableComboboxFacts(facts)) {
      actions.add('fill');
      actions.add('type');
    }
  } else if (
    !buttonLikeInput &&
    (kind === 'input' ||
      kind === 'textarea' ||
      role === 'textbox' ||
      ((kind === 'combobox' || role === 'combobox') && !isPopupBackedComboboxFacts(facts)))
  ) {
    actions.add('click');
    actions.add('fill');
    actions.add('type');
    actions.add('press');
  }

  if (!selectLikePopupOwner && kind === 'select') {
    actions.add('click');
    actions.add('select');
    actions.add('press');
  }

  if (kind === 'option' || role === 'option' || role === 'menuitem') {
    actions.add('click');
  }

  if (isPopupSelectionListitemFacts(facts)) {
    actions.add('click');
    actions.add('press');
    actions.add('select');
  }

  if (checkedToggle) {
    actions.add('click');
    actions.add('press');
  }

  if (role === 'gridcell' || facts.structure?.family === 'structured-grid') {
    actions.add('click');
    actions.add('press');
  }

  if (
    kind === 'button' ||
    kind === 'link' ||
    kind === 'tab' ||
    role === 'button' ||
    role === 'link' ||
    role === 'tab'
  ) {
    actions.add('click');
    actions.add('press');
  }

  if (interactionHint === 'click') {
    actions.add('click');
    actions.add('press');
  }

  if (legacyMethod === 'click') {
    actions.add('click');
    actions.add('press');
  }
  if (legacyMethod === 'fill') {
    actions.add('click');
    actions.add('fill');
    actions.add('type');
    actions.add('press');
  }
  if (legacyMethod === 'type') {
    actions.add('click');
    actions.add('type');
    actions.add('press');
  }
  if (legacyMethod === 'select') {
    actions.add('click');
    actions.add('select');
    actions.add('press');
  }
  if (legacyMethod === 'press') {
    actions.add('press');
  }

  return [...actions];
}

export function inferAvailabilityFromFacts(
  states?: TargetStateFacts,
  contextHint?: string,
  options: {
    readonlyInteractive?: boolean;
  } = {}
): TargetAvailabilityState {
  if (states?.occupied === true) {
    return { state: 'gated', reason: 'occupied' };
  }
  const blocked =
    states?.disabled === true ||
    states?.ariaDisabled === true ||
    states?.readonly === true ||
    states?.selectable === false;
  if (blocked && PREREQUISITE_HINT_RE.test(contextHint ?? '')) {
    return { state: 'gated', reason: 'prerequisite' };
  }
  if (states?.selectable === false) {
    return { state: 'gated', reason: 'not-selectable' };
  }
  if (states?.disabled === true || states?.ariaDisabled === true) {
    return { state: 'gated', reason: 'disabled' };
  }
  if (states?.readonly === true) {
    if (options.readonlyInteractive) {
      return { state: 'available' };
    }
    return { state: 'gated', reason: 'readonly' };
  }
  return { state: 'available' };
}

export function inferControlFamilyFromFacts(
  facts: TargetSemanticsFacts,
  allowedActions: ReadonlyArray<TargetAllowedAction>
): TargetControlFamily | undefined {
  const kind = normalizeText(facts.kind);
  const role = normalizeText(facts.role);
  const legacyMethod = normalizeText(facts.legacyMethod);
  const label = primaryLabel(facts);
  const dateLike = isLikelyDateLikeLabel(label) || facts.surfaceKind === 'datepicker';
  const comparableValueType = inferComparableValueTypeFromFacts(facts);

  if (facts.structure?.family === 'structured-grid') {
    return 'structured-grid';
  }

  if (comparableValueType === 'expiry') {
    return 'text-input';
  }

  if (
    dateLike &&
    (kind === 'input' ||
      kind === 'textarea' ||
      kind === 'select' ||
      kind === 'combobox' ||
      role === 'textbox' ||
      role === 'combobox' ||
      kind === 'option' ||
      role === 'option' ||
      role === 'menuitem' ||
      allowedActions.includes('select') ||
      legacyMethod === 'select')
  ) {
    return 'datepicker';
  }

  if (
    isSelectLikePopupOwner(facts) ||
    kind === 'option' ||
    role === 'option' ||
    role === 'menuitem' ||
    allowedActions.includes('select') ||
    legacyMethod === 'select'
  ) {
    return 'select';
  }

  if (isButtonLikeInputFacts(facts)) {
    return 'trigger';
  }

  if (
    kind === 'input' ||
    kind === 'textarea' ||
    role === 'textbox' ||
    allowedActions.includes('fill') ||
    allowedActions.includes('type') ||
    legacyMethod === 'fill' ||
    legacyMethod === 'type'
  ) {
    return 'text-input';
  }

  if (
    kind === 'button' ||
    kind === 'link' ||
    role === 'button' ||
    role === 'link' ||
    allowedActions.includes('click') ||
    allowedActions.includes('press') ||
    legacyMethod === 'click' ||
    legacyMethod === 'press'
  ) {
    return 'trigger';
  }

  return undefined;
}

export function inferAcceptancePolicyFromFacts(
  facts: TargetSemanticsFacts,
  allowedActions: ReadonlyArray<TargetAllowedAction>
): TargetAcceptancePolicy | undefined {
  const legacyMethod = normalizeText(facts.legacyMethod);
  const label = primaryLabel(facts);
  const states = facts.states;
  const kind = normalizeText(facts.kind);
  const role = normalizeText(facts.role);
  const controlFamily = inferControlFamilyFromFacts(facts, allowedActions);

  if (facts.structure?.family === 'structured-grid') {
    return facts.structure.variant === 'date-cell' ? 'date-selection' : 'selection';
  }

  if (controlFamily === 'text-input') {
    return 'value-change';
  }

  if (isDisclosureLikeTriggerFacts(facts, controlFamily)) {
    return 'disclosure';
  }

  if (isToggleLikeControlFacts(facts, controlFamily)) {
    return 'toggle';
  }

  if (controlFamily === 'datepicker') {
    return 'date-selection';
  }

  if (controlFamily === 'select') {
    return 'selection';
  }

  if (role === 'link' || kind === 'link') {
    return 'navigation';
  }

  if (!legacyMethod && SUBMIT_LABEL_RE.test(label)) {
    return 'submit';
  }

  if (controlFamily === 'trigger' || legacyMethod === 'click' || legacyMethod === 'press') {
    return 'generic-click';
  }

  return undefined;
}
