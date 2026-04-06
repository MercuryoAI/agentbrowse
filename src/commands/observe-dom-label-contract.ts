import {
  isButtonLikeObservedInput,
  shouldAllowLooseFieldLabelFallbackForObservedControl,
} from './observe-label-policy.js';

const OBSERVE_LABEL_POLICY_HELPER_SCRIPT = String.raw`
  const isButtonLikeObservedInput = ${isButtonLikeObservedInput.toString()};
  const shouldAllowLooseFieldLabelFallbackForObservedControl =
    ${shouldAllowLooseFieldLabelFallbackForObservedControl.toString()};
`;

export const OBSERVE_DOM_LABEL_CONTRACT_HELPER_SCRIPT = String.raw`
  ${OBSERVE_LABEL_POLICY_HELPER_SCRIPT}
  const observedOwnerWindowOf = (node) => {
    if (!node?.ownerDocument?.defaultView) {
      if (typeof window !== 'undefined') {
        return window;
      }
      return typeof globalThis !== 'undefined' ? globalThis : undefined;
    }
    return node.ownerDocument.defaultView;
  };

  const observedInstanceOfViewCtor = (value, ctorName) => {
    const view = observedOwnerWindowOf(value);
    const ctor = view?.[ctorName];
    return typeof ctor === 'function' && value instanceof ctor;
  };

  const observedIsHTMLElementNode = (value) => {
    return observedInstanceOfViewCtor(value, 'HTMLElement');
  };

  const observedIsHTMLInputNode = (value) => {
    return observedInstanceOfViewCtor(value, 'HTMLInputElement');
  };

  const observedNormalizeDescriptorText = (value) => (value || '').replace(/\s+/g, ' ').trim();

  const observedInputTypeOf = (element) => {
    if (!observedIsHTMLInputNode(element)) {
      return '';
    }
    return (element.getAttribute('type') || 'text').trim().toLowerCase();
  };

  const observedIsButtonLikeInput = (element) => {
    return isButtonLikeObservedInput({
      tag: element?.tagName?.toLowerCase?.(),
      inputType: observedInputTypeOf(element),
    });
  };

  const observedShouldAllowLooseFieldLabelFallback = (element) => {
    return shouldAllowLooseFieldLabelFallbackForObservedControl({
      tag: element?.tagName?.toLowerCase?.(),
      role: element?.getAttribute?.('role')?.trim?.(),
      inputType: observedInputTypeOf(element),
    });
  };

  const observedTextOf = (target, referenceElement = target) => {
    if (target === referenceElement && observedIsButtonLikeInput(referenceElement)) {
      const value = observedNormalizeDescriptorText(
        referenceElement.value || referenceElement.getAttribute('value') || ''
      );
      if (value) {
        return value;
      }
    }

    const value = target?.innerText?.trim() || target?.textContent?.trim() || '';
    return value.replace(/\s+/g, ' ');
  };

  const observedIsMeaningfulLabel = (value) => {
    const normalized = observedNormalizeDescriptorText(value);
    return Boolean(normalized) && normalized !== '[object Object]';
  };

  const observedComposedParentElement = (node) => {
    if (!node) {
      return null;
    }
    if (node.parentElement) {
      return node.parentElement;
    }
    const root = node.getRootNode?.();
    return root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null;
  };

  const observedMatchesSelector = (element, selector) => {
    if (!observedIsHTMLElementNode(element)) {
      return false;
    }
    if (typeof element.matches === 'function') {
      return element.matches(selector);
    }

    const tag = element.tagName.toLowerCase();
    const className = (element.getAttribute('class') || '').toLowerCase();
    const testId = (
      element.getAttribute('data-testid') ||
      element.getAttribute('data-test-id') ||
      ''
    ).toLowerCase();

    if (selector === 'label, legend') {
      return tag === 'label' || tag === 'legend';
    }

    if (selector === observedLabelLikeSelector) {
      return tag === 'label' || tag === 'legend' || className.includes('label') || testId.includes('label');
    }

    return false;
  };

  const observedPrecedesElementInDocument = (candidate, element) => {
    if (typeof candidate.compareDocumentPosition === 'function') {
      return Boolean(candidate.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    }

    const candidateParent = observedComposedParentElement(candidate);
    const elementParent = observedComposedParentElement(element);
    if (candidateParent && candidateParent === elementParent && candidateParent.children) {
      const siblings = Array.from(candidateParent.children);
      const candidateIndex = siblings.indexOf(candidate);
      const elementIndex = siblings.indexOf(element);
      if (candidateIndex >= 0 && elementIndex >= 0) {
        return candidateIndex < elementIndex;
      }
    }

    return false;
  };

  const observedTokenizeSemanticText = (value) => {
    const normalized = (value || '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[^a-zA-Z0-9\u0400-\u04FF]+/g, ' ')
      .toLowerCase()
      .trim();
    if (!normalized) return [];
    return normalized
      .split(/\s+/)
      .filter((token) => token.length >= 2 && token !== 'input' && token !== 'field');
  };

  const observedFieldSemanticTokensOf = (element) => {
    const tokens = new Set();
    const pushValue = (value) => {
      for (const token of observedTokenizeSemanticText(value)) {
        tokens.add(token);
      }
    };

    const inputType = observedInputTypeOf(element);
    const autocomplete = (element.getAttribute('autocomplete') || '').trim().toLowerCase();

    if (observedIsButtonLikeInput(element)) {
      return tokens;
    }

    pushValue(element.getAttribute('placeholder'));
    pushValue(element.getAttribute('name'));
    pushValue(element.getAttribute('id'));
    pushValue(autocomplete);
    pushValue(inputType);

    if (inputType === 'email' || autocomplete.includes('email')) {
      pushValue('email mail e-mail');
    }
    if (
      inputType === 'tel' ||
      autocomplete.startsWith('tel') ||
      autocomplete.includes('phone')
    ) {
      pushValue('phone telephone mobile tel номер телефон');
    }
    if (inputType === 'password' || autocomplete.includes('password')) {
      pushValue('password pass пароль');
    }
    if (inputType === 'search' || autocomplete.includes('search')) {
      pushValue('search find поиск найти');
    }
    if (
      inputType === 'date' ||
      autocomplete.includes('bday') ||
      autocomplete.includes('birth') ||
      autocomplete.includes('dob')
    ) {
      pushValue('date birth birthday dob дата рождения');
    }

    return tokens;
  };

  const observedLooseActionTextRe =
    /^(?:pay|buy|continue|submit|search|book|reserve|checkout|next|done|оплат|куп|продолж|дальше|поиск|заброни)/i;

  const observedLabelLikeSelector = 'label, legend, [class*="label"], [data-testid*="label"]';
  const observedExplicitFieldLabelSelector = 'label, legend';

  const observedIsLooseFieldLabelCompatible = (element, candidateText) => {
    const normalizedCandidate = observedNormalizeDescriptorText(candidateText || '');
    if (!normalizedCandidate) {
      return false;
    }
    if (observedLooseActionTextRe.test(normalizedCandidate)) {
      return false;
    }

    const semanticTokens = observedFieldSemanticTokensOf(element);
    if (semanticTokens.size === 0) {
      return true;
    }

    const candidateTokens = observedTokenizeSemanticText(normalizedCandidate);
    if (candidateTokens.length === 0) {
      return false;
    }

    return candidateTokens.some((token) => semanticTokens.has(token));
  };

  const observedNearestExplicitFieldLabelOf = (element) => {
    const restrictLooseCandidatesToPreceding =
      observedShouldAllowLooseFieldLabelFallback(element);
    const anchors = [
      observedComposedParentElement(element),
      observedComposedParentElement(observedComposedParentElement(element)),
      observedComposedParentElement(
        observedComposedParentElement(observedComposedParentElement(element))
      ),
    ].filter(Boolean);

    for (const anchor of anchors) {
      if (!observedIsHTMLElementNode(anchor)) continue;

      const explicitLabels = Array.from(
        anchor.querySelectorAll(observedExplicitFieldLabelSelector)
      ).filter((candidate) => {
        return (
          observedIsHTMLElementNode(candidate) &&
          candidate !== element &&
          !candidate.contains(element) &&
          !element.contains(candidate)
        );
      });

      for (const candidate of explicitLabels) {
        if (
          restrictLooseCandidatesToPreceding &&
          !observedMatchesSelector(candidate, 'label, legend') &&
          !observedPrecedesElementInDocument(candidate, element)
        ) {
          continue;
        }
        const candidateText = observedTextOf(candidate, element);
        if (observedIsMeaningfulLabel(candidateText)) {
          return candidateText;
        }
      }
    }

    return undefined;
  };

  const observedNearestFieldLabelOf = (element) => {
    const restrictLooseCandidatesToPreceding =
      observedShouldAllowLooseFieldLabelFallback(element);
    const anchors = [
      observedComposedParentElement(element),
      observedComposedParentElement(observedComposedParentElement(element)),
      observedComposedParentElement(
        observedComposedParentElement(observedComposedParentElement(element))
      ),
    ].filter(Boolean);

    const explicitFieldLabel = observedNearestExplicitFieldLabelOf(element);
    if (observedIsMeaningfulLabel(explicitFieldLabel)) {
      return explicitFieldLabel;
    }

    for (const anchor of anchors) {
      if (!observedIsHTMLElementNode(anchor)) continue;

      const decoratedLabels = Array.from(
        anchor.querySelectorAll('[class*="label"], [data-testid*="label"]')
      ).filter((candidate) => {
        return (
          observedIsHTMLElementNode(candidate) &&
          candidate !== element &&
          !candidate.contains(element) &&
          !element.contains(candidate)
        );
      });

      for (const candidate of decoratedLabels) {
        if (
          restrictLooseCandidatesToPreceding &&
          !observedPrecedesElementInDocument(candidate, element)
        ) {
          continue;
        }
        const candidateText = observedTextOf(candidate, element);
        if (observedIsMeaningfulLabel(candidateText)) {
          return candidateText;
        }
      }

      for (const child of Array.from(anchor.children).slice(0, 8)) {
        if (!observedIsHTMLElementNode(child)) continue;
        if (child === element || child.contains(element) || element.contains(child)) continue;
        if (
          restrictLooseCandidatesToPreceding &&
          !observedPrecedesElementInDocument(child, element)
        ) {
          continue;
        }

        const candidateText = observedTextOf(child, element);
        if (observedIsMeaningfulLabel(candidateText)) {
          return candidateText;
        }
      }
    }

    return undefined;
  };

  const observedInlinePopupCurrentValueOf = (element) => {
    const explicitLabel = observedNormalizeDescriptorText(observedExplicitLabelOf(element) || '');
    const anchors = [
      observedComposedParentElement(element),
      observedComposedParentElement(observedComposedParentElement(element)),
    ].filter(Boolean);

    for (const anchor of anchors) {
      if (!observedIsHTMLElementNode(anchor)) continue;

      for (const child of Array.from(anchor.children).slice(0, 8)) {
        if (!observedIsHTMLElementNode(child)) continue;
        if (child === element || child.contains(element) || element.contains(child)) continue;
        if (!observedPrecedesElementInDocument(child, element)) continue;
        if (observedMatchesSelector(child, observedLabelLikeSelector)) continue;

        const tag = child.tagName.toLowerCase();
        if (['input', 'textarea', 'select', 'button', 'a', 'svg', 'img'].includes(tag)) {
          continue;
        }

        const candidateText = observedNormalizeDescriptorText(observedTextOf(child, element));
        if (!observedIsMeaningfulLabel(candidateText)) continue;
        if (candidateText.length > 48) continue;
        if (observedLooseActionTextRe.test(candidateText)) continue;
        if (explicitLabel && candidateText.toLowerCase() === explicitLabel.toLowerCase()) continue;

        return candidateText;
      }
    }

    return undefined;
  };

  const observedAriaLabelledbyTextOf = (element) => {
    const labelledBy = element.getAttribute('aria-labelledby')?.trim();
    if (!labelledBy) return undefined;

    const text = labelledBy
      .split(/\s+/)
      .map((id) => observedTextOf(document.getElementById(id), element))
      .filter(Boolean)
      .join(' ')
      .trim();

    return observedIsMeaningfulLabel(text) ? text : undefined;
  };

  const observedInheritedAriaLabelledbyTextOf = (element) => {
    if (!observedShouldAllowLooseFieldLabelFallback(element)) {
      return undefined;
    }

    let current = observedComposedParentElement(element);
    let depth = 0;
    while (observedIsHTMLElementNode(current) && depth < 3) {
      const labelledByText = observedAriaLabelledbyTextOf(current);
      if (observedIsMeaningfulLabel(labelledByText)) {
        const fieldLikeDescendants = Array.from(
          current.querySelectorAll(
            'input:not([type="hidden"]), textarea, select, [role="textbox"], [role="combobox"], [role="searchbox"], [role="spinbutton"], [contenteditable="true"]'
          )
        ).filter((candidate) => {
          return (
            observedIsHTMLElementNode(candidate) &&
            (candidate === element || candidate.contains(element) || element.contains(candidate))
          );
        });

        if (fieldLikeDescendants.length === 1) {
          return labelledByText;
        }
      }

      current = observedComposedParentElement(current);
      depth += 1;
    }

    return undefined;
  };

  const observedExplicitLabelOf = (element) => {
    const ariaLabel = element.getAttribute('aria-label')?.trim();
    if (observedIsMeaningfulLabel(ariaLabel)) return ariaLabel;

    const customLabel = element.getAttribute('label')?.trim();
    if (observedIsMeaningfulLabel(customLabel)) return customLabel;

    const ariaLabelledbyText = observedAriaLabelledbyTextOf(element);
    if (observedIsMeaningfulLabel(ariaLabelledbyText)) return ariaLabelledbyText;

    const labels = element.labels;
    if (labels && labels.length > 0) {
      const labelText = observedTextOf(labels[0], element);
      if (observedIsMeaningfulLabel(labelText)) return labelText;
    }

    const inheritedAriaLabelledbyText = observedInheritedAriaLabelledbyTextOf(element);
    if (observedIsMeaningfulLabel(inheritedAriaLabelledbyText)) {
      return inheritedAriaLabelledbyText;
    }

    const nearbyExplicitFieldLabel = observedNearestExplicitFieldLabelOf(element);
    if (
      observedShouldAllowLooseFieldLabelFallback(element) &&
      observedIsMeaningfulLabel(nearbyExplicitFieldLabel)
    ) {
      return nearbyExplicitFieldLabel;
    }

    const title = element.getAttribute('title')?.trim();
    if (observedIsMeaningfulLabel(title)) return title;

    return undefined;
  };

  const observedLooseFieldLabelOf = (element) => {
    if (!observedShouldAllowLooseFieldLabelFallback(element)) {
      return undefined;
    }

    const nearestFieldLabel = observedNearestFieldLabelOf(element);
    if (
      observedIsMeaningfulLabel(nearestFieldLabel) &&
      observedIsLooseFieldLabelCompatible(element, nearestFieldLabel)
    ) {
      return nearestFieldLabel;
    }

    return undefined;
  };

  const observedPopupCurrentValueOf = (element) => {
    const directValue =
      'value' in element && typeof element.value === 'string'
        ? observedNormalizeDescriptorText(element.value)
        : undefined;
    if (observedIsMeaningfulLabel(directValue)) {
      return directValue;
    }

    const tag = element.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') {
      const directText = observedTextOf(element, element);
      if (observedIsMeaningfulLabel(directText)) {
        return directText;
      }
    }

    const nearestFieldLabel = observedNearestFieldLabelOf(element);
    const compatibleLooseFieldLabel = observedLooseFieldLabelOf(element);
    const popupBacked =
      element.getAttribute('role') === 'combobox' ||
      element.hasAttribute('aria-haspopup') ||
      element.hasAttribute('aria-controls') ||
      element.hasAttribute('readonly') ||
      element.getAttribute('aria-readonly') === 'true';
    const inlinePopupValue = popupBacked ? observedInlinePopupCurrentValueOf(element) : undefined;
    if (observedIsMeaningfulLabel(inlinePopupValue)) {
      return inlinePopupValue;
    }
    if (
      popupBacked &&
      observedIsMeaningfulLabel(nearestFieldLabel) &&
      nearestFieldLabel !== compatibleLooseFieldLabel
    ) {
      return observedNormalizeDescriptorText(nearestFieldLabel);
    }

    return undefined;
  };

  const observedSyntheticLabelOf = (element) => {
    const tag = element.tagName.toLowerCase();
    const explicitRole = element.getAttribute('role')?.trim();
    if (tag === 'input') {
      const inputType = observedInputTypeOf(element);
      if (observedIsButtonLikeInput(element)) return 'Button';
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
    return undefined;
  };

  const observedInferRole = (element) => {
    const explicitRole = element.getAttribute('role')?.trim();
    if (explicitRole) return explicitRole;

    const tag = element.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && element.getAttribute('href')) return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (observedIsButtonLikeInput(element)) return 'button';
      const inputType = observedInputTypeOf(element);
      if (inputType === 'checkbox') return 'checkbox';
      if (inputType === 'radio') return 'radio';
      return 'textbox';
    }
    return '';
  };

  const observedLabelOf = (element) => {
    const explicitLabel = observedExplicitLabelOf(element);
    if (observedIsMeaningfulLabel(explicitLabel)) return explicitLabel;

    const looseFieldLabel = observedLooseFieldLabelOf(element);
    if (observedIsMeaningfulLabel(looseFieldLabel)) return looseFieldLabel;

    const text = observedTextOf(element, element);
    if (observedIsMeaningfulLabel(text)) return text;

    const syntheticLabel = observedSyntheticLabelOf(element);
    if (observedIsMeaningfulLabel(syntheticLabel)) return syntheticLabel;

    const placeholder = element.getAttribute('placeholder')?.trim();
    if (
      observedShouldAllowLooseFieldLabelFallback(element) &&
      observedIsMeaningfulLabel(placeholder)
    ) {
      return placeholder;
    }
    if (observedIsMeaningfulLabel(placeholder)) return placeholder;

    return '';
  };
`;
