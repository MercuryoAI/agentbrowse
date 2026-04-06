function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeObserveLiveValue(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  if (!normalized || normalized.length > 80) {
    return undefined;
  }
  return normalized;
}

export function observeLabelIncludesValue(label: string, value: string): boolean {
  const normalizedLabel = normalizeText(label).toLowerCase();
  const normalizedValue = normalizeText(value).toLowerCase();
  return Boolean(normalizedValue) && normalizedLabel.includes(normalizedValue);
}

export function buildObserveDisplayLabel(
  baseLabel: string | undefined,
  liveValue: string | undefined
): string | undefined {
  const normalizedLabel = normalizeText(baseLabel);
  const normalizedValue = normalizeObserveLiveValue(liveValue);

  if (!normalizedLabel || !normalizedValue) {
    return undefined;
  }

  if (observeLabelIncludesValue(normalizedLabel, normalizedValue)) {
    return undefined;
  }

  return `${normalizedLabel} — ${normalizedValue}`;
}
