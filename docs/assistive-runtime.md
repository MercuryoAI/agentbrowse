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
  assistiveRuntime: {
    createLlmClient: () => ({
      async createChatCompletion(args) {
        const { messages, response_model, image, temperature, maxOutputTokens } = args.options;

        const json = await callStructuredProvider({
          messages,
          responseModel: response_model,
          image,
          temperature,
          maxOutputTokens,
        });

        return {
          data: json.data,
          usage: json.usage,
        };
      },
    }),
  },
});
```

This pattern works well when:

- your app is multi-tenant
- you run parallel tests
- different consumers in one process need different LLM settings

## OpenAI-Compatible Helper Example

You can wrap the adapter once and reuse it:

```ts
function createOpenAiCompatibleAssistiveRuntime(input: {
  baseUrl: string;
  apiKey: string;
}) {
  return {
    createLlmClient: () => ({
      async createChatCompletion(args) {
        const { messages, response_model, image, temperature, maxOutputTokens } = args.options;

        const json = await callStructuredProvider({
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          messages,
          responseModel: response_model,
          image,
          temperature,
          maxOutputTokens,
        });

        return {
          data: json.data,
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
