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

```bash
npm install
cp security.config.example.yaml security.config.yaml
npx tsx src/index.ts          # stdio MCP server
# or
npm run build && npm start
# or run against the MCP Inspector
npm run inspector
```

## Docker

The server can run as a stdio container — useful when you don't want
to install Node on every developer's laptop. The image bundles
`conftest`, so `tool_registry(invoke, name=conftest, …)` works out of
the box.

```bash
docker build -t security-mcp:latest .
```

The image's default config (`/etc/security-mcp/config.yaml`) reads
content from a private GitHub repo over the API — no volume mounts
needed. Pass the GitHub token in via env:

```bash
docker run -i --rm \
  -e SECURITY_REPO_TOKEN \
  security-mcp:latest
```

`-i` keeps stdin attached (MCP framing rides on it). `-e VAR` (with no
value) passes the value through from your shell env. No ports are
exposed — the container speaks stdio, not HTTP.

For shared / production deployment (Cloud Run, AWS Lambda) see
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

// tool_registry
{ "action": "list" }
{ "action": "describe", "name": "conftest" }
{ "action": "invoke",   "name": "conftest",
  "input": { "policy_path": "./policies", "input_path": "./plan.json" } }
```

`list` returns metadata only (no body); `get` returns content.

## Agent prompt — making it actually fire

Drop something like this in your repo's `AGENTS.md` / `CLAUDE.md` so
the agent calls into the MCP without needing to be reminded:

> Before generating infra/IaC/auth/data code, call `policy_tool(list)`
> and `risk_index(list, query=<feature>)`. Prefer items from
> `paved_road_tool(list)`. Validate with `tool_registry(invoke,
> name=conftest, …)` before opening a PR.

For stronger enforcement, set a per-collection `usage` field — it gets
attached to every `list`/`get` response, so the model sees the
directive on every call (not just once at tool-list time).

## Layout

```
src/
  index.ts              # MCP server + per-collection tool routing
  config.ts             # YAML schema (zod) + loader
  policies-cache.ts     # materialize .rego files for conftest
  sources/
    types.ts            # Source / ToolSource interfaces
    file.ts             # local glob source
    http.ts             # REST source
    github.ts           # GitHub Contents/Trees API source
    mcp.ts              # proxy to another MCP server
    command.ts          # inline tools (command + http)
  tools/
    content.ts          # generic collection handler (list/get)
    tool_registry.ts    # tool registry handler (list/describe/invoke)
  util/env.ts           # ${ENV_VAR} interpolation
presets/
  security.yaml         # default preset — the four-collection shape above
  empty.yaml            # starting point for non-security adopters
examples/
  policies/  risk/  paved-roads/
docs/
  DEPLOYMENT.md         # Cloud Run + AWS Lambda recipes
bin/
  security-mcp          # docker launcher with gh-token auto-resolution
docker/
  security.config.yaml  # baked-into-image default config
Dockerfile              # multi-stage; non-root; conftest bundled
security.config.example.yaml
```

## License

Apache-2.0.
