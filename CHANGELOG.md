# Changelog

## Unreleased

- switched the library extraction API to `extract(session, schema, scopeRef?)`, where
  `schema` is a plain schema object or a Zod schema
- made `observe(...)` return a top-level flat `targets` array alongside grouped
  `scopes`
- exported named observe payload types and extraction schema types from the
  public library surface
- replaced `ReturnType<typeof ...>` client method signatures with named result
  types
- added runnable examples under `examples/`
- added public API reference and troubleshooting guides
- aligned package metadata with the public `MercuryoAI/agentbrowse` repository
