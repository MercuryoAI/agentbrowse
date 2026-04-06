# AgentBrowse Testing Guide

Use the published testing subpath when your package wraps AgentBrowse and you
need a stable assistive-runtime helper in tests.

## Testing Export

```ts
import {
  installFetchBackedTestAssistiveRuntime,
  uninstallTestAssistiveRuntime,
} from '@mercuryo-ai/agentbrowse/testing';
```

## What It Does

`installFetchBackedTestAssistiveRuntime(...)` installs a process-global
assistive runtime that sends structured chat requests over `fetch`.

Use it when:

- your tests wrap `extract(...)`
- your tests cover goal-based `observe(session, goal)`
- your package wants to exercise the current public assistive runtime contract

## Example

```ts
import {
  installFetchBackedTestAssistiveRuntime,
  uninstallTestAssistiveRuntime,
} from '@mercuryo-ai/agentbrowse/testing';

beforeEach(() => {
  installFetchBackedTestAssistiveRuntime({
    apiUrl: 'http://127.0.0.1:8787/api',
    apiKey: 'test-key',
    model: 'test-model',
  });
});

afterEach(() => {
  uninstallTestAssistiveRuntime();
});
```

## Scope

This helper is for the assistive runtime contract. It does not mock browser
sessions, pages, or observed target inventories.
