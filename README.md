# Security MCP

A small, generic MCP server that exposes your organization's
**policies**, **risk context**, **paved roads**, and **security tools**
to coding agents (Claude Code, Cursor, Codex, Continue, etc.).

The premise: agents do most of the typing now. Security teams can't
program brains, but they *can* program the model's context — so
security shows up as an API the agent can call at every step of its
loop. This server is the API.

## What it serves

The server registers one MCP tool per **collection** in your config,
plus one `tool_registry` tool for invokable actions. Names and shapes
are entirely up to you. The shipped "security" preset defines four
collections that map to the typical platform-team responsibilities:

| Tool              | Action                                               | Backed by |
|-------------------|------------------------------------------------------|-----------|
| `policy_tool`     | `list` / `get` policy docs (`.md`, `.rego`, …)       | file / http / github / mcp |
| `risk_index`      | `list` / `get` risk-context docs                     | file / http / github / mcp |
| `paved_road_tool` | `list` / `get` paved-road references                 | file / http / github / mcp |
| `tool_registry`   | `list` / `describe` / `invoke` registered tools      | inline (command/http) + mcp |

Each collection accepts an array of sources, so you can mix a local
repo of markdown with a central HTTP policy service and another team's
MCP server.

You can rename / remove / add collections freely — the MCP doesn't
hard-code "security." A team that wants to expose runbooks, ADRs, or
design-system docs to their agent does so by listing them as
collections in their config; the only constant is `tool_registry`.

## Quick start (local)

> **Or:** open the repo in VS Code / Cursor / GitHub Codespaces and
> accept the "Reopen in Container" prompt. The shipped
> [`.devcontainer/`](.devcontainer/devcontainer.json) bakes in
> Node 20, conftest, gh, and Docker-in-Docker so you can build, test,
> and run the bundled image without touching the host.

```bash
npm install && npm run build
npx security-mcp init               # writes ./security.config.yaml from the security preset
npx security-mcp validate           # parses + probes every source
npx security-mcp doctor             # environment diagnostics
npx security-mcp doctor --probe     # plus source reachability probes
npx security-mcp inspect            # list / describe / invoke tools in-process
npx security-mcp schema             # emit the config's JSON Schema
npx security-mcp lint <repo-path>   # validate a content repo against conventions
npx security-mcp serve              # run the server (stdio)
```

Every subcommand accepts `--help`. Pass `--preset empty` to `init` for
a non-security starter.

For VS Code / Cursor autocomplete on `security.config.yaml`:

```bash
npx security-mcp schema --out ./.security-mcp.schema.json
# then in .vscode/settings.json:
#   "yaml.schemas": { "./.security-mcp.schema.json": "security.config*.yaml" }
```

`serve` accepts flag overrides for ad-hoc invocation:

```bash
npx security-mcp serve --transport http --port 8080 --host 127.0.0.1 --config ./other.yaml
```

Logs are JSON when stderr is piped (containers, log shippers) and
human-readable with ANSI colors when stderr is a TTY. Force one or
the other with `LOG_FORMAT=json|pretty`.

For development:

```bash
npm run dev                   # tsx src/index.ts — auto-recompiles
npm run inspector             # run against the MCP Inspector
npm test                      # vitest
```

## Docker

The image bundles `conftest`, so `tool_registry(invoke, name=conftest, …)`
works out of the box, and ships with a default config at
`/etc/security-mcp/config.yaml` that reads content from a private
GitHub repo over the API — no volume mounts needed.

```bash
docker build -t security-mcp:latest .
```

**Stdio** (default) — what the per-dev `bin/security-mcp` launcher uses:

```bash
docker run -i --rm \
  -e SECURITY_REPO_TOKEN \
  security-mcp:latest
```

`-i` keeps stdin attached (MCP framing rides on it). `-e VAR` (with no
value) passes the value through from your shell env.

**HTTP** — for shared deploys behind a reverse proxy:

```bash
docker run --rm -p 8080:8080 \
  -e MCP_TRANSPORT=http \
  -e SECURITY_REPO_TOKEN \
  security-mcp:latest
# → POST http://localhost:8080/mcp   (Streamable HTTP)
# → GET  http://localhost:8080/healthz
```

