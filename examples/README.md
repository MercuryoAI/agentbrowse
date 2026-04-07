# AgentBrowse Examples

The published package includes these same files under `examples/`.

If you run them from this repo, build once first so the self-referenced package
entrypoint resolves to `dist/`:

```bash
npm run build
```

Then run the examples from `packages/agentbrowse`:

```bash
npx tsx examples/basic.ts
npx tsx examples/attach.ts
npx tsx examples/extract.ts
```

Examples:

- `basic.ts`
  Launches a managed browser, observes the page, and prints a small target summary.
- `attach.ts`
  Attaches to an existing CDP browser session.
- `extract.ts`
  Runs structured extraction with an assistive runtime and a plain schema object.
