import { createAgentbrowseClient } from '../src/library.ts';

const openAiApiKey = process.env.OPENAI_API_KEY;

if (!openAiApiKey) {
  throw new Error('Set OPENAI_API_KEY before running this example.');
}

const client = createAgentbrowseClient({
  assistiveRuntime: {
    createLlmClient: () => ({
      async createChatCompletion(args) {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${openAiApiKey}`,
          },
          body: JSON.stringify(args),
        });

        if (!response.ok) {
          throw new Error(`openai_request_failed:${response.status}`);
        }

        return (await response.json()) as any;
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
