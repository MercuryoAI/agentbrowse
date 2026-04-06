import { toJsonSchema } from '@browserbasehq/stagehand';
import {
  type AgentbrowseAssistiveChatCompletionOptions,
  type AgentbrowseAssistiveChatCompletionRequest,
  type AgentbrowseAssistiveChatCompletionResult,
  type AgentbrowseAssistiveLlmUsage,
  AssistiveStructuredOutputTruncatedError,
  configureAgentbrowseAssistiveRuntime,
  resetAgentbrowseAssistiveRuntime,
} from './assistive-runtime.js';

type StructuredChatResponse<T> = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type StructuredChatErrorResponse = {
  error?: unknown;
  error_code?: unknown;
  provider?: unknown;
  model?: unknown;
  finish_reason?: unknown;
  max_output_tokens?: unknown;
  completion_tokens?: unknown;
};

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeApiUrl(value: string): string {
  return value.replace(/\/$/, '');
}

function normalizeUsage(
  usage: StructuredChatResponse<unknown>['usage']
): AgentbrowseAssistiveLlmUsage | undefined {
  if (
    !usage ||
    typeof usage.prompt_tokens !== 'number' ||
    typeof usage.completion_tokens !== 'number' ||
    typeof usage.total_tokens !== 'number'
  ) {
    return undefined;
  }

  return usage;
}

function buildMessages(options: AgentbrowseAssistiveChatCompletionOptions) {
  const messages = [...options.messages];
  if (!options.image) {
    return messages;
  }

  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail: 'auto' } }
  > = [];

  if (options.image.description?.trim()) {
    content.push({ type: 'text', text: options.image.description.trim() });
  }

  content.push({
    type: 'image_url',
    image_url: {
      url: `data:image/jpeg;base64,${options.image.buffer.toString('base64')}`,
      detail: 'auto',
    },
  });

  messages.push({
    role: 'user',
    content,
  });

  return messages;
}

export function installFetchBackedTestAssistiveRuntime(
  options: {
    apiKey?: string;
    apiUrl?: string;
    model?: string;
  } = {}
): void {
  const apiKey = options.apiKey ?? 'ap_test';
  const apiUrl = normalizeApiUrl(options.apiUrl ?? 'https://example.com/api');
  const model = options.model ?? 'magicpay';

  configureAgentbrowseAssistiveRuntime({
    createLlmClient: () => ({
      async createChatCompletion<T>({
        options,
      }: AgentbrowseAssistiveChatCompletionRequest): Promise<
        AgentbrowseAssistiveChatCompletionResult<T>
      > {
        if (!options.response_model) {
          throw new Error('Test assistive runtime requires response_model');
        }

        const response = await fetch(`${apiUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: buildMessages(options),
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: options.response_model.name,
                strict: true,
                schema: toJsonSchema(options.response_model.schema),
              },
            },
            temperature: options.temperature,
            max_completion_tokens: options.maxOutputTokens,
          }),
        });
        const json = (await response.json()) as StructuredChatResponse<T> &
          StructuredChatErrorResponse;

        if (!response.ok) {
          if (json.error_code === 'structured_output_truncated') {
            throw new AssistiveStructuredOutputTruncatedError(
              `Test assistive runtime error (${response.status})`,
              {
                status: response.status,
                provider: readString(json.provider),
                model: readString(json.model),
                finishReason: readString(json.finish_reason),
                maxOutputTokens: readNumber(json.max_output_tokens),
                completionTokens: readNumber(json.completion_tokens),
              }
            );
          }

          const message =
            typeof json.error === 'string'
              ? json.error
              : `Test assistive runtime HTTP ${response.status}`;
          throw new Error(message);
        }

        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim().length === 0) {
          throw new Error('Test assistive runtime response missing assistant content');
        }

        return {
          data: JSON.parse(content) as T,
          usage: normalizeUsage(json.usage),
        };
      },
    }),
  });
}

export function uninstallTestAssistiveRuntime(): void {
  resetAgentbrowseAssistiveRuntime();
}
