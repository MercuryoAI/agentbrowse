# AgentBrowse Configuration Guide

This guide covers the parts of AgentBrowse that you may want to configure:

- browser session persistence
- proxy launch settings
- diagnostics hooks
- client-scoped runtime configuration

## Start With The Simplest Default

Most applications can start with this mental model:

1. call `launch(...)` or `attach(...)`
2. keep the returned `session` in memory
3. pass that `session` into later calls

You only need more configuration when you want one of these:

- custom LLM integration
- custom diagnostics or tracing
- session restore across process runs
- proxy launch

## Attach To An Existing Browser

If you already have a CDP websocket URL, you do not need `launch(...)`.

```ts
import { attach } from '@mercuryo-ai/agentbrowse';

const attached = await attach('ws://127.0.0.1:9222/devtools/browser/browser-id');
```

You can also label an attached session:

```ts
const attached = await attach(remoteCdpUrl, {
  provider: 'browserbase',
});
```

That provider label is metadata only. AgentBrowse still treats this as a
generic CDP-attached browser session.

## Client Configuration

```ts
import { createAgentbrowseClient } from '@mercuryo-ai/agentbrowse';

const client = createAgentbrowseClient({
  assistiveRuntime: { /* ... */ },
  diagnostics: { /* ... */ },
});
```

This is the best default when you embed AgentBrowse into a larger app because:

- it keeps configuration local to your app or tenant
- it is safer for parallel tests
- it avoids process-global configuration collisions

For small scripts, process-global configure helpers also exist, but client
configuration is the cleaner embedded pattern.

## Browser Session Persistence

Persistence is optional. Use it when you want to restore a browser session
after a process restart.

### Default Store

```ts
import { loadBrowserSession, saveBrowserSession } from '@mercuryo-ai/agentbrowse';

saveBrowserSession(session);
const restored = loadBrowserSession();
```

Default path:

`~/.agentbrowse/browse-session.json`

### Custom Store

For embedded apps, prefer an explicit store root:

```ts
import { createBrowserSessionStore } from '@mercuryo-ai/agentbrowse';

const store = createBrowserSessionStore({
  rootDir: '/tmp/my-app/browser-state',
});

store.save(session);
const restored = store.load();
store.delete();
```

This avoids hidden machine-level coupling to `~/.agentbrowse`.

## Proxy Configuration

The clearest way to use a proxy is to pass it directly to `launch(...)`.

```ts
import { launch } from '@mercuryo-ai/agentbrowse';

const launchResult = await launch('https://example.com', {
  useProxy: true,
  proxy: 'http://user:pass@proxy.example:8080',
});
```

Current launch behavior is:

- if `useProxy` is not `true`, launch is direct
- if `useProxy` is `true` and `proxy` is provided, that explicit proxy is used
- if `useProxy` is `true` and `proxy` is omitted, AgentBrowse falls back to
  `defaults.proxy` from `~/.agentbrowse/config.json`

For embedded library usage, prefer explicit launch options over machine-level
config files.

## Diagnostics

AgentBrowse is quiet by default. It does not write traces or diagnostics to
disk unless you provide hooks.

Client-scoped example:

```ts
import { createAgentbrowseClient } from '@mercuryo-ai/agentbrowse';

const client = createAgentbrowseClient({
  diagnostics: {
    startStep(input) {
      return {
        finish() {
          // your tracing or logging hook
        },
      };
    },
  },
});
```

Use diagnostics when you need:

- integration with your own tracing system
- deeper command-level debugging
- custom artifact collection

If you do not need that, you can ignore diagnostics completely.

### Diagnostics Contract

Diagnostics hooks are intentionally low-level. They are designed to let your
application map AgentBrowse command activity into its own tracing, logging, or
artifact pipeline.

#### `startStep(input)`

Called when a command starts.

Important fields on `input`:

- `runId`
  Stable run identifier for the surrounding browser workflow.
- `command`
  The AgentBrowse command name such as `observe`, `act`, or `extract`.
- `input`
  Command-specific input metadata. Examples:
  `targetUrl`, `instruction`, `scopeRef`, extraction schema summary.
- `refs`
  Stable runtime refs such as `pageRef`, `targetRef`, `surfaceRef`, `fillRef`,
  and `requestId`.
- `protectedStep`
  `true` when the current step is happening in a protected-value context.

Return a `DiagnosticStepHandle`:

```ts
{
  runId: 'run_123',
  stepId: 'step_observe_1',
  command: 'observe',
}
```

That handle is then passed back into later diagnostics hooks for the same step.

#### `finishStep(input)`

Called when a command finishes.

Important fields:

- `step`
  The handle returned from `startStep(...)`
- `success`
  Whether the command succeeded
- `outcomeType`
  High-level outcome classification
- `message`
  Human-readable command summary
- `reason`
  Extra failure detail when available
- `artifactManifestId`
  Optional link to a separately recorded artifact manifest

#### `captureSnapshot(input)`

Called for before/after/point-in-time snapshots.

Important fields:

- `phase`
  One of `before`, `after`, or `point-in-time`
- `pageRef`
- `url`
- `title`
- `artifactRefs`
  Optional file paths for screenshot, HTML, trace, or log artifacts

#### `recordCommandEvent(input)`

Called for lifecycle events:

- `started`
- `completed`
- `failed`

Use `attributes` for structured tracing tags or log enrichment.

#### `recordChildSpan(input)`

Called for nested client-side work such as LLM rerank spans.

Important fields:

- `name`
- `kind`
- `startedAt`
- `endedAt`
- `statusCode`
- `statusMessage`
- `attributes`

#### `recordArtifactManifest(input)`

Called when AgentBrowse has a grouped artifact manifest for a step.

The manifest includes:

- `screenshots`
- `htmlSnapshots`
- `traces`
- `logs`
- `suppressed`

Each artifact entry includes its local path plus optional storage metadata.

### Mapping To External Tracing

Typical mapping strategy:

- map `runId` to your trace or workflow id
- map `stepId` to a span or operation id
- copy `command`, `outcomeType`, and `refs` into structured attributes
- treat `captureSnapshot(...)` and `recordArtifactManifest(...)` as artifact
  enrichment, not as the main step identity

Diagnostics hooks are best-effort. AgentBrowse continues its command flow even
if your diagnostics implementation throws.

## Process-Global Convenience Helpers

AgentBrowse still exposes process-global convenience functions such as:

- `configureAgentbrowseAssistiveRuntime(...)`
- `configureAgentbrowseDiagnostics(...)`

These are useful for small scripts and quick experiments.

For embedded production usage, client-scoped configuration is the better
default.
