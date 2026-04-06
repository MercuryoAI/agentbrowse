import type { Stagehand } from '@browserbasehq/stagehand';
import type { z } from 'zod';
import type { BrowserSessionState } from './browser-session-state.js';
import { getAgentbrowseSessionBindings } from './client-bindings.js';
import { connectStagehand } from './stagehand.js';

/** Token usage reported by an assistive LLM provider. */
export interface AgentbrowseAssistiveLlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_input_tokens?: number;
  reasoning_tokens?: number;
}

/** Single text-or-image content entry in an assistive user message. */
export type AgentbrowseAssistiveMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'auto' } };

/** Single assistive chat message sent to the configured LLM client. */
export interface AgentbrowseAssistiveChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | AgentbrowseAssistiveMessageContentPart[];
}

/** Optional screenshot-style image payload passed to the assistive runtime. */
export interface AgentbrowseAssistiveImageInput {
  buffer: Buffer;
  description?: string;
}

/** Structured output contract requested from the assistive runtime. */
export interface AgentbrowseAssistiveResponseModel {
  name: string;
  schema: z.ZodTypeAny;
}

/** Request options passed to `createChatCompletion(...)`. */
export interface AgentbrowseAssistiveChatCompletionOptions {
  messages: AgentbrowseAssistiveChatMessage[];
  response_model?: AgentbrowseAssistiveResponseModel;
  temperature?: number;
  maxOutputTokens?: number;
  image?: AgentbrowseAssistiveImageInput;
}

/** Single structured assistive LLM request. */
export interface AgentbrowseAssistiveChatCompletionRequest {
  logger?: (...args: unknown[]) => void;
  options: AgentbrowseAssistiveChatCompletionOptions;
}

/** Structured assistive LLM response returned to AgentBrowse. */
export interface AgentbrowseAssistiveChatCompletionResult<T = unknown> {
  data: T;
  usage?: AgentbrowseAssistiveLlmUsage;
}

/** Minimal LLM client contract required by assistive AgentBrowse features. */
export interface AgentbrowseAssistiveLlmClient {
  createChatCompletion<T = unknown>(
    args: AgentbrowseAssistiveChatCompletionRequest
  ): Promise<AgentbrowseAssistiveChatCompletionResult<T>>;
}

/** Assistive runtime configuration for goal-based observe and extract flows. */
export interface AgentbrowseAssistiveRuntime {
  createLlmClient: () => AgentbrowseAssistiveLlmClient;
  connectStagehand?: (input: {
    cdpUrl: string;
    llmClient: AgentbrowseAssistiveLlmClient;
  }) => Promise<Stagehand>;
}

export class AgentbrowseAssistiveRuntimeMissingError extends Error {
  readonly feature: string;

  constructor(feature: string) {
    super(
      `AgentBrowse assistive runtime is not configured for ${feature}. Configure it in the orchestration layer before using assistive browser features.`
    );
    this.name = 'AgentbrowseAssistiveRuntimeMissingError';
    this.feature = feature;
  }
}

export class AssistiveStructuredOutputTruncatedError extends Error {
  readonly status: number;
  readonly provider?: string;
  readonly model?: string;
  readonly finishReason?: string;
  readonly maxOutputTokens?: number;
  readonly completionTokens?: number;

  constructor(
    message: string,
    params: {
      status: number;
      provider?: string;
      model?: string;
      finishReason?: string;
      maxOutputTokens?: number;
      completionTokens?: number;
    }
  ) {
    super(message);
    this.name = 'AssistiveStructuredOutputTruncatedError';
    this.status = params.status;
    this.provider = params.provider;
    this.model = params.model;
    this.finishReason = params.finishReason;
    this.maxOutputTokens = params.maxOutputTokens;
    this.completionTokens = params.completionTokens;
  }
}

let configuredAssistiveRuntime: AgentbrowseAssistiveRuntime | null = null;

function resolveAssistiveRuntime(
  options: {
    session?: BrowserSessionState | null;
    runtime?: AgentbrowseAssistiveRuntime | null;
  } = {}
): AgentbrowseAssistiveRuntime | null {
  if (options.runtime) {
    return options.runtime;
  }

  const boundRuntime = options.session
    ? (getAgentbrowseSessionBindings(options.session)?.assistiveRuntime ?? null)
    : null;

  return boundRuntime ?? configuredAssistiveRuntime;
}

export function configureAgentbrowseAssistiveRuntime(
  runtime: AgentbrowseAssistiveRuntime | null
): void {
  configuredAssistiveRuntime = runtime;
}

export function resetAgentbrowseAssistiveRuntime(): void {
  configuredAssistiveRuntime = null;
}

/** Returns a best-effort assistive LLM client for the provided session or runtime. */
export function tryCreateAgentbrowseAssistiveLlmClient(
  options: {
    session?: BrowserSessionState | null;
    runtime?: AgentbrowseAssistiveRuntime | null;
  } = {}
): AgentbrowseAssistiveLlmClient | null {
  return resolveAssistiveRuntime(options)?.createLlmClient() ?? null;
}

/** Returns `true` when assistive LLM-backed features can run for the session. */
export function canUseAgentbrowseAssistiveLlmClient(
  options: {
    session?: BrowserSessionState | null;
    runtime?: AgentbrowseAssistiveRuntime | null;
  } = {}
): boolean {
  try {
    return tryCreateAgentbrowseAssistiveLlmClient(options) !== null;
  } catch {
    return false;
  }
}

/** Returns the configured assistive LLM client or throws when none is available. */
export function requireAgentbrowseAssistiveLlmClient(
  feature: string,
  options: {
    session?: BrowserSessionState | null;
    runtime?: AgentbrowseAssistiveRuntime | null;
  } = {}
): AgentbrowseAssistiveLlmClient {
  const client = tryCreateAgentbrowseAssistiveLlmClient(options);
  if (!client) {
    throw new AgentbrowseAssistiveRuntimeMissingError(feature);
  }
  return client;
}

/** Connects Stagehand through the configured assistive runtime for the session. */
export async function connectConfiguredAssistiveStagehand(
  cdpUrl: string,
  options: {
    session?: BrowserSessionState | null;
    runtime?: AgentbrowseAssistiveRuntime | null;
  } = {}
): Promise<Stagehand> {
  const runtime = resolveAssistiveRuntime(options);
  const llmClient = requireAgentbrowseAssistiveLlmClient('assistive stagehand execution', options);
  if (runtime?.connectStagehand) {
    return runtime.connectStagehand({
      cdpUrl,
      llmClient,
    });
  }

  return connectStagehand(cdpUrl, {
    llmClient,
  });
}
