# Security MCP

A small, generic MCP server that exposes your organization's **policies**,
**risk context**, **paved roads**, and **security tools** to coding agents
(Claude Code, Cursor, Codex, Gemini, Grok, etc.).

The thesis (from the [talk](./Shifting%20all%20the%20way%20left_%20Agentic%20Paved%20Roads.pdf)):
agents are the new developers. We can't program brains, but we *can* program
model context — so security shows up as an API the agent can call at every
step of its loop.

## What it serves

The server registers **four** tools, matching the slide:

| Tool              | Action                                               | Backed by |
|-------------------|------------------------------------------------------|-----------|
| `policy_tool`     | `list` / `get` policy docs (`.md`, `.rego`, …)       | file / http / mcp |
| `risk_index`      | `list` / `get` risk-context docs                     | file / http / mcp |
| `paved_road_tool` | `list` / `get` paved-road references                 | file / http / mcp |
| `tool_registry`   | `list` / `describe` / `invoke` security tools        | inline (command/http) + mcp |

Each category accepts an array of sources, so you can mix a local repo of
markdown with a central HTTP policy service and another team's MCP server.

## Quick start

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

The server can also run as a stdio container — useful when you don't want
to install Node on every developer's laptop. The image bundles `conftest`,
so `tool_registry(invoke, name=conftest, …)` works out of the box.

```bash
docker build -t security-mcp:latest .
```

The image's default config (`/etc/security-mcp/config.yaml`) expects your
security repo to be mounted at `/data/security` (read-only). Run:

```bash
docker run -i --rm \
  -v $(pwd)/../acme-security-repo:/data/security:ro \
  security-mcp:latest
```

`-i` keeps stdin attached (MCP framing rides on it). No ports are exposed.

### Wire the container into Cursor / Claude Desktop

```json
{
  "mcpServers": {
    "security": {
      "command": "/usr/local/bin/docker",
      "args": [
        "run", "-i", "--rm",
        "-v", "/abs/path/to/acme-security-repo:/data/security:ro",
        "security-mcp:latest"
      ]
    }
  }
}
```

To make `tool_registry invoke conftest` also reach plan files in your app
repo, add a second mount:

```json
"-v", "/abs/path/to/your-app-repo:/data/app",
```

Then call conftest with paths like `/data/security/policies` and
`/data/app/infra/plan.json`.

Want a different config? Mount your own and point at it:

```bash
docker run -i --rm \
  -v $(pwd)/../acme-security-repo:/data/security:ro \
  -v $(pwd)/security.config.yaml:/etc/security-mcp/config.yaml:ro \
  -e EXCEPTION_API_TOKEN \
  security-mcp:latest
```

`-e VAR` (with no value) passes the value through from your shell env —
this is how secrets like `EXCEPTION_API_TOKEN` reach the container without
being baked into the image.

### Wire into Claude Code

```bash
claude mcp add security -- node $(pwd)/dist/index.js
# pass config path via env:
claude mcp add security -- env SECURITY_MCP_CONFIG=$(pwd)/security.config.yaml node $(pwd)/dist/index.js
```

### Wire into Cursor / VS Code (`mcp.json`)

```json
{
  "mcpServers": {
    "security": {
      "command": "node",
      "args": ["/abs/path/to/dist/index.js"],
      "env": { "SECURITY_MCP_CONFIG": "/abs/path/to/security.config.yaml" }
    }
  }
}
```

### Claude Desktop

```json
{
  "mcpServers": {
    "security": {
      "command": "node",
      "args": ["/abs/path/to/dist/index.js"],
      "env": { "SECURITY_MCP_CONFIG": "/abs/path/to/security.config.yaml" }
    }
  }
}
```

## Configuring sources

`security.config.yaml` (see [`security.config.example.yaml`](./security.config.example.yaml)):

```yaml
policies:
  sources:
    - { type: file, path: ./examples/policies, patterns: ["**/*.md", "**/*.rego"] }
    - type: http
      base_url: https://policies.acme.internal/v1
      list_path: /policies
      get_path: /policies/{name}
      headers: { Authorization: "Bearer ${POLICY_API_TOKEN}" }
    - type: mcp
      command: npx
      args: ["-y", "@acme/policy-mcp"]

risk:
  sources:
    - { type: file, path: ./examples/risk, patterns: ["**/*.md"] }

paved_roads:
  sources:
    - { type: file, path: ./examples/paved-roads, patterns: ["**/*.md", "**/*.yaml"] }

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
      description: Request a security exception.
      method: POST
      url: https://exceptions.acme.internal/v1/exceptions
      headers: { Authorization: "Bearer ${EXCEPTION_API_TOKEN}" }
      body_template:
        repo: "{{repo}}"
        rule: "{{rule}}"
        justification: "{{justification}}"

  sources:
    - type: mcp
      command: npx
      args: ["-y", "@acme/kubectl-mcp"]
```

`${VAR}` is interpolated from the process environment.

## Tool inputs

```jsonc
// policy_tool / risk_index / paved_road_tool
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

Drop something like this in your repo's `AGENTS.md` / `CLAUDE.md` so the agent
calls into the MCP without needing to be reminded:

> Before generating infra/IaC/auth/data code, call `policy_tool(list)` and
> `risk_index(list, query=<feature>)`. Prefer items from `paved_road_tool(list)`.
> Validate with `tool_registry(invoke, name=conftest, …)` before opening a PR.

## Layout

```
src/
  index.ts              # MCP server + tool routing
  config.ts             # YAML schema (zod) + loader
  sources/
    types.ts            # Source / ToolSource interfaces
    file.ts             # local glob source
    http.ts             # REST source
    mcp.ts              # proxy to another MCP server
    command.ts          # inline tools (command + http)
  tools/
    content.ts          # policy / risk / paved-road handler
    tool_registry.ts    # tool registry handler
  util/env.ts           # ${ENV_VAR} interpolation
examples/
  policies/  risk/  paved-roads/
security.config.example.yaml
```

## License
Apache-2.0.
