# `exception-api/` — demo stub

A tiny HTTP service that always approves any exception request. Stand-in
for the real exception-management service that `tool_registry invoke
exception_tool` calls in production.

Zero dependencies (Node's built-in `http`). One file.

## Run

```bash
node exception-api/server.js               # :8081 by default
PORT=9000 node exception-api/server.js     # custom port
```

You'll see:

```
exception-api stub listening on http://localhost:8081
  GET  /healthz         -> {status: ok}
  POST /v1/exceptions   -> {approved: true, ticket_id: EXC-NNNN}
```

Each request is logged to stdout — useful during demo recording so you
can see the agent calling the API in real time.

## How the security MCP reaches it

`bin/security-mcp` defaults `EXCEPTION_API_BASE_URL` to
`http://host.docker.internal:8081` and passes it into the container via
`-e`. On macOS / Windows Docker Desktop this resolves to the host
automatically. On Linux you'd add `--add-host=host.docker.internal:host-gateway`
to your docker invocation (the launcher already handles this on
platforms that need it).

You can override:

```bash
EXCEPTION_API_BASE_URL=https://exceptions.acme.internal bin/security-mcp
```

## Endpoint contract (so you can swap in a real service)

```
POST /v1/exceptions
Authorization: Bearer <token>     # ignored by stub; real services should validate
Content-Type:  application/json

{
  "repo":          "acme/internal-admin",
  "rule":          "cloud-run-iap",
  "resource":      "module.svc.google_cloud_run_v2_service.this",
  "justification": "string",
  "duration_hours": 8,
  "data_class":    "internal" | "confidential" | ...,
  "env":           "dev" | "staging" | "prod" | "sandbox",
  "audience":      "internal" | "internal-vpc" | "public",
  "compensating_controls": ["waf", "vpc_sc"]
}
```

Response (200):

```json
{
  "approved": true,
  "decision": "auto-approved",
  "ticket_id": "EXC-1000",
  "score": 0,
  "message": "...",
  "input_echo": { ... },
  "ts": "2026-04-29T..."
}
```

A real backend would compute the composite risk score per
`risk/exception-thresholds.md`, decide auto-approve / human-review /
block, and create a ticket if needed. The stub skips all of that.
