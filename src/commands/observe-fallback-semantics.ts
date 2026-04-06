import type {
  DomObservedContextNode,
  DomObservedTarget,
  DomObservedTargetContext,
} from './observe-inventory.js';

function normalizeText(value: string | undefined): string | undefined {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

export function fallbackTargetLabelOf(
  target: Pick<
    DomObservedTarget,
    'fallbackLabel' | 'label' | 'kind' | 'role' | 'text' | 'placeholder' | 'title' | 'inputType'
  >
): string | undefined {
  const explicitLabel = normalizeText(target.fallbackLabel) ?? normalizeText(target.label);
  if (explicitLabel) {
    return explicitLabel;
  }

  const kind = normalizeText(target.kind)?.toLowerCase();
  const role = normalizeText(target.role)?.toLowerCase();
  const inputType = normalizeText(target.inputType)?.toLowerCase();
  const text = normalizeText(target.text);
  const placeholder = normalizeText(target.placeholder);
  const title = normalizeText(target.title);

  const isFieldLike =
    kind === 'input' ||
    kind === 'textarea' ||
    kind === 'select' ||
    role === 'textbox' ||
    role === 'combobox';

  if (isFieldLike && placeholder) {
    return placeholder;
  }
  if (text) {
    return text;
  }
  if (title) {
    return title;
  }
  if (placeholder) {
    return placeholder;
  }

  if (kind === 'textarea') {
    return 'Text area';
  }
  if (kind === 'select' || role === 'combobox') {
    return 'Combobox';
  }
  if (role === 'textbox') {
    return 'Text input';
  }
  if (kind === 'input') {
    if (inputType === 'email') return 'Email input';
    if (inputType === 'password') return 'Password input';
    if (inputType === 'search') return 'Search input';
    if (inputType === 'tel') return 'Phone input';
    if (inputType === 'date') return 'Date input';
    return 'Text input';
  }
  if (kind === 'button' || role === 'button') {
    return 'Button';
  }
  if (kind === 'link' || role === 'link') {
    return 'Link';
  }
  if (role === 'option') {
    return 'Option';
  }
  if (role === 'menuitem') {
    return 'Menu item';
  }
  if (role === 'gridcell') {
    return 'Grid cell';
  }

  return undefined;
}

export function fallbackSurfaceLabelOf(
  target: Pick<DomObservedTarget, 'fallbackSurfaceLabel' | 'surfaceLabel'>
): string | undefined {
  return normalizeText(target.fallbackSurfaceLabel) ?? normalizeText(target.surfaceLabel);
}

export function fallbackContextNodeLabelOf(
  node: Pick<DomObservedContextNode, 'fallbackLabel' | 'label'> | undefined
): string | undefined {
  if (!node) {
    return undefined;
  }

  return normalizeText(node.fallbackLabel) ?? normalizeText(node.label);
}

export function fallbackHintTextOf(
  context: Pick<DomObservedTargetContext, 'fallbackHintText' | 'hintText'> | undefined
): string | undefined {
  if (!context) {
    return undefined;
  }

  return normalizeText(context.fallbackHintText) ?? normalizeText(context.hintText);
}
