# AgentBrowse Getting Started

This guide is for a developer who wants to embed `@mercuryo-ai/agentbrowse` as a
library into their own application.

Read the package README first. This page is the practical follow-up: it turns
the high-level overview into a simple working model for the main APIs.

## Mental Model

The normal flow is:

1. `launch(...)` starts a managed browser, or `attach(...)` connects to an
   existing CDP browser, and returns a `session`
2. `observe(session)` inspects the current page
3. `act(session, targetRef, ...)` interacts with targets returned by `observe`
4. `extract(session, schema)` returns structured JSON from the page when
   you need data instead of actions
5. `close(session)` ends the browser session

The `session` is the key object in the whole API. It is the handle that keeps
the browser connection and runtime state together between calls.

At a high level, AgentBrowse has three kinds of behavior:

- normal browser execution for `launch`, `navigate`, `observe`, `act`,
  `status`, `screenshot`, and `close`
- assistive page understanding for `extract` and some goal-based
  `observe(session, goal)` calls
- protected fill for applying sensitive values you already have through a
  guarded form execution path

Most applications pair these browser primitives with their own orchestration,
approval, secret, or payment logic.

## Managed Launch Note

`launch(...)` uses a managed browser session. For that path, the package pulls
in `puppeteer` for the stealth-enabled connection layer.

This is there to reduce unnecessary captcha or anti-bot challenge pages during
browser startup on sensitive sites.

After launch, the normal page interaction flow still runs over Playwright CDP.

## Basic Example

```ts
import { act, close, launch, observe } from '@mercuryo-ai/agentbrowse';

const launchResult = await launch('https://example.com/login');
if (!launchResult.success) {
  throw new Error(launchResult.reason ?? launchResult.message);
}

const { session } = launchResult;

try {
  const observeResult = await observe(session);
  if (!observeResult.success) {
    throw new Error(observeResult.reason ?? observeResult.message);
  }

  const emailTarget = observeResult.targets.find((target) =>
    target.label?.toLowerCase().includes('email')
  );

  if (!emailTarget?.ref) {
    throw new Error('Could not find an email field.');
  }

  const fillResult = await act(session, emailTarget.ref, 'fill', 'user@example.com');
  if (!fillResult.success) {
    throw new Error(fillResult.reason ?? fillResult.message);
  }
} finally {
  await close(session);
}
```

## What Each Main Command Is For

### `launch(url?, options?)`

Starts a new browser session. If you pass a URL, AgentBrowse opens it during
launch.

Success result includes:

- `session`
- current `url`
- current `title`

### `attach(cdpUrl, options?)`

Connects AgentBrowse to an already running browser over CDP.

This is the right entrypoint when:

- your app launched Chrome itself;
- your infrastructure gives you a CDP websocket URL;
- you are reusing a cloud browser session.

Success result includes:

- `session`
- current `url`
- current `title`

### `observe(session, goal?)`

Reads the current page and returns what AgentBrowse found.

Typical things in the result:

- `targets`
- `scopes`
- `signals`
- `fillableForms`

Use `observe(session)` when you want a general inventory of the page.

Use `observe(session, goal)` when you want a focused answer such as:

- `"find the checkout total"`
- `"find the email field"`
- `"find the primary continue button"`

`observe(session)` and `observe(session, goal)` share the same API, but they
serve different intents:

- `observe(session)` is for general page inspection
- `observe(session, goal)` is for a focused question

### `act(session, targetRef, action, value?)`

Executes a browser action against a `targetRef` returned by `observe(...)`.

Typical actions:

- `click`
- `fill`
- `type`
- `select`
- `press`

### `extract(session, schema, scopeRef?)`

Returns structured JSON that matches the schema you provide.

Pass either:

- a plain schema object such as `{ total: 'number', currency: 'string' }`
- a Zod schema

This is the right tool when you want data, not a browser action.

`extract(...)` currently needs an assistive runtime, so you must configure one
before calling it.

### `status(session)`

Returns local browser/runtime diagnostics for an existing session.

Use it when you want to know whether the browser is still reachable and what
page AgentBrowse believes it is on.

### `close(session)`

Closes the browser session.

## How To Handle Results

All main commands use the same broad pattern:

```ts
const result = await observe(session);

if (!result.success) {
  throw new Error(result.reason ?? result.message);
}
```

If `success` is `true`, the rest of the fields describe the successful outcome.

If `success` is `false`, the result tells you:

- `error`
- `message`
- `reason`

You can usually log `message` and use `reason` for debugging or developer logs.

## When To Use Assistive Features

You do not need an assistive runtime for:

- `launch`
- `attach`
- `observe(session)` without a goal
- `navigate`
- `act`
- `status`
- `screenshot`
- `close`

You do need it for:

- `extract`
- better quality goal-based `observe(session, goal)`

See:

- [Assistive Runtime Guide](./assistive-runtime.md)

## Persistence

If your process is long-lived, you can keep the `session` in memory and ignore
disk persistence completely.

If you want to restore a browser session between process runs, use:

- `saveBrowserSession(session)`
- `loadBrowserSession()`
- `createBrowserSessionStore({ rootDir })`

See:

- [Configuration Guide](./configuration.md)

## Next Docs

- [API Reference](./api-reference.md)
- [Configuration Guide](./configuration.md)
- [Assistive Runtime Guide](./assistive-runtime.md)
- [Protected Fill Guide](./protected-fill.md)
- [Troubleshooting](./troubleshooting.md)
