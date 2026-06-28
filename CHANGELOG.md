# Changelog

All notable changes to security-mcp are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are managed by [release-please](https://github.com/google-github-actions/release-please-action).
Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `test:`, `docs:`)
so the changelog is generated automatically.

## Unreleased

This section covers in-progress work on `main` that has not been tagged yet.

### Added

- **Context-frugal API knobs** — `list` gains `limit` / `fields` / `dedup` params to
  cap response size and avoid re-sending identical metadata; `get` gains `section`
  (extract a single markdown section by heading) and `max_bytes` (truncate with a
  flag so the agent knows it's truncated). `tool_registry list` returns a compact
  shape by default (drops `input_schema` / `metadata`) with `verbose: true` to opt
  back in.
- **`usage_on: every | never`** — per-collection opt-out for the `usage` directive.
  Set `usage_on: never` when the host's context budget is tight and the directive is
  already in the tool description.
- **Test coverage** — direct unit tests for `util/timeout` (8), `policies-cache` (7),
  `loadConfig` (14), `McpToolSource` / `McpResourceSource` happy paths (9), and a
  conftest-version sync guard (3).
- **`.conftest-version`** — single source of truth for the conftest pin, read by both
  Dockerfiles and referenced in all YAML configs. A CI test fails if any pin drifts.
- **Pretest build hook** — `npm test` now runs `tsc` first (via `pretest`) so e2e tests
  that spawn `dist/index.js` don't depend on a stale build.
- **CI hardening** — `npm audit` (high+ on production deps), GitHub CodeQL, Dependabot
  (npm + actions + docker), CODEOWNERS, PR / issue templates.
- **Release automation** — `release-please` workflow with `npm publish --provenance`
  on tag.

### Changed

- `handleContent` (`get` action) no longer swallows post-fetch errors (like "section
  not found") as "not found in any configured source" — source-fetch errors fall through
  to the next source, but processing errors on the fetched content propagate correctly.
- Cross-source `dedup` in `list` now records the set of source ids in a `sources` field
  on the surviving item, so the agent can resolve the same doc from a specific source
  without re-listing.

### Documentation

- README "Layout" section rewritten to list all CLI subcommands, all source types,
  `auth/`, `audit.ts`, `metrics.ts`, `tracing.ts`, and the `registry_files` feature.
- New "Context budget" subsection under "Tool inputs" documenting `limit` / `fields` /
  `dedup` / `section` / `max_bytes` / `verbose`.
- `usage_on` documented in "Agent prompt" and in the "Configuring sources" example.

## 0.1.0

Initial release — a generic MCP (Model Context Protocol) server that exposes an org's
security policies, risk context, paved roads, and tool registry to coding agents.

### Features

- **Seven source types** — `file`, `http`, `github`, `gitlab`, `mcp`, `opa-bundle`,
  `command`, `local-cmd`.
- **Seven CLI subcommands** — `serve`, `init`, `validate`, `doctor`, `inspect`,
  `schema`, `lint`.
- **Stateless streamable-HTTP transport** — per-request Server + transport
  (`server.ts`) for shared deploys behind an IAP / edge proxy.
- **Auth middleware** — `none` (default), `iap` (trusted-header), `oidc`
  (Bearer JWT verification via `jose`).
- **Audit log** — one redacted, sha256-anchored JSONL line per `tools/call`.
- **Metrics** — Prometheus `/metrics` endpoint (request count, tool-call durations,
  transport connections).
- **Tracing** — OpenTelemetry API surface (BYO exporter).
- **Policies-cache** — bridges conftest (needs policies on disk) with remote sources
  that only stream content.
- **Graceful shutdown** — SIGTERM / SIGINT drain.
- **Docker** — non-root, conftest bundled, container-default config.
- **Dev container** — Node 20 + gh CLI + Docker-in-Docker + conftest on PATH.
- **Structured logging** — JSON (prod) / pretty (TTY) with `$schema`-style event tags.
- **Source-level hardening** — timeouts with signal escalation (SIGTERM → SIGKILL),
  output byte caps, env-var interpolation (`${VAR}`).
- **Preset system** — `security-mcp init --preset security` writes a starter config;
  `empty` preset for non-security adopters.