For Cloud Run / AWS Lambda recipes, auth, and the route shape, see
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### bin/security-mcp launcher

A small wrapper that pulls a fresh GitHub token from the developer's
`gh auth login` so it doesn't have to live in `~/.cursor/mcp.json` or
shell rc files:

```bash
brew install gh && gh auth login
./bin/security-mcp                              # global, no extra mounts
./bin/security-mcp -v $PWD:/data/app            # forward extra mounts
```

### Wire into Cursor / VS Code

```json
{
  "mcpServers": {
    "security": {
      "command": "/abs/path/to/bin/security-mcp",
      "args": []
    }
  }
}
```

### Wire into Claude Desktop

```json
{
  "mcpServers": {
    "security": {
      "command": "/abs/path/to/bin/security-mcp",
      "args": []
    }
  }
}
```

### Wire into Claude Code (CLI)

```bash
claude mcp add security -- /abs/path/to/bin/security-mcp
```

## Configuring sources

`security.config.yaml` (see
[`security.config.example.yaml`](./security.config.example.yaml) and
the security-shaped preset at [`presets/security.yaml`](./presets/security.yaml)):

```yaml
server:
  name: security-mcp
  instructions: |
    Optional system prompt the MCP host shows the model.

collections:
  - name: policy_tool
    description: |
      Organizational security policies. The agent should consult these
      before generating infrastructure code.
    usage: |
      Optional directive attached to every list/get response — useful
      to make follow-up actions (e.g. "always run conftest after") hard
      for the model to skip.
    usage_on: every                   # every | never; never suppresses the
                                     # repeat when the directive already lives
                                     # in the tool description. Default every.
    sources:
      - { type: file, path: ./examples/policies, patterns: ["**/*.md", "**/*.rego"] }
      - type: http
        base_url: https://policies.your-org.example/v1
        list_path: /policies
        get_path:  /policies/{name}
        headers:   { Authorization: "Bearer ${POLICY_API_TOKEN}" }
      - type: github
        owner: your-org
        repo:  security-policies
        path:  policies
        patterns: ["**/*.md", "**/*.rego"]
        token: "${SECURITY_REPO_TOKEN}"
      - type: opa-bundle              # signed/built OPA bundle from a registry
        url: https://ghcr.io/your-org/security-policies/-/blobs/sha256:abc123
        headers: { Authorization: "Bearer ${SECURITY_REPO_TOKEN}" }
      - type: mcp
        command: npx
        args: ["-y", "@your-org/policy-mcp"]

  - name: risk_index
    sources:
      - { type: file, path: ./examples/risk, patterns: ["**/*.md"] }

  - name: paved_road_tool
    sources:
      - { type: file, path: ./examples/paved-roads, patterns: ["**/*.md", "**/*.tf"] }

  # Add your own collections — runbooks, ADRs, design-system docs, etc.
  # The MCP doesn't care about the names.
  - name: runbooks
    description: Operational runbooks the agent should consult before incident steps.
    sources:
      - { type: github, owner: your-org, repo: runbooks, path: ., patterns: ["**/*.md"], token: "${SECURITY_REPO_TOKEN}" }

# Optional: durable, redacted audit trail. One JSONL line per
# tools/call with {ts, request_id, principal, tool, action, args_hash,
# ok, duration_ms, error?}. Args are sha256-hashed (16 hex chars), not
# logged verbatim, so per-call tokens / PII don't leak to disk.
audit_log: ./audit.jsonl

tools:
  registry:
    - type: command
      name: conftest
      description: Run OPA policy checks.
      command: conftest
      args: ["test", "--policy", "{{policy_path}}", "{{input_path}}"]
      input_schema:
        type: object
        properties:
          policy_path: { type: string }
          input_path:  { type: string }
        required: [policy_path, input_path]

    - type: http
      name: exception_tool
      description: Request a policy exception.
      method: POST
      url: "${EXCEPTION_API_BASE_URL}/v1/exceptions"
      headers: { Authorization: "Bearer ${EXCEPTION_API_TOKEN}" }
      body_template:
        repo:          "{{repo}}"
        rule:          "{{rule}}"
        justification: "{{justification}}"

  sources:
    - type: mcp
      command: npx
      args: ["-y", "@your-org/another-mcp"]
```

