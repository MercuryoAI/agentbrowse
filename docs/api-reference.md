# AgentBrowse API Reference

This page is the compact reference for the public `@mercuryo-ai/agentbrowse`
library surface.

## Main Functions

### `launch(url?, options?)`

Starts a managed browser session.

Success result includes:

- `session`
- `url`
- `title`

### `attach(cdpUrl, options?)`

Attaches to an existing browser over CDP.

Success result includes:

- `session`
- `url`
- `title`

### `observe(session, goal?)`

Inspects the current page and returns the current page inventory.

Success result includes:

- `targets: ObserveTarget[]`
- `scopes: ObserveScope[]`
- `signals: ObserveSignal[]`
- `fillableForms: ObserveFillableForm[]`
- `observationMode`
- `targetCount`
- `scopeCount`
- `projectedTargetCount`
- `pageRef`
- `url`
- `title`

### `act(session, targetRef, action, value?)`

Runs a deterministic browser action against a previously observed target.

### `extract(session, schema, scopeRef?)`

Extracts structured data from the current page or a previously observed scope.

`schema` accepts either:

- a plain schema object
- a Zod schema

Plain schema example:

```ts
const result = await extract(session, {
  total: 'number',
  currency: 'string',
  flights: [{ code: 'string', fare: 'string' }],
});
```

Zod example:

```ts
const result = await extract(
  session,
  z.object({
    total: z.number(),
    currency: z.string(),
  })
);
```

### `navigate(session, url)`

Navigates the current page.

### `status(session)`

Returns current liveness and runtime summary information.

The root package also exports `BROWSER_STATUS_OUTCOME_TYPES` for the stable
outcome categories used by `status(session)`.

### `screenshot(session, path?)`

Captures a screenshot of the current page.

### `close(session)`

Closes the browser session.

## Stable Error Code Arrays

The root package exports stable top-level error code arrays for command
branching:

- `ACT_ERROR_CODES`
- `ATTACH_ERROR_CODES`
- `CLOSE_ERROR_CODES`
- `EXTRACT_ERROR_CODES`
- `LAUNCH_ERROR_CODES`
- `NAVIGATE_ERROR_CODES`
- `OBSERVE_ERROR_CODES`
- `SCREENSHOT_ERROR_CODES`

These arrays back the exported `*ErrorCode` types.

## Core Result Shapes

All main commands use the same top-level pattern:

- success: `{ success: true, ... }`
- failure: `{ success: false, error, outcomeType, message, reason, ... }`

## Observe Types

### `ObserveTarget`

Fields most applications use directly:

- `ref`
- `label`
- `kind`
- `capability`
- `availability`
- `surfaceRef`

Additional fields are available for richer UI or routing:

- `displayLabel`
- `placeholder`
- `inputName`
- `inputType`
- `autocomplete`
- `validation`
- `context`
- `state`
- `structure`
- `availabilityReason`
- `source`

### `ObserveScope`

Represents a scope or container on the page.

Fields:

- `ref`
- `kind`
- `label`
- `parentSurfaceRef`
- `childSurfaceRefs`
- `extractScopeLifetime`
- `targets`
- `source`

### `ObserveFillableForm`

Represents a form that can be passed into protected fill.

Fields:

- `fillRef`
- `scopeRef`
- `purpose`
- `presence`
- `fields`
- `storedSecretCandidates`

### `ObserveSignal`

Represents page-level signals such as notices, status text, or confirmation
messages.

Fields:

- `kind`
- `text`
- `framePath`
- `source`

## Ref Glossary

- `ref`
  A stable target or scope reference returned by `observe(...)`.
- `scopeRef`
  A scope reference used for scoped extraction or protected-fill bindings.
- `fillRef`
  A stable protected-fill binding reference returned inside `fillableForms`.
- `pageRef`
  AgentBrowse's current page identity inside the session runtime.

## Extraction Schema Rules

Plain schema objects use a small descriptor language:

- `'string'`
- `'number'`
- `'boolean'`
- nested objects
- arrays with one schema element, for example `[{ label: 'string' }]`

The extractor uses only the schema you provide. It does not invent missing
fields and does not treat the schema stringification format as part of the API.

## Assistive Runtime Types

The root package exports the current assistive runtime contract:

- `AgentbrowseAssistiveChatCompletionRequest`
- `AgentbrowseAssistiveChatCompletionOptions`
- `AgentbrowseAssistiveChatCompletionResult`
- `AgentbrowseAssistiveChatMessage`
- `AgentbrowseAssistiveImageInput`
- `AgentbrowseAssistiveResponseModel`
- `AgentbrowseAssistiveLlmUsage`

Your adapter receives `args.options.messages`, optional
`args.options.response_model`, optional `args.options.image`, and optional
`temperature` / `maxOutputTokens`.

## Testing Subpath

The package publishes a dedicated testing surface:

```ts
import {
  installFetchBackedTestAssistiveRuntime,
  uninstallTestAssistiveRuntime,
} from '@mercuryo-ai/agentbrowse/testing';
```

Use it when a package wraps AgentBrowse and needs a stable fetch-backed
assistive runtime in tests.
