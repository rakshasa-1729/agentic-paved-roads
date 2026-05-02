# Deployment

Two ways to run security-mcp in production:

| Model              | Who runs it                | When to pick it |
|--------------------|----------------------------|-----------------|
| **Per-dev local**  | Each developer's laptop    | Default for small teams. The `bin/security-mcp` launcher is exactly this — see [`README.md`](../README.md). |
| **Shared remote**  | One service, many clients  | Centralized policy distribution, cross-team audit log, devs who can't run docker locally, larger orgs. |

This guide covers shared remote deploy on **Cloud Run** and **AWS
Lambda**. Both targets share the same architecture; the differences are
where auth lives and how DNS / TLS terminates.

The image speaks two transports — **stdio** (default, used by the
per-dev `bin/security-mcp` launcher) and **streamable HTTP** on `:8080`
(opt-in via `MCP_TRANSPORT=http`). HTTP mode is what Cloud Run /
Lambda / any other reverse-proxied target front. See
[§5 Transports](#5-transports) for the route shape.

---

## 1. Architecture (both targets)

```
   ┌─────────────────────────┐                       ┌──────────────────┐
   │  Cursor / Claude Code   │  https + bearer/IAP   │   Edge auth      │
   │  Codex / Continue       │ ─────────────────────▶│   (IAP / IAM /   │
   └─────────────────────────┘                       │    Cognito)      │
                                                     └────────┬─────────┘
                                                              │
                                                              ▼
                                          ┌──────────────────────────────┐
                                          │ security-mcp container       │
                                          │   - Streamable HTTP on :8080 │
                                          │   - reads ${SECURITY_REPO_   │
                                          │       TOKEN} from secret     │
                                          │   - serves policies / risk / │
                                          │       paved-roads from git   │
                                          │   - audit log → cloud log    │
                                          └──────────┬───────────────────┘
                                                     │
                              ┌──────────────────────┴───────────────────┐
                              ▼                                          ▼
                  ┌──────────────────────┐                   ┌──────────────────────┐
                  │ your security repo   │                   │ your tool backends   │
                  │ (private git)        │                   │ (e.g. exception API) │
                  └──────────────────────┘                   └──────────────────────┘
```

**Auth boundary**: pick where authentication happens. Three modes
ship out of the box, selected by the `auth.mode` config field:

- `iap` — the platform fronting the MCP (IAP on Cloud Run, an API
  Gateway authorizer on AWS, an Envoy filter, etc.) authenticates the
  user and forwards a trusted identity header
  (`X-Goog-Authenticated-User-Email` on GCP by default; configurable).
  The MCP trusts the header verbatim and never verifies a JWT itself.
  Lowest config, lowest crypto cost; safe only when nothing on the
  network path can spoof the header.
- `oidc` — the MCP verifies an `Authorization: Bearer <jwt>` against
  a configured issuer + audience using a remote JWKS. Bring your own
  IdP (Google, Okta, Cognito, internal). The principal is `email`,
  falling back to `preferred_username`, falling back to `sub`.
- `none` — no auth (development / behind a closed network only).

Whichever mode you pick, the authenticated principal is recorded on
every `tool.invoked` audit log line.

---

## 2. Cloud Run

### Prerequisites

- A GCP project with billing enabled.
- IAP API enabled (`gcloud services enable iap.googleapis.com`).
- Workload Identity Federation between your CI / deploy runner and
  GCP, OR a service account with `roles/run.admin`,
  `roles/iam.serviceAccountAdmin`, and `roles/secretmanager.admin` on
  the project.
- The `security-mcp` image hosted in Artifact Registry.
- A Google Group (Workday-synced, ideally) for the engineers allowed
  to call the MCP — usually engineering, not just security.

### What you provision

1. **Artifact Registry** repo for the image.
2. **Cloud Run service** in `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`
   mode. Set `MCP_TRANSPORT=http` so the container binds `:8080`
   (Streamable HTTP). Reads `SECURITY_REPO_TOKEN` from a Secret
   Manager secret bound to the runtime service account via
   `roles/secretmanager.secretAccessor`.
3. **Identity-Aware Proxy** brand + OAuth client + access binding for
   your engineering Google Group.
4. **External HTTPS load balancer**: global IP, managed SSL cert,
   URL map, target HTTPS proxy, `:443` forwarding rule, optional
   `:80 → :443` redirect.
5. **DNS A record** pointing at the LB IP.

The order matters: cert provisioning blocks until DNS resolves to the
IP, so DNS goes in early.

### Wire your editor

```jsonc
// ~/.cursor/mcp.json
{
  "mcpServers": {
    "security": {
      "url": "https://security-mcp.example.com/mcp",
      "headers": {
        // gcloud auth print-identity-token --audiences=https://security-mcp.example.com
        "Authorization": "Bearer ${env:GCP_ID_TOKEN}"
      }
    }
  }
}
```

A small helper (`bin/security-mcp-token` or similar) that runs
`gcloud auth print-identity-token --audiences=…` keeps the token fresh
without devs juggling it manually.

### Auth detail

IAP authenticates the user against the configured group and forwards
two headers to the container:

```
X-Goog-Authenticated-User-Email: accounts.google.com:user@example.com
X-Goog-Authenticated-User-Id:    accounts.google.com:1234567890
```

The MCP server reads `X-Goog-Authenticated-User-Email` for the audit
log; it does not verify a JWT itself.

---

## 3. AWS Lambda

For orgs already on AWS or that don't want to manage Cloud Run.
Lambda's response streaming (added Apr 2023) carries the Streamable
HTTP responses up to a 6 MB / 15 min cap per response — fine for
typical MCP sessions but long-lived connections will reconnect.

### Prerequisites

- An AWS account.
- ECR repo for the security-mcp image, wrapped with the
  [Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter)
  so the existing HTTP server runs unmodified on Lambda.
- AWS Secrets Manager secret holding the GitHub PAT for your security
  repo, accessible to the function role.

### What you provision

1. **Lambda function** packaged as a container image. Wrap with the
   public Lambda Web Adapter image so it bridges Lambda's invoke
   contract to a TCP listener:
   ```
   COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4 \
        /lambda-adapter /opt/extensions/lambda-adapter
   ENV PORT=8080
   ENV READINESS_CHECK_PATH=/healthz
   ENV AWS_LWA_INVOKE_MODE=response_stream
   ENV MCP_TRANSPORT=http
   ```
2. **Function URL** with `AuthType: AWS_IAM` and
   `InvokeMode: RESPONSE_STREAM`.
3. **IAM policy** on the function role granting
   `secretsmanager:GetSecretValue` on the security-repo PAT secret.

### Wire your editor

```jsonc
{
  "mcpServers": {
    "security": {
      "url": "https://<id>.lambda-url.<region>.on.aws/mcp",
      "headers": {
        "Authorization": "AWS4-HMAC-SHA256 ..."
      }
    }
  }
}
```

`AuthType: AWS_IAM` requires SigV4-signed requests. Two ways:
- **Helper script** that computes the auth header value (or presigned
  URL), exported as an env var Cursor's `${env:…}` substitution can
  read. Refresh per session.
- **Cognito User Pool** as the auth method instead — human-friendly
  browser login, but the MCP client must run an OAuth flow.

### Caveats

- **Cold start** ~1-2s for the security-mcp container. Set
  `ProvisionedConcurrentExecutions` to keep N hot if every-call latency
  matters.
- **15-min timeout** on Function URLs. The container runs in stateless
  HTTP mode (one server per request), so reconnects are transparent to
  the client — no session resume needed.
- **6 MB response cap** on streamed responses. Repos with thousands of
  files may need pagination; today the MCP returns the full list in
  one response.

---

## 4. Auth comparison

| Mechanism                          | Cloud Run | Lambda | Config snippet |
|------------------------------------|-----------|--------|----------------|
| IAP-injected header (no JWT verify)| ✅        | ✅     | `auth: { mode: iap, trusted_header: X-Goog-Authenticated-User-Email }` |
| IAM SigV4 (Function URL)           | n/a       | ✅     | The platform handles auth; MCP runs in `iap` mode trusting an IAM-injected header. |
| Cognito (Function URL)             | n/a       | ✅     | Either IAP-style (Cognito injects a header) or `oidc` mode against the user pool's issuer. |
| OIDC bearer (any provider)         | ✅        | ✅     | `auth: { mode: oidc, issuer: https://accounts.google.com, audience: <aud> }` |
| None (dev only)                    | ⚠         | ⚠      | `auth: { mode: none }`. Don't put this in front of anyone real. |

**Sample OIDC config** (Google as IdP, devs use `gcloud auth print-identity-token`):

```yaml
auth:
  mode: oidc
  issuer: https://accounts.google.com
  audience: <project-number>-<hash>.apps.googleusercontent.com
  # jwks_uri is auto-discovered from <issuer>/.well-known/openid-configuration;
  # set it explicitly for IdPs that don't expose discovery.
```

The principal extracted from a verified token is `email`, falling back
to `preferred_username`, falling back to `sub`. It appears as the
`principal` field on every `tool.invoked` log line.

---

## 5. Transports

The server speaks two transports out of the box. Pick one with the
`MCP_TRANSPORT` env var:

| Transport      | When                              | How |
|----------------|-----------------------------------|-----|
| `stdio` (default) | Per-dev local — launched by the MCP client over stdin/stdout. | `docker run -i --rm security-mcp:latest` |
| `http`         | Shared deploys behind a reverse proxy (Cloud Run, Lambda, Kubernetes, …). | `MCP_TRANSPORT=http PORT=8080 docker run ...` |

`http` mode implements [Streamable HTTP][streamable-http] — the
current MCP transport that supersedes the older HTTP+SSE pairing. One
endpoint, one verb pattern:

```
POST   /mcp        — JSON-RPC requests; response is either application/json
                     or text/event-stream depending on what the client
                     accepts. The server picks SSE when streaming is useful.
GET    /mcp        — 405 (stateless mode rejects server-initiated streams)
DELETE /mcp        — 405
GET    /healthz    — liveness probe; returns {"status":"ok"} as JSON
```

The container runs in **stateless** mode: each `POST /mcp` builds a
fresh `Server` + transport, handles the request, and tears them down
on response close. No session affinity — load-balance freely. The
trade-off is no server-pushed notifications across the connection,
which the shipped tools don't use.

DNS-rebinding protection is on by default via the SDK's
`createMcpExpressApp` helper. Override the allowlist with
`ALLOWED_HOSTS=host1,host2,…` if you front the container with a domain
the SDK doesn't infer.

### Quick check

```bash
docker run --rm -p 8080:8080 -e MCP_TRANSPORT=http security-mcp:latest &
curl -s localhost:8080/healthz
# → {"status":"ok","transport":"http"}

curl -sN -X POST localhost:8080/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2024-11-05","capabilities":{},
                 "clientInfo":{"name":"curl","version":"0"}}}'
# → event: message
#   data: {"result":{"protocolVersion":"…","serverInfo":{…}}, …}
```

[streamable-http]: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http

---

## 6. Operational notes

- **Cost** (rough): Cloud Run min-instance=0 idles to zero — only pay
  for active sessions. Lambda pricing is similar; the bigger
  consideration is that Lambda reconnects every 15 min for long-lived
  streaming responses.
- **Audit log**: two layers ship.
  1. Structured JSON-line logs to stderr → Cloud Logging / CloudWatch
     natively. Every `tool.invoked` / `tool.failed` event carries
     `request_id` + (if auth is on) `principal`. No special config.
  2. Optional durable JSONL via `audit_log: <path>` in the config.
     One redacted line per `tools/call` with args **hashed** (sha256,
     16 hex chars), not logged verbatim — safe to tail to a shared
     volume / GCS bucket / S3 prefix. Mount the path in the
     container; rotate externally (`logrotate`, daily rolls, etc.).
- **Token rotation**: `SECURITY_REPO_TOKEN` is a fine-grained PAT. For
  long-lived deploys, swap to a GitHub App installation token (~50
  lines in `src/sources/github.ts` to use `octokit` with app auth).
- **Scaling**: read-heavy, mostly cached behind the github source's
  60-second tree cache. A single instance handles 100+ concurrent dev
  sessions comfortably.

---

## Quick reference

```
Are there fewer than ~10 devs?
  └─ Yes → per-dev local (README.md). Don't over-engineer.

Are devs all in one cloud (GCP / AWS)?
  └─ Yes → that cloud's deployment path above.

Do you need a single audit log across the org?
  └─ Yes → shared deploy (either cloud).

Is your security content in private git the MCP can reach?
  └─ Yes → either path works.
  └─ No → fix that first; the MCP needs network access to the source.
```
