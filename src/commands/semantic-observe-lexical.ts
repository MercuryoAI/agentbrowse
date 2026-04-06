import { newStemmer } from 'snowball-stemmers';

export type SemanticObserveAnalyzerKey = 'en' | 'ru' | 'neutral';

export type SemanticObserveLexicalField = {
  value?: string;
  weight: number;
};

export type SemanticObserveAnalyzedText = {
  analyzerKey: SemanticObserveAnalyzerKey;
  normalizedText?: string;
  terms: string[];
};

export type SemanticObserveLexicalDocument = {
  analyzerKey: SemanticObserveAnalyzerKey;
  weightedLength: number;
  weightedTermFrequencies: Map<string, number>;
};

export type SemanticObserveBm25CorpusStats = {
  averageDocumentLength: number;
  documentCount: number;
  documentFrequencyByTerm: Map<string, number>;
};

const TOKENIZER_FALLBACK_RE = /[\p{L}\p{N}]+/gu;
const segmenterCache = new Map<SemanticObserveAnalyzerKey, Intl.Segmenter>();
const stemmerCache = new Map<SemanticObserveAnalyzerKey, ReturnType<typeof newStemmer> | null>();

export function assertSemanticObserveRuntimeSupport(): void {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    throw new Error(
      'AgentBrowse requires Intl.Segmenter. Use a modern Node runtime with standard Intl support.'
    );
  }
}

function segmenterFor(locale: SemanticObserveAnalyzerKey): Intl.Segmenter {
  const cached = segmenterCache.get(locale);
  if (cached !== undefined) {
    return cached;
  }

  assertSemanticObserveRuntimeSupport();
  const segmenter = new Intl.Segmenter(locale === 'neutral' ? undefined : locale, {
    granularity: 'word',
  });
  segmenterCache.set(locale, segmenter);
  return segmenter;
}

function stemmerFor(locale: SemanticObserveAnalyzerKey): ReturnType<typeof newStemmer> | null {
  const cached = stemmerCache.get(locale);
  if (cached !== undefined) {
    return cached;
  }

  const algorithm = locale === 'en' ? 'english' : locale === 'ru' ? 'russian' : undefined;
  if (!algorithm) {
    stemmerCache.set(locale, null);
    return null;
  }

  const stemmer = newStemmer(algorithm);
  stemmerCache.set(locale, stemmer);
  return stemmer;
}

function isNumericToken(token: string): boolean {
  return /^[\p{N}]+$/u.test(token);
}

function detectAnalyzerKeyForToken(token: string): SemanticObserveAnalyzerKey {
  if (/[\p{Script=Cyrillic}]/u.test(token)) {
    return 'ru';
  }
  if (/[\p{Script=Latin}]/u.test(token)) {
    return 'en';
  }
  return 'neutral';
}

export function normalizeSemanticObserveText(value: string | undefined): string | undefined {
  const normalized = value?.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return normalized ? normalized : undefined;
}

export function dominantSemanticObserveAnalyzerKey(
  value: string | undefined
): SemanticObserveAnalyzerKey {
  const normalized = normalizeSemanticObserveText(value);
  if (!normalized) {
    return 'neutral';
  }

  let latinCount = 0;
  let cyrillicCount = 0;
  for (const token of normalized.match(TOKENIZER_FALLBACK_RE) ?? []) {
    const key = detectAnalyzerKeyForToken(token);
    if (key === 'en') {
      latinCount += 1;
    } else if (key === 'ru') {
      cyrillicCount += 1;
    }
  }

  if (cyrillicCount > latinCount) {
    return 'ru';
  }
  if (latinCount > 0) {
    return 'en';
  }
  return 'neutral';
}

function segmentSemanticObserveText(
  normalizedText: string,
  locale: SemanticObserveAnalyzerKey
): string[] {
  const segmenter = segmenterFor(locale);
  const tokens: string[] = [];
  for (const segment of segmenter.segment(normalizedText)) {
    if (segment.isWordLike === false) {
      continue;
    }
    const token = normalizeSemanticObserveText(segment.segment);
    if (!token) {
      continue;
    }
    if (!/[\p{L}\p{N}]/u.test(token)) {
      continue;
    }
    tokens.push(token);
  }
  return tokens;
}

