export type ObservedControlLabelPolicyEvidence = {
  tag?: string;
  role?: string;
  inputType?: string;
};

export function isButtonLikeObservedInput(
  evidence: Pick<ObservedControlLabelPolicyEvidence, 'tag' | 'inputType'>
): boolean {
  const tag = (evidence.tag ?? '').trim().toLowerCase();
  if (tag !== 'input') {
    return false;
  }

  const inputType = (evidence.inputType ?? '').trim().toLowerCase() || 'text';
  return inputType === 'button' || inputType === 'submit' || inputType === 'reset';
}

export function shouldAllowLooseFieldLabelFallbackForObservedControl(
  evidence: ObservedControlLabelPolicyEvidence
): boolean {
  const tag = (evidence.tag ?? '').trim().toLowerCase();
  const role = (evidence.role ?? '').trim().toLowerCase();

  if (tag === 'input') {
    return !isButtonLikeObservedInput(evidence);
  }

  return (
    tag === 'textarea' ||
    tag === 'select' ||
    role === 'textbox' ||
    role === 'combobox' ||
    role === 'searchbox' ||
    role === 'spinbutton'
  );
}
