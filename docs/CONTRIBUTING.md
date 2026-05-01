# Contributing

## Local setup

```bash
npm install
npm run typecheck    # tsc --noEmit
npm run build        # tsc → dist/
npm test             # vitest run
npm run test:watch   # vitest in watch mode while iterating
```

Node `>=20` is required. The CI matrix runs on Node 20 and 22.

## Tests

Tests live in `tests/`, mirroring `src/`. File naming: `*.test.ts`.

- **Unit tests** — pure code with no I/O. Fast (< 1 ms each).
- **Integration tests** — touch the filesystem, spawn child processes, or
  hit a stub HTTP server bound to localhost. Each test cleans up after
  itself (use `tmpdir()` and `afterEach`).
- **End-to-end tests** — drive the MCP over JSON-RPC framing.

Source modules use `.js` import extensions (NodeNext ESM). Tests do
the same — `import { … } from "../src/util/env.js"` resolves correctly
under vitest with the project's TypeScript config.

## Pull requests

- Branch from `main`. Squash-merge.
- CI must pass: typecheck, build, tests on Node 20 and 22.
- Keep changes focused — one concern per PR. If a change spans multiple
  buckets in [the roadmap](../README.md), split it.
- New features need tests. Bug fixes need a regression test.
- Update `docs/` if the change is user-visible (config schema, CLI
  flags, transport behavior, deploy recipe).

## Reporting issues

Include the security-mcp version (`git rev-parse HEAD`), Node version,
the relevant config snippet, and the failure mode. For agent-side
issues (Cursor/Claude Code/etc. not seeing the tools) include the host
config too.