`${VAR}` is interpolated from the process environment at config-load
time. Source-of-truth tokens (GitHub PATs, API keys) come from the
host environment, not the config file.

## Tool inputs

```jsonc
// content collections (policy_tool, risk_index, paved_road_tool, etc.)
{ "action": "list", "query": "tagging" }
{ "action": "get",  "name": "tagging.md" }
{ "action": "get",  "name": "tagging.md", "source": "local-policies" }
{ "action": "get",  "name": "local-policies::tagging.md" }   // qualified

// context-frugal knobs (see "Context budget" below)
{ "action": "list", "limit": 20 }
{ "action": "list", "fields": ["name", "source"], "dedup": false }
{ "action": "list", "refresh": true }                     // bypass source caches
{ "action": "get",  "name": "big.md", "section": "Tagging" }
{ "action": "get",  "name": "big.md", "max_bytes": 2000 }
{ "action": "get",  "name": "big.md", "section": "Tagging", "max_bytes": 2000 }
{ "action": "get",  "name": "big.md", "etag": "<sha256>" }          // skip body if unchanged

// tool_registry
{ "action": "list" }                              // compact by default (name/source/description)
{ "action": "list", "verbose": true }             // include input_schema + metadata
{ "action": "describe", "name": "conftest" }      // full input_schema
{ "action": "invoke",   "name": "conftest",
  "input": { "policy_path": "./policies", "input_path": "./plan.json" } }
```

`list` returns metadata only (no body); `get` returns content. When a source fails during `list`, the response includes a `source_errors` array (e.g. `[{source: "gh-prod", error: "timeout"}]`) alongside the per-source `__error__:<id>` items, so the agent can surface unhealthy sources at a glance. `get` includes a `sha256` fingerprint of the delivered content (after section/truncation) so the agent can detect staleness.

### Context budget

The server's whole job is to feed the agent the right context at the
right moment — but the agent's context window is the one resource it
can't recharge, so the tools are tuned to spend it sparingly. Every
content collection accepts the same optional knobs on `list`:

- `limit` — cap the number of items returned (default: all).
- `fields` — keep only the named fields on each item, e.g. `["name","source"]`
  for a compact index the agent can scan before fetching bodies. Allowed
  values: `name`, `source`, `title`, `description`, `uri`, `content_type`,
  `metadata`, `sources`.
- `dedup` (default `true`) — collapse items that share a `name` across
  sources into one entry with a `sources[]` array, so a doc mirrored by
  `file + github + mcp` doesn't appear three times. Set `dedup: false` to
  see every source's copy (e.g. to spot stale mirrors).
- `refresh` — bypass source caches and re-fetch fresh data; useful after
  a merge or deploy to see live content (supported by GitHub/GitLab sources).

And on `get`:

- `section` — for markdown/text, return only the body under the heading
  whose text matches (case-insensitive substring); the heading line is
  included. Throws `section not found` if no heading matches, so the
  agent gets a precise error instead of a silent full dump.
- `max_bytes` — truncate the returned content to at most N characters
  and append a `[truncated]` marker. Pair `section` + `max_bytes` to
  page through a large doc. The response includes a `sha256` hex digest of
  the delivered content (after section/truncation).
- `etag` — if the agent already has content with a known sha256, pass it
  here; if the server's content matches, it returns `{unchanged: true}`
  with no body — saving context budget on re-fetches.

`tool_registry(list)` returns a compact shape by default (`name`,
`source`, `description` only) — pass `verbose: true` to pull
`input_schema` + `metadata`, or call `describe` for the one tool the
agent is about to invoke. Keeping the default `list` cheap lets the
agent hold the whole registry in a few hundred tokens.

`tool_registry(describe)` and `tool_registry(invoke)` optionally attach a
`usage` directive when `tools.usage` is configured in the security config
— works like the per-collection usage but for tool responses. Per-tool
`usage` on individual tool descriptors overrides the category-level
directive. Use `tools.usage_on: never` to suppress (e.g. when the
directive is already in the tool description).

