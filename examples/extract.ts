import { toJsonSchema } from '@browserbasehq/stagehand';
import {
  createAgentbrowseClient,
  type AgentbrowseAssistiveChatCompletionOptions,
} from '@mercuryo-ai/agentbrowse';

type StructuredChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

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

const openAiApiKey = process.env.OPENAI_API_KEY;
const openAiBaseUrl = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(
  /\/$/,
  ''
);
const openAiModel = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

if (!openAiApiKey) {
  throw new Error('Set OPENAI_API_KEY before running this example.');
}

const client = createAgentbrowseClient({
  assistiveRuntime: {
    createLlmClient: () => ({
      async createChatCompletion({ options }) {
        if (!options.response_model) {
          throw new Error('AgentBrowse extract requires response_model in the assistive runtime.');
        }

        const response = await fetch(`${openAiBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${openAiApiKey}`,
          },
          body: JSON.stringify({
            model: openAiModel,
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

        if (!response.ok) {
          throw new Error(`openai_request_failed:${response.status}`);
        }

        const json = (await response.json()) as StructuredChatResponse;
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim().length === 0) {
          throw new Error('openai_response_missing_content');
        }

        return {
          data: JSON.parse(content),
          usage: json.usage,
        };
      },
    }),
  },
});

const launchResult = await client.launch('https://example.com');
if (!launchResult.success) {
  throw new Error(launchResult.reason ?? launchResult.message);
}

try {
  const extractResult = await client.extract(launchResult.session, {
    page_title: 'string',
    page_url: 'string',
  });

  if (!extractResult.success) {
    throw new Error(extractResult.reason ?? extractResult.message);
  }

  console.info(extractResult.data);
} finally {
  await client.close(launchResult.session);
}