function stemSemanticObserveToken(token: string): string {
  const analyzerKey = detectAnalyzerKeyForToken(token);
  const stemmer = stemmerFor(analyzerKey);
  if (!stemmer) {
    return token;
  }

  const stemmed = normalizeSemanticObserveText(stemmer.stem(token));
  return stemmed && (stemmed.length >= 2 || isNumericToken(stemmed)) ? stemmed : token;
}

export function analyzeSemanticObserveText(value: string | undefined): SemanticObserveAnalyzedText {
  const normalizedText = normalizeSemanticObserveText(value);
  if (!normalizedText) {
    return {
      analyzerKey: 'neutral',
      normalizedText: undefined,
      terms: [],
    };
  }

  const analyzerKey = dominantSemanticObserveAnalyzerKey(normalizedText);
  const segmented = segmentSemanticObserveText(normalizedText, analyzerKey);
  const terms = segmented
    .map((token) => stemSemanticObserveToken(token))
    .filter((token) => token.length >= 2 || isNumericToken(token));

  return {
    analyzerKey,
    normalizedText,
    terms,
  };
}

export function buildSemanticObserveLexicalDocument(
  fields: ReadonlyArray<SemanticObserveLexicalField>
): SemanticObserveLexicalDocument {
  const weightedTermFrequencies = new Map<string, number>();
  const analyzerVotes = new Map<SemanticObserveAnalyzerKey, number>();
  let weightedLength = 0;

  for (const field of fields) {
    if (field.weight <= 0) {
      continue;
    }

    const analyzed = analyzeSemanticObserveText(field.value);
    if (analyzed.terms.length === 0) {
      continue;
    }

    analyzerVotes.set(
      analyzed.analyzerKey,
      (analyzerVotes.get(analyzed.analyzerKey) ?? 0) + analyzed.terms.length
    );
    weightedLength += analyzed.terms.length * field.weight;
    for (const term of analyzed.terms) {
      weightedTermFrequencies.set(term, (weightedTermFrequencies.get(term) ?? 0) + field.weight);
    }
  }

  const analyzerKey =
    [...analyzerVotes.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 'neutral';

  return {
    analyzerKey,
    weightedLength,
    weightedTermFrequencies,
  };
}

export function buildSemanticObserveBm25CorpusStats(
  documents: ReadonlyArray<SemanticObserveLexicalDocument>
): SemanticObserveBm25CorpusStats {
  const documentFrequencyByTerm = new Map<string, number>();
  let totalLength = 0;

  for (const document of documents) {
    totalLength += document.weightedLength;
    for (const term of document.weightedTermFrequencies.keys()) {
      documentFrequencyByTerm.set(term, (documentFrequencyByTerm.get(term) ?? 0) + 1);
    }
  }

  return {
    averageDocumentLength: documents.length > 0 ? totalLength / documents.length : 0,
    documentCount: documents.length,
    documentFrequencyByTerm,
  };
}

export function scoreSemanticObserveBm25(
  query: SemanticObserveAnalyzedText,
  document: SemanticObserveLexicalDocument,
  corpus: SemanticObserveBm25CorpusStats,
  options: { k1?: number; b?: number } = {}
): number {
  if (
    query.terms.length === 0 ||
    document.weightedTermFrequencies.size === 0 ||
    corpus.documentCount === 0
  ) {
    return 0;
  }

  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  const averageDocumentLength = Math.max(corpus.averageDocumentLength, 1);
  const documentLength = Math.max(document.weightedLength, 1);
  const uniqueTerms = [...new Set(query.terms)];
  let score = 0;

  for (const term of uniqueTerms) {
    const termFrequency = document.weightedTermFrequencies.get(term) ?? 0;
    if (termFrequency <= 0) {
      continue;
    }

    const documentFrequency = corpus.documentFrequencyByTerm.get(term) ?? 0;
    const idf = Math.log(
      1 + (corpus.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5)
    );
    const denominator = termFrequency + k1 * (1 - b + b * (documentLength / averageDocumentLength));
    score += idf * ((termFrequency * (k1 + 1)) / denominator);
  }

  return score;
}
