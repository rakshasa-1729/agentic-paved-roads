// SPDX-License-Identifier: Apache-2.0
import type { RequestHandler } from "express";
import type { AuthConfigType } from "../config.js";
import { iapMiddleware } from "./iap.js";
import { oidcMiddleware } from "./oidc.js";
import { apiKeyMiddleware } from "./api_key.js";
import { mtlsMiddleware } from "./mtls.js";
import { authAttempts } from "../metrics.js";

/**
 * Build the express middleware that authenticates incoming /mcp
 * requests. Mode is selected by the `auth.mode` config field:
 *
 *   none    — pass-through; no principal recorded.
 *   iap     — trust a configured platform-injected header (default
 *             X-Goog-Authenticated-User-Email). For Cloud Run + IAP, AWS
 *             API Gateway with a Cognito authorizer, etc.
 *   oidc    — verify an `Authorization: Bearer <jwt>` against a
 *             configured issuer + audience using a remote JWKS.
 *   api_key — validate a shared secret from a configured header
 *             against keys in an environment variable.
 *   mtls    — extract the principal from the verified client cert's
 *             subject CN. Requires `tls` config for the HTTPS listener.
 *
 * On success the middleware sets the authenticated principal in
 * AsyncLocalStorage (via withPrincipal) so subsequent log lines and
 * the tool.invoked audit record carry it. On failure it short-circuits
 * with a 401 + JSON-RPC error envelope and never invokes the next
 * handler.
 */
export function buildAuthMiddleware(cfg: AuthConfigType): RequestHandler {
  switch (cfg.mode) {
    case "none":
      return (_req, _res, next) => {
        authAttempts.inc({ mode: "none", ok: "true" });
        next();
      };
    case "iap":
      return iapMiddleware(cfg);
    case "oidc":
      return oidcMiddleware(cfg);
    case "api_key":
      return apiKeyMiddleware(cfg);
    case "mtls":
      return mtlsMiddleware();
  }
}

/** Helper for short-circuit responses. JSON-RPC envelope, 401 status. */
export function reject(res: import("express").Response, message: string): void {
  if (res.headersSent) return;
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message },
    id: null,
  });
}
