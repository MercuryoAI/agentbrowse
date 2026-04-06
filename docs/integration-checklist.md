# AgentBrowse Integration Checklist

Use this checklist when integrating the current `@mercuryo-ai/agentbrowse`
contract into another package or service.

## Core Assumptions

- use `observeResult.targets` as the default flat inventory
- use `target.ref` as the input to `act(...)`
- pass a plain schema object or a Zod schema to `extract(...)`
- branch on stable top-level `error` codes, not on `reason`
- treat `reason` as human-readable diagnostics, not as a stable switch key

## Assistive Runtime

- the assistive runtime adapter receives `args.options`
- provider adapters should map `messages`, optional `response_model`, optional
  `image`, and optional `temperature` / `maxOutputTokens`
- assistive adapters return `{ data, usage? }`

## Testing

- use `@mercuryo-ai/agentbrowse/testing` for the stable fetch-backed assistive
  runtime helper
- do not depend on internal fixtures or unexported runtime-state helpers

## Packaging

- the root library entrypoint does not load `.env`
- the CLI entrypoint is the only place that loads dotenv support
- published examples and docs are part of the package contract

## Versioning Expectation

AgentBrowse is still pre-1.0. Treat minor updates as contract-bearing changes
and verify this checklist whenever you move to a newer release.
