# Deployment

Two ways to run security-mcp in production:

| Model              | Who runs it                | When to pick it |
|--------------------|----------------------------|-----------------|
| **Per-dev local**  | Each developer's laptop    | Default for small teams. The `bin/security-mcp` launcher is exactly this — see [`README.md`](../README.md). |
| **Shared remote**  | One service, many clients  | Centralized policy distribution, cross-team audit log, devs who can't run docker locally, larger orgs. |

This guide covers shared remote deploy on **Cloud Run** and **AWS
Lambda**. Both targets share the same architecture; the differences are
where auth lives and how DNS / TLS terminates.

> ⚠ **Prerequisite — SSE transport.** The current image speaks stdio
> only. Cloud Run, Lambda, and any other HTTP-fronted target need the
> server to expose JSON-RPC over HTTP+SSE.
> [Section 5 below](#5-sse-transport-the-prerequisite) sketches the
> ~80-line change needed in `src/index.ts`. Until that lands, the
> guidance below is concrete-but-not-yet-runnable.

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
                                          │   - HTTP+SSE on :8080        │
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

**Auth boundary**: the platform fronting the MCP (IAP on Cloud Run, IAM
on a Lambda Function URL) authenticates the user. The MCP container
trusts the platform-injected identity header
(`X-Goog-Authenticated-User-Email` on GCP, the corresponding signed
identity on AWS). The container itself does no token verification —
that keeps the MCP code focused on its job and lets the cloud platform
own auth rotation.

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
   mode. Container exposes `:8080` (SSE) and reads
   `SECURITY_REPO_TOKEN` from a Secret Manager secret bound to the
   runtime service account via `roles/secretmanager.secretAccessor`.
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
      "url": "https://security-mcp.example.com/sse",
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
Lambda's response streaming (added Apr 2023) supports SSE up to a
6 MB / 15 min cap per response — fine for typical MCP sessions but
long-lived connections will reconnect.

### Prerequisites

- An AWS account.
- ECR repo for the security-mcp image, wrapped with the
  [Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter)
  so the existing HTTP+SSE server runs unmodified on Lambda.
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
   ENV MCP_TRANSPORT=sse
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
      "url": "https://<id>.lambda-url.<region>.on.aws/sse",
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
- **15-min timeout** on Function URLs. Long-lived MCP sessions
  reconnect; the SDK's SSE client handles reconnection if the client
  speaks `Last-Event-Id` correctly.
- **6 MB response cap** on streamed responses. Repos with thousands of
  files may need pagination; today the MCP returns the full list in
  one response.

---

## 4. Auth comparison

| Mechanism                          | Cloud Run | Lambda | Notes |
|------------------------------------|-----------|--------|-------|
| IAP-injected header (no JWT verify)| ✅        | n/a    | Default for the Cloud Run path. |
| IAM SigV4 (Function URL)           | n/a       | ✅     | Default for the Lambda path. Devs need AWS creds. |
| Cognito (Function URL)             | n/a       | ✅     | Human-friendly browser login; SDK clients need OAuth. |
| OIDC bearer (any provider)         | ✅        | ✅     | Bring your own IdP. Requires server-side auth code — **not yet shipped.** |
| None (dev only)                    | ⚠         | ⚠      | Don't put this in front of anyone real. |

The current container does NOT verify OIDC bearer tokens. Adding a
small middleware (~100 lines, `jose` / `jsonwebtoken`) is straightforward
once SSE transport lands; until then, rely on IAP / IAM as the auth
boundary.

---

## 5. SSE transport (the prerequisite)

### Why it's needed

MCP clients speak the protocol over either:
- **stdio** — process-per-session. The current container does this.
  Inherently local.
- **HTTP+SSE** — JSON-RPC requests on `POST /messages`, responses +
  notifications streamed on `GET /sse`. Required for any HTTP-fronted
  target.

The MCP TypeScript SDK ships
[`SSEServerTransport`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/src/server)
already; switching the bootstrap is the only code change.

### Sketch

In `src/index.ts`, replace the unconditional `StdioServerTransport`
with an env-driven switch:

```ts
const transport = process.env.MCP_TRANSPORT === "sse"
  ? sseTransport()
  : new StdioServerTransport();

function sseTransport() {
  const app = express();
  const sessions = new Map<string, SSEServerTransport>();

  app.get("/sse", async (req, res) => {
    const t = new SSEServerTransport("/messages", res);
    sessions.set(t.sessionId, t);
    res.on("close", () => sessions.delete(t.sessionId));
    await server.connect(t);
  });

  app.post("/messages", express.json(), async (req, res) => {
    const sid = req.query.sessionId as string;
    const t = sessions.get(sid);
    if (!t) { res.status(404).end(); return; }
    await t.handlePostMessage(req, res);
  });

  app.listen(Number(process.env.PORT ?? 8080));
  return null; // server.connect() called per-session above
}
```

Wire `Dockerfile`'s `CMD` to honor `MCP_TRANSPORT=sse` and `EXPOSE 8080`.
That's the whole change — ~80 lines including types and error handling.

### Status

- [ ] SSE transport in `src/index.ts`
- [ ] `MCP_TRANSPORT` env switch
- [ ] `EXPOSE 8080` in Dockerfile (currently no port — stdio only)
- [ ] Tests for the HTTP path

When this is done, Cloud Run / Lambda deploys work end-to-end.

---

## 6. Operational notes

- **Cost** (rough): Cloud Run min-instance=0 idles to zero — only pay
  for active sessions. Lambda pricing is similar; the bigger
  consideration is that Lambda reconnects every 15 min for long-lived
  SSE connections.
- **Audit log**: structured JSON to stderr → Cloud Logging /
  CloudWatch natively. No special config needed; both platforms tail
  stdio.
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
