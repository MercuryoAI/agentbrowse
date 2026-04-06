import type { BrowserSessionState } from './browser-session-state.js';
import {
  createLlmUsageBucket,
  createPayloadBudgetMetrics,
  ensureMetricsExtensions,
  ensureRuntimeState,
  type BrowsePayloadBudgetMetrics,
  type BrowseRuntimeMetrics,
} from './runtime-state.js';

type NumericBrowseRuntimeMetricKey = Exclude<
  {
    [K in keyof BrowseRuntimeMetrics]: BrowseRuntimeMetrics[K] extends number | undefined
      ? K
      : never;
  }[keyof BrowseRuntimeMetrics],
  undefined
>;

type LlmUsageLike = Partial<{
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_input_tokens: number;
  reasoning_tokens: number;
}>;

export function incrementMetric(
  session: BrowserSessionState,
  metric: NumericBrowseRuntimeMetricKey,
  by = 1
): number {
  const runtime = ensureRuntimeState(session);
  runtime.metrics[metric] = (runtime.metrics[metric] ?? 0) + by;
  return runtime.metrics[metric] ?? 0;
}

export function recordActionResult(
  session: BrowserSessionState,
  success: boolean,
  durationMs: number
): BrowseRuntimeMetrics {
  const runtime = ensureRuntimeState(session);
  ensureMetricsExtensions(runtime.metrics);
  if (success) {
    runtime.metrics.successfulActions += 1;
  } else {
    runtime.metrics.failedActions += 1;
  }

  runtime.metrics.totalActionDurationMs += Math.max(0, durationMs);
  const attempts = runtime.metrics.successfulActions + runtime.metrics.failedActions;
  runtime.metrics.successRate = attempts === 0 ? 0 : runtime.metrics.successfulActions / attempts;
  runtime.metrics.averageActionDurationMs =
    attempts === 0 ? 0 : runtime.metrics.totalActionDurationMs / attempts;
  return runtime.metrics;
}

export function recordLlmUsage(
  session: BrowserSessionState,
  params: {
    purpose: string;
    usage?: LlmUsageLike | null;
    inputChars?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  }
): BrowseRuntimeMetrics {
  const runtime = ensureRuntimeState(session);
  ensureMetricsExtensions(runtime.metrics);

  const promptTokens = params.promptTokens ?? params.usage?.prompt_tokens ?? 0;
  const completionTokens = params.completionTokens ?? params.usage?.completion_tokens ?? 0;
  const totalTokens =
    params.totalTokens ??
    params.usage?.total_tokens ??
    (promptTokens > 0 || completionTokens > 0 ? promptTokens + completionTokens : 0);
  const cachedInputTokens = params.cachedInputTokens ?? params.usage?.cached_input_tokens ?? 0;
  const reasoningTokens = params.reasoningTokens ?? params.usage?.reasoning_tokens ?? 0;
  const inputChars = params.inputChars ?? 0;

  runtime.metrics.llmCalls = (runtime.metrics.llmCalls ?? 0) + 1;
  runtime.metrics.llmPromptTokens = (runtime.metrics.llmPromptTokens ?? 0) + promptTokens;
  runtime.metrics.llmCompletionTokens =
    (runtime.metrics.llmCompletionTokens ?? 0) + completionTokens;
  runtime.metrics.llmTotalTokens = (runtime.metrics.llmTotalTokens ?? 0) + totalTokens;
  runtime.metrics.llmCachedInputTokens =
    (runtime.metrics.llmCachedInputTokens ?? 0) + cachedInputTokens;
  runtime.metrics.llmReasoningTokens = (runtime.metrics.llmReasoningTokens ?? 0) + reasoningTokens;

  const purposeKey = params.purpose.trim().length > 0 ? params.purpose.trim() : 'unknown';
  const bucket = runtime.metrics.llmUsageByPurpose?.[purposeKey] ?? createLlmUsageBucket();
  bucket.calls += 1;
  bucket.inputChars += inputChars;
  bucket.promptTokens += promptTokens;
  bucket.completionTokens += completionTokens;
  bucket.totalTokens += totalTokens;
  bucket.cachedInputTokens += cachedInputTokens;
  bucket.reasoningTokens += reasoningTokens;
  runtime.metrics.llmUsageByPurpose![purposeKey] = bucket;

  return runtime.metrics;
}

export function recordPayloadBudget(
  session: BrowserSessionState,
  patch: Partial<BrowsePayloadBudgetMetrics>
): BrowseRuntimeMetrics {
  const runtime = ensureRuntimeState(session);
  ensureMetricsExtensions(runtime.metrics);
  const payloadBudget = runtime.metrics.payloadBudget ?? createPayloadBudgetMetrics();

  for (const [key, value] of Object.entries(patch) as Array<
    [keyof BrowsePayloadBudgetMetrics, number | undefined]
  >) {
    if (!Number.isFinite(value)) {
      continue;
    }
    payloadBudget[key] += value ?? 0;
  }

  runtime.metrics.payloadBudget = payloadBudget;
  return runtime.metrics;
}
