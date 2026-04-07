# AgentBrowse Assistive Runtime Guide

This guide explains when you need an assistive runtime and how to connect one.

## What "Assistive" Means

AgentBrowse has two broad kinds of behavior:

- browser-only behavior, which does not call an LLM
- assistive behavior, which can call an LLM to better understand the page or
  produce structured output

Today, assistive behavior matters mainly for:

- `extract(session, schema, scopeRef?)`
- higher-quality goal-based `observe(session, goal)`

If you only need browser actions and normal page inspection, you can ignore
assistive runtime completely.

## The Runtime Contract

AgentBrowse does not ship a built-in OpenAI or OpenRouter adapter.

Instead, you provide a small runtime object with one responsibility:
create a chat-completions client.

The shape is:

```ts
{
  createLlmClient: () => ({
    async createChatCompletion(args) {
      const { messages, response_model, image, temperature, maxOutputTokens } = args.options;
      // map these values to your provider here
    }
  })
}
```

That means any OpenAI-compatible chat-completions backend can work, as long as
your adapter returns the expected response shape.

## Recommended Setup

```ts
import { createAgentbrowseClient } from '@mercuryo-ai/agentbrowse';

const client = createAgentbrowseClient({
  assistiveRuntime: createOpenAiCompatibleAssistiveRuntime({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4.1-mini',
  }),
});
```

This pattern works well when:

- your app is multi-tenant
- you run parallel tests
- different consumers in one process need different LLM settings

## OpenAI-Compatible Helper Example

You can wrap the adapter once and reuse it:

```ts
import { toJsonSchema } from '@browserbasehq/stagehand';
import type {
  AgentbrowseAssistiveChatCompletionOptions,
  AgentbrowseAssistiveLlmUsage,
} from '@mercuryo-ai/agentbrowse';

type StructuredChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: AgentbrowseAssistiveLlmUsage;
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

function createOpenAiCompatibleAssistiveRuntime(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
}) {
  const baseUrl = input.baseUrl.replace(/\/$/, '');

  return {
    createLlmClient: () => ({
      async createChatCompletion({ options }) {
        if (!options.response_model) {
          throw new Error('AgentBrowse assistive extract requires response_model.');
        }

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${input.apiKey}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: input.model,
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
          throw new Error(`assistive_provider_http_${response.status}`);
        }

        const json = (await response.json()) as StructuredChatResponse;
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim().length === 0) {
          throw new Error('assistive_provider_missing_content');
        }

        return {
          data: JSON.parse(content),
          usage: json.usage,
        };
      },
    }),
  };
}
```

Examples:

- OpenAI base URL:
  `https://api.openai.com/v1`
- OpenRouter base URL:
  `https://openrouter.ai/api/v1`

## Small Script Fallback

For small scripts, you can also use:

```ts
import { configureAgentbrowseAssistiveRuntime } from '@mercuryo-ai/agentbrowse';
```

This is a convenience fallback, not the preferred embedded pattern.

## What Happens Without Assistive Runtime

- `extract(...)` cannot run successfully
- `observe(session, goal)` still runs, but quality may be lower because
  AgentBrowse falls back to local heuristics instead of LLM-assisted ranking

## Testing Runtime

For test suites that wrap AgentBrowse, use the dedicated testing subpath:

```ts
import {
  installFetchBackedTestAssistiveRuntime,
  uninstallTestAssistiveRuntime,
} from '@mercuryo-ai/agentbrowse/testing';
```

That helper installs a fetch-backed runtime with the same public assistive
runtime contract used by the main package.