`tool_registry(list)` returns a compact shape by default (`name`,
`source`, `description` only) — pass `verbose: true` to pull
`input_schema` + `metadata`, or call `describe` for the one tool the
agent is about to invoke. Keeping the default `list` cheap lets the
agent hold the whole registry in a few hundred tokens.

## Agent prompt — making it actually fire

Drop something like this in your repo's `AGENTS.md` / `CLAUDE.md` so
the agent calls into the MCP without needing to be reminded:

> Before generating infra/IaC/auth/data code, call `policy_tool(list)`
> and `risk_index(list, query=<feature>)`. Prefer items from
> `paved_road_tool(list)`. Validate with `tool_registry(invoke,
> name=conftest, …)` before opening a PR.

For stronger enforcement, set a per-collection `usage` field — it gets
attached to every `list`/`get` response, so the model sees the
directive on every call (not just once at tool-list time). If your host
is context-budget-sensitive and the directive is already in the tool
description, set `usage_on: never` on the collection to suppress the
repeat (default `every`). There is no `first`-only mode: the HTTP
transport is stateless and keeps no per-session memory.

## Layout

```
src/
  index.ts              # CLI dispatcher (init/validate/doctor/inspect/schema/lint/serve)
  server.ts             # MCP server + per-collection tool routing + http app
  config.ts             # YAML schema (zod) + loader + legacy-shape migration
  policies-cache.ts     # materialize .rego files for conftest
  log.ts                # JSON-line logger + per-call request_id + principal (ALS)
  audit.ts              # redacted JSONL audit recorder (args sha256-hashed)
  metrics.ts            # Prometheus registry (http-requests, tool-*, audit-writes)
  tracing.ts            # OpenTelemetry API span wrapper (BYO exporter)
  cli/
    serve.ts            # `serve` subcommand (default)
    init.ts             # `init` — copy a preset to ./security.config.yaml
    validate.ts         # `validate` — schema + per-source probe
    doctor.ts           # `doctor` — environment diagnostics
    inspect.ts          # `inspect` — list/describe/invoke tools in-process
    schema.ts           # `schema` — emit the config's JSON Schema
    lint.ts             # `lint` — validate a content repo against conventions
  sources/
    types.ts            # Source / ToolSource interfaces
    file.ts             # local glob source
    http.ts             # REST source
    github.ts           # GitHub Contents/Trees API source
    gitlab.ts           # GitLab Trees API source (self-hosted + paginated)
    mcp.ts              # proxy to another MCP server (resources + tools)
    command.ts          # inline tools (command + http)
    opa-bundle.ts       # signed OPA bundle (.tar.gz) source
    local-cmd.ts        # shell-command-backed source (shell:false + name allowlist)
  tools/
    content.ts          # generic collection handler (list/get + context-frugal knobs)
    tool_registry.ts    # tool registry handler (list/describe/invoke, compact list)
  auth/
    index.ts            # buildAuthMiddleware dispatch + JSON-RPC 401
    iap.ts              # trusted-header auth (e.g. Cloud IAP)
    oidc.ts             # Bearer JWT verification (issuer + audience, JWKS discovery)
    api_key.ts          # static key auth (constant-time, header-configurable)
  util/
    env.ts              # ${ENV_VAR} interpolation
    timeout.ts          # abortableFetch + withTimeout helpers
presets/
  security.yaml         # default preset — the four-collection shape above
  empty.yaml            # starting point for non-security adopters
examples/
  policies/  risk/  paved-roads/
docs/
  DEPLOYMENT.md         # Cloud Run + AWS Lambda recipes
  CONTRIBUTING.md       # local setup, test layout, PR conventions
bin/
  security-mcp          # docker launcher with gh-token auto-resolution
docker/
  security.config.yaml  # baked-into-image default config
Dockerfile              # multi-stage; non-root; conftest bundled
security.config.example.yaml
```

`loadConfig` also supports `tools.registry_files` (an array of YAML file
paths), letting you split inline tool descriptors out of
`security.config.yaml` and into per-tool files that are validated
against the same `InlineTool` schema.

GitHub and GitLab sources accept an optional `cache_ttl_ms` setting
(default 60000) to control the tree cache freshness, and `list(refresh: true)`
skips the cache entirely for immediate reads after a merge or deploy.

## License

Apache-2.0.
