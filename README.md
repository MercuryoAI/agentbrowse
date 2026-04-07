# @mercuryo-ai/agentbrowse

Browser automation library for agent systems.

AgentBrowse is for the part of your system that has to work with a real web
page.

If your application already knows what it is trying to do, AgentBrowse gives
you the browser layer for that work:

- launch a managed browser or attach to an existing CDP browser session;
- inspect the current page;
- interact with stable target references instead of raw selectors;
- extract structured data from the page;
- optionally use an LLM when page understanding needs help.

Your app keeps control of orchestration, state, policies, and business logic.
AgentBrowse focuses on the page itself.

A good first way to think about it is:

1. launch a browser or attach to one and get a `session`
2. inspect the page with `observe(...)`
3. use `act(...)` to interact with what you found
4. use `extract(...)` when you need structured data instead of an action
5. close the session when you are done

This makes AgentBrowse fit naturally into a worker, backend service, CLI, or
agent runtime that already exists.

## Install

```bash
npm i @mercuryo-ai/agentbrowse
```

If you want the operator-facing CLI, install `@mercuryo-ai/agentbrowse-cli`.

## The Core Mental Model

There are four ideas you need to understand before using the library:

- `session`
  The handle for a running browser. `launch(...)` or `attach(...)` returns it,
  and you pass it into the rest of the API.
- `observe`
  Reads the page and tells you what AgentBrowse found: targets, scopes,
  signals, and forms.
- `ref`
  A stable reference returned by `observe(...)`. You use it with `act(...)`
  instead of managing selectors yourself.
- `assistive runtime`
  Optional LLM-backed page understanding. You only need it for extraction and
  for better quality in some goal-based `observe(session, goal)` calls.

## Quick Start

This is the normal managed-browser flow. It does not require LLM setup.

```ts
import {
  act,
  close,
  launch,
  navigate,
  observe,
  screenshot,
  status,
} from '@mercuryo-ai/agentbrowse';

const launchResult = await launch('https://example.com');
if (!launchResult.success) {
  throw new Error(launchResult.reason ?? launchResult.message);
}

const { session } = launchResult;

try {
  const observeResult = await observe(session);
  if (!observeResult.success) {
    throw new Error(observeResult.reason ?? observeResult.message);
  }

  const firstActionableTarget = observeResult.targets.find((target) => typeof target.ref === 'string');

  if (firstActionableTarget?.ref) {
    const actResult = await act(session, firstActionableTarget.ref, 'click');
    if (!actResult.success) {
      throw new Error(actResult.reason ?? actResult.message);
    }
  }

  const navigateResult = await navigate(session, 'https://example.com/checkout');
  if (!navigateResult.success) {
    throw new Error(navigateResult.reason ?? navigateResult.message);
  }

  const screenshotResult = await screenshot(session, '/tmp/checkout.png');
  if (!screenshotResult.success) {
    throw new Error(screenshotResult.reason ?? screenshotResult.message);
  }

  const statusResult = await status(session);
  if (!statusResult.success) {
    throw new Error(statusResult.reason ?? statusResult.message);
  }
} finally {
  await close(session);
}
```

Runnable examples live in [`examples/`](./examples/README.md):

- first run `npm run build` when executing them from this repo
- `npx tsx examples/basic.ts`
- `npx tsx examples/attach.ts`
- `npx tsx examples/extract.ts`

## Managed Launch Runtime Note

When you use `launch(...)`, the package includes `puppeteer` for the managed
browser connection layer with stealth evasions enabled by default.

The goal is practical: reduce unnecessary anti-bot friction such as extra
captcha or challenge pages on sensitive sites.

After the browser is up, the normal live browser interaction flow still runs
over Playwright CDP.

The library entrypoint does not load `.env` files. Environment loading is only
part of the CLI entrypoint.

## Attach To An Existing Browser

If you already have a browser that exposes a CDP websocket, use `attach(...)`
instead of `launch(...)`.

That works for:

- a local Chrome or Chromium process started with remote debugging enabled;
- a cloud browser session that gives you a CDP websocket URL;
- any other browser runtime that Playwright can reach through CDP.

```ts
import { attach, observe } from '@mercuryo-ai/agentbrowse';

const attached = await attach('ws://127.0.0.1:9222/devtools/browser/browser-id');
if (!attached.success) {
  throw new Error(attached.reason ?? attached.message);
}

const observeResult = await observe(attached.session);
if (!observeResult.success) {
  throw new Error(observeResult.reason ?? observeResult.message);
}
```

If your provider gives you a labeled remote session, you can carry that label
in the session handle:

```ts
const attached = await attach(remoteCdpUrl, {
  provider: 'browserbase',
});
```

## What Each Main API Does

| API | Use it when | Typical result |
| --- | --- | --- |
| `launch(url?, options?)` | You need a new browser session | `session`, current `url`, current `title` |
| `attach(cdpUrl, options?)` | You already have a running browser that exposes CDP | `session`, current `url`, current `title` |
| `observe(session, goal?)` | You want to understand the page | targets, scopes, signals, fillable forms |
| `act(session, targetRef, action, value?)` | You want to click, type, select, fill, or press | action result and target metadata |
| `navigate(session, url)` | You want to move to another page | page metadata after navigation |
| `extract(session, schema, scopeRef?)` | You want structured JSON from the page | `data` that matches your schema |
| `screenshot(session, path?)` | You want a screenshot artifact | saved path and page metadata |
| `status(session)` | You want to know whether the session is still healthy | liveness, page info, runtime summary |
| `close(session)` | You are done with the browser | close result |

Two common questions:

- `observe(session)` gives you a general inventory of the page.
- `observe(session, goal)` focuses that inventory around a question such as
  `"find the checkout total"` or `"find the email field"`.

All main APIs return the same broad result shape:

- success path: `{ success: true, ... }`
- failure path: `{ success: false, error, message, reason, ... }`

## When You Need An Assistive Runtime

You only need assistive runtime when AgentBrowse should call an LLM.

In practice, that mainly means:

- `extract(...)`
- better quality goal-based `observe(session, goal)`

The runtime contract is intentionally small: you provide an object that can
create an OpenAI-compatible chat-completions client.

```ts
// Pseudocode shape only. For a runnable fetch-based adapter, see
// `examples/extract.ts` and `docs/assistive-runtime.md`.
import { createAgentbrowseClient } from '@mercuryo-ai/agentbrowse';

const client = createAgentbrowseClient({
  assistiveRuntime: createMyFetchBackedRuntime(),
});
```

The same pattern works for OpenRouter and other OpenAI-compatible backends.

See:

- [Assistive Runtime Guide](./docs/assistive-runtime.md)

## Session Persistence, Proxy, And Diagnostics

Normal usage is explicit-session based:

1. call `launch(...)` or `attach(...)`
2. keep the returned `session`
3. pass that session into later calls

If you want to restore a session across process runs, use the optional store
helpers:

```ts
import {
  createBrowserSessionStore,
  loadBrowserSession,
  saveBrowserSession,
} from '@mercuryo-ai/agentbrowse';

saveBrowserSession(session);
const restored = loadBrowserSession();

const store = createBrowserSessionStore({
  rootDir: '/tmp/my-app/browser-state',
});

store.save(session);
const restoredFromCustomRoot = store.load();
```

If you want to use a proxy, pass it directly to `launch(...)`:

```ts
const launchResult = await launch('https://example.com', {
  useProxy: true,
  proxy: 'http://user:pass@proxy.example:8080',
});
```

Diagnostics are optional. If you need tracing or custom logging, use a client:

```ts
import { createAgentbrowseClient } from '@mercuryo-ai/agentbrowse';

const client = createAgentbrowseClient({
  diagnostics: {
    startStep() {
      return {
        finish() {},
      };
    },
  },
});
```

See:

- [Configuration Guide](./docs/configuration.md)

## Testing Wrappers Around AgentBrowse

If your package wraps AgentBrowse and you want a stable test helper for the
assistive runtime contract, use the dedicated testing subpath:

```ts
import {
  installFetchBackedTestAssistiveRuntime,
  uninstallTestAssistiveRuntime,
} from '@mercuryo-ai/agentbrowse/testing';
```

See:

- [Testing Guide](./docs/testing.md)

## Protected Fill

Protected fill is for cases where your application already has sensitive values
and wants AgentBrowse to apply them to a previously observed form through a
guarded browser execution path.

Import it separately:

```ts
import { fillProtectedForm } from '@mercuryo-ai/agentbrowse/protected-fill';
```

See:

- [Protected Fill Guide](./docs/protected-fill.md)

## Documentation

- [Getting Started](./docs/getting-started.md)
- [API Reference](./docs/api-reference.md)
- [Configuration Guide](./docs/configuration.md)
- [Assistive Runtime Guide](./docs/assistive-runtime.md)
- [Protected Fill Guide](./docs/protected-fill.md)
- [Integration Checklist](./docs/integration-checklist.md)
- [Testing Guide](./docs/testing.md)
- [Troubleshooting](./docs/troubleshooting.md)
