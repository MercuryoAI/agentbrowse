const SUSPICIOUS_LINE_LENGTH = 220;
const SUSPICIOUS_TOKEN_LENGTH = 120;
const MIN_MACHINE_PUNCTUATION_RATIO = 0.18;
const MAX_SCOPED_EXTRACT_LINES = 160;
const MAX_SCOPED_EXTRACT_CHARS = 12_000;

const SCRIPT_MARKERS = [
  /\bwindow\./i,
  /\bdocument\./i,
  /\bwebpack/i,
  /\b__next_data__\b/i,
  /\bfunction\b/,
  /\bconst\b/,
  /\blet\b/,
  /\bvar\b/,
  /\breturn\b/,
  /=>/,
  /\bJSON\.parse\(/,
];

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function extractLineContent(line: string): string {
  const quotedContent = line.match(/"([\s\S]*)"$/);
  if (quotedContent?.[1]) {
    return quotedContent[1];
  }

  return line.replace(/^\s*\[[^\]]+\]\s*/, '').trim();
}

function punctuationRatio(value: string): number {
  if (!value.length) {
    return 0;
  }

  const punctuationChars = countMatches(value, /[{}[\]();,:=<>\\/]/g);
  return punctuationChars / value.length;
}

function longestTokenLength(value: string): number {
  return value.split(/\s+/).reduce((longest, token) => Math.max(longest, token.length), 0);
}

function looksLikeJsonBlob(value: string): boolean {
  const braces = countMatches(value, /[{}[\]]/g);
  const quotes = countMatches(value, /"/g);
  const colons = countMatches(value, /:/g);
  const commas = countMatches(value, /,/g);

  return braces >= 6 && quotes >= 6 && colons >= 3 && commas >= 2;
}

function looksLikeScriptBlob(value: string): boolean {
  return SCRIPT_MARKERS.some((pattern) => pattern.test(value));
}

function isLikelyMachineBlob(value: string): boolean {
  const longLine = value.length >= SUSPICIOUS_LINE_LENGTH;
  const longToken = longestTokenLength(value) >= SUSPICIOUS_TOKEN_LENGTH;
  const densePunctuation = punctuationRatio(value) >= MIN_MACHINE_PUNCTUATION_RATIO;
  const escapedNoise = countMatches(value, /(?:\\u[0-9a-f]{4}|\\\\|\\")/gi) >= 4;
  const structuredNoise = looksLikeJsonBlob(value) || looksLikeScriptBlob(value) || escapedNoise;

  if (!structuredNoise) {
    return false;
  }

  return longLine || longToken || densePunctuation;
}

export function sanitizeExtractSnapshot(snapshot: string): string {
  const lines = snapshot.split(/\r?\n/);
  const sanitized = lines.filter((line) => {
    const content = extractLineContent(line);
    return !isLikelyMachineBlob(content);
  });

  return sanitized.some((line) => line.trim()) ? sanitized.join('\n') : snapshot;
}

function trimSnapshotToBudget(
  snapshot: string,
  options: { maxLines: number; maxChars: number }
): string {
  const lines = snapshot.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const kept: string[] = [];
  let totalChars = 0;

  for (const line of lines) {
    const nextChars = totalChars + line.length + (kept.length > 0 ? 1 : 0);
    if (kept.length >= options.maxLines || nextChars > options.maxChars) {
      break;
    }

    kept.push(line);
    totalChars = nextChars;
  }

  if (kept.length === 0) {
    return snapshot;
  }

  const trimmed = kept.join('\n');
  return trimmed.length >= Math.floor(snapshot.length * 0.35) ? trimmed : snapshot;
}

export function budgetExtractSnapshot(
  snapshot: string,
  options: { scoped?: boolean } = {}
): string {
  if (!options.scoped) {
    return snapshot;
  }

  const lines = snapshot.split(/\r?\n/);
  if (lines.length <= MAX_SCOPED_EXTRACT_LINES && snapshot.length <= MAX_SCOPED_EXTRACT_CHARS) {
    return snapshot;
  }

  return trimSnapshotToBudget(snapshot, {
    maxLines: MAX_SCOPED_EXTRACT_LINES,
    maxChars: MAX_SCOPED_EXTRACT_CHARS,
  });
}
