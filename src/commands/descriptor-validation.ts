import type { Locator } from 'playwright-core';
import type { TargetDescriptor } from '../runtime-state.js';
import { OBSERVE_DOM_LABEL_CONTRACT_HELPER_SCRIPT } from './observe-dom-label-contract.js';

export function normalizePageSignature(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export const LOCATOR_DOM_SIGNATURE_SCRIPT = String.raw`
  ${OBSERVE_DOM_LABEL_CONTRACT_HELPER_SCRIPT}
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  return (
    element.tagName.toLowerCase() +
    '|' +
    observedInferRole(element) +
    '|' +
    observedLabelOf(element)
  );
`;

function readLocatorDomSignatureInBrowser(element: Element): string | null {
  return Function('element', LOCATOR_DOM_SIGNATURE_SCRIPT)(element) as string | null;
}

export type LocatorBindingSnapshot = {
  domSignature: string | null;
  kind?: string;
  role?: string;
  label?: string;
  placeholder?: string;
  inputName?: string;
  inputType?: string;
  autocomplete?: string;
};

const LOCATOR_BINDING_SNAPSHOT_SCRIPT = String.raw`
  ${OBSERVE_DOM_LABEL_CONTRACT_HELPER_SCRIPT}
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  const read = Function('element', ${JSON.stringify(LOCATOR_DOM_SIGNATURE_SCRIPT)});
  const role = observedInferRole(element);
  const domSignature = read(element);
  const label = typeof domSignature === 'string' ? domSignature.split('|').slice(2).join('|') : undefined;
  return {
    domSignature,
    kind: element.tagName.toLowerCase(),
    role,
    label: label || undefined,
    placeholder: element.getAttribute('placeholder')?.trim() || undefined,
    inputName: element.getAttribute('name')?.trim() || undefined,
    inputType: element.getAttribute('type')?.trim() || undefined,
    autocomplete: element.getAttribute('autocomplete')?.trim() || undefined,
  };
`;

const LOCATOR_OUTER_HTML_SCRIPT = String.raw`
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  const ownerWindow = element.ownerDocument?.defaultView || window;
  const TextCtor = ownerWindow.Text;
  const ElementCtor = ownerWindow.Element;
  const ShadowRootCtor = ownerWindow.ShadowRoot;
  const voidTags = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
  ]);

  const escapeText = (value) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const escapeAttribute = (value) =>
    value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  const serializeChildren = (parent) =>
    Array.from(parent.childNodes)
      .map((node) => serializeNode(node))
      .join('');

  const serializeNode = (node) => {
    if (node instanceof TextCtor) {
      return escapeText(node.textContent ?? '');
    }

    if (!(node instanceof ElementCtor)) {
      return '';
    }

    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'template'].includes(tag)) {
      return '';
    }

    const attrs = node
      .getAttributeNames()
      .sort()
      .map((name) => ' ' + name + '="' + escapeAttribute(node.getAttribute(name) ?? '') + '"')
      .join('');
    const shadowRoot =
      node.shadowRoot && node.shadowRoot instanceof ShadowRootCtor ? node.shadowRoot : null;
    const shadowHtml = shadowRoot
      ? '<div data-agentbrowse-shadow-root="open">' + serializeChildren(shadowRoot) + '</div>'
      : '';
    const childHtml = serializeChildren(node);

    if (voidTags.has(tag)) {
      return '<' + tag + attrs + '>' + shadowHtml;
    }

    return '<' + tag + attrs + '>' + shadowHtml + childHtml + '</' + tag + '>';
  };

  return serializeNode(element);
`;

export async function readLocatorDomSignature(locator: Locator): Promise<string | null> {
  try {
    return await locator
      .first()
      .evaluate(
        (element, source) => Function('element', source)(element) as string | null,
        LOCATOR_DOM_SIGNATURE_SCRIPT
      );
  } catch {
    return null;
  }
}

export async function readLocatorBindingSnapshot(
  locator: Locator
): Promise<LocatorBindingSnapshot | null> {
  try {
    return await locator
      .first()
      .evaluate(
        (element, source) => Function('element', source)(element) as LocatorBindingSnapshot | null,
        LOCATOR_BINDING_SNAPSHOT_SCRIPT
      );
  } catch {
    return null;
  }
}

function normalizeComparable(value: string | undefined | null): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function isCompatibleMutableFieldBinding(
  target: TargetDescriptor,
  snapshot: LocatorBindingSnapshot | null
): boolean {
  if (!snapshot) {
    return false;
  }

  const isFieldLike =
    target.controlFamily === 'text-input' ||
    target.controlFamily === 'select' ||
    target.controlFamily === 'datepicker' ||
    target.allowedActions.includes('fill') ||
    target.allowedActions.includes('type') ||
    target.allowedActions.includes('select');
  if (!isFieldLike) {
    return false;
  }

  const comparablePairs: Array<[string | undefined, string | undefined]> = [
    [normalizeComparable(target.kind), normalizeComparable(snapshot.kind)],
    [normalizeComparable(target.semantics?.role), normalizeComparable(snapshot.role)],
    [normalizeComparable(target.inputName), normalizeComparable(snapshot.inputName)],
    [normalizeComparable(target.inputType), normalizeComparable(snapshot.inputType)],
    [normalizeComparable(target.autocomplete), normalizeComparable(snapshot.autocomplete)],
  ];

  let compared = false;
  for (const [expected, actual] of comparablePairs) {
    if (!expected) {
      continue;
    }
    compared = true;
    if (!actual || actual !== expected) {
      return false;
    }
  }

  return compared;
}

export const __testDescriptorValidation = {
  readLocatorDomSignatureInBrowser,
  locatorDomSignatureScript: LOCATOR_DOM_SIGNATURE_SCRIPT,
  locatorBindingSnapshotScript: LOCATOR_BINDING_SNAPSHOT_SCRIPT,
  isCompatibleMutableFieldBinding,
};

export async function readLocatorOuterHtml(locator: Locator): Promise<string | null> {
  try {
    return await locator
      .first()
      .evaluate(
        (element, source) => Function('element', source)(element) as string | null,
        LOCATOR_OUTER_HTML_SCRIPT
      );
  } catch {
    return null;
  }
}
