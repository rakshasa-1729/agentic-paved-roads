# Changelog

All notable changes to security-mcp are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are managed by [release-please](https://github.com/google-github-actions/release-please-action).
Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `test:`, `docs:`)
so the changelog is generated automatically.

## Unreleased

Changes on `main` since the latest tag. release-please inserts the next version
heading and does not clear this section, so replace it when that release merges.

### Added

- **`select_guidance`** — optional `selector` block registers a tool that asks
  TypeSafe's Jev which collection items apply to a task. `pick_one` returns the
  highest-probability item, or none when confidence is below `min_confidence`;
  `pick_all` keeps every item at or above `threshold`. Fails open to `action=list`,
  respects RBAC, and counts outcomes in
  `security_mcp_selector_requests_total{outcome=ok|partial|error}`.
  `security-mcp doctor --probe` reports whether the API key resolved, without
  calling the API.

### Fixed

- **`bin/security-mcp`** — prepends `/opt/homebrew/bin` and `/usr/local/bin` to
  `PATH` so GUI MCP hosts, which spawn without a login-shell PATH, can find
  `gh` and `docker`.

## [0.2.0](https://github.com/rakshasa-1729/agentic-paved-roads/compare/v0.1.0...v0.2.0) (2026-06-28)


### Features

* **auth:** api_key mode, metrics protection, per-tool RBAC, audit/metrics/tracing depth ([0f7e1cb](https://github.com/rakshasa-1729/agentic-paved-roads/commit/0f7e1cba279aad1509b3fcd5428c261197098f16))
* **auth:** IAP trusted-header + OIDC bearer middleware on /mcp ([796696c](https://github.com/rakshasa-1729/agentic-paved-roads/commit/796696c4c9ffe8173458f6c570093e70c4cdad00))
* **auth:** mTLS auth mode + TLS transport config ([231334f](https://github.com/rakshasa-1729/agentic-paved-roads/commit/231334f29d40f952dbafb8be6cafa266c2cf8e09))
* **cli:** init / validate / doctor / serve subcommands ([a97313e](https://github.com/rakshasa-1729/agentic-paved-roads/commit/a97313e30987d7bab42c52fdde827a3b03b9b9bf))
* **cli:** schema export + lint subcommand ([869a3ea](https://github.com/rakshasa-1729/agentic-paved-roads/commit/869a3ea02a1793c4e7bea98c58e26b8c17734f8e))
* collection auth, rate limiting, SIGHUP hot-reload ([ad35cba](https://github.com/rakshasa-1729/agentic-paved-roads/commit/ad35cbab650a8a597f44d0f291f4ebd0d63dc702))
* github guardrails, serve flags, pretty logs, inspect cmd ([c2cbd05](https://github.com/rakshasa-1729/agentic-paved-roads/commit/c2cbd05cc10311ba034979749bd87aeb708fb2f2))
* graceful shutdown, /metrics, OTel traces ([f324d86](https://github.com/rakshasa-1729/agentic-paved-roads/commit/f324d863e6969520a95380439eee8affc21ffc5d))
* **log:** structured JSON logging + integration/E2E coverage ([4605ec4](https://github.com/rakshasa-1729/agentic-paved-roads/commit/4605ec441aa6f5327f4d979167e787a257029c82))
* opa-bundle source + redacted JSONL audit log ([760d9d3](https://github.com/rakshasa-1729/agentic-paved-roads/commit/760d9d3b6d337047799cb06365a88447c5c1178b))
* **sources:** cache TTL, refresh action, doctor --probe, sha256 fingerprints, source_errors ([66f2a26](https://github.com/rakshasa-1729/agentic-paved-roads/commit/66f2a266b1fec46a16c536bb6401e16679d142ce))
* **sources:** gitlab + local-cmd ([ca1470a](https://github.com/rakshasa-1729/agentic-paved-roads/commit/ca1470af54a20820849ed047483eb6466421a03d))
* **sources:** timeouts, signal escalation, output caps ([3abe376](https://github.com/rakshasa-1729/agentic-paved-roads/commit/3abe376450a84b851ff8b535d7970980e9f2a84e))
* streamable HTTP transport for shared deploys ([4ece0e4](https://github.com/rakshasa-1729/agentic-paved-roads/commit/4ece0e4d2c94d24a4872704040f43a0a8fc3735a))
* **tools:** context-frugal knobs for content + tool_registry ([54a6d25](https://github.com/rakshasa-1729/agentic-paved-roads/commit/54a6d2540c5f6277c10f70e306665e96496edb20))
* **tools:** usage directive, MCP caching, result truncation, etag, validation hook ([f352a64](https://github.com/rakshasa-1729/agentic-paved-roads/commit/f352a640ad9b17d6935eaeb967d200b0f414c190))

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
