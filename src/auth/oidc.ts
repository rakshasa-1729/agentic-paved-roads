// SPDX-License-Identifier: Apache-2.0
import type { RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { log, withPrincipal } from "../log.js";
import { reject } from "./index.js";
import { authAttempts } from "../metrics.js";

interface OidcConfig {
  mode: "oidc";
  issuer: string;
  audience: string | string[];
  jwks_uri?: string;
}

/**
 * Verify an `Authorization: Bearer <jwt>` against a configured issuer
 * and audience. Resolves the JWKS once per process from either the
 * configured `jwks_uri` or the discovery document at
 * `<issuer>/.well-known/openid-configuration`.
 *
 * The principal extracted into AsyncLocalStorage is, in order:
 *   email > preferred_username > sub
 *
 * Per-request budget: 5 s. The JWKS itself is cached by jose so the
 * hot path is local crypto only.
 */
export function oidcMiddleware(cfg: OidcConfig): RequestHandler {
  const jwks = createKeyResolver(cfg);
  return async (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
      log("warn", "auth.rejected", { mode: "oidc", reason: "missing_bearer" });
      authAttempts.inc({ mode: "oidc", ok: "false" });
      reject(res, "missing or malformed Authorization: Bearer header");
      return;
    }
    const token = auth.slice("bearer ".length).trim();
    try {
      const { payload } = await jwtVerify(token, await jwks, {
        issuer: cfg.issuer,
        audience: cfg.audience,
      });
      const principal = principalFrom(payload);
      authAttempts.inc({ mode: "oidc", ok: "true" });
      withPrincipal(principal, () => next());
    } catch (err) {
      // jose error codes: ERR_JWS_SIGNATURE_VERIFICATION_FAILED,
      // ERR_JWT_EXPIRED, ERR_JWT_CLAIM_VALIDATION_FAILED, …
      const code = (err as { code?: string }).code ?? "unknown";
      log("warn", "auth.rejected", { mode: "oidc", reason: "verify_failed", code });
      authAttempts.inc({ mode: "oidc", ok: "false" });
      reject(res, "invalid token");
    }
  };
}

function principalFrom(payload: JWTPayload): string {
  const email = typeof payload.email === "string" ? payload.email : undefined;
  const preferred = typeof payload.preferred_username === "string" ? payload.preferred_username : undefined;
  return email ?? preferred ?? payload.sub ?? "unknown";
}

let cachedResolver: { issuer: string; key: Promise<JWTVerifyGetKey> } | undefined;

function createKeyResolver(cfg: OidcConfig): Promise<JWTVerifyGetKey> {
  // Memoize per-issuer so subsequent middleware constructions during
  // tests (or hypothetical hot reload) reuse the same JWKS cache.
  if (cachedResolver?.issuer === cfg.issuer) return cachedResolver.key;
  const key = (async () => {
    const url = cfg.jwks_uri ?? (await discoverJwksUri(cfg.issuer));
    return createRemoteJWKSet(new URL(url));
  })();
  cachedResolver = { issuer: cfg.issuer, key };
  return key;
}

/**
 * Resolve the JWKS URI from `<issuer>/.well-known/openid-configuration`.
 * Most providers expose this; some (custom IdPs, internal Cognito
 * setups) only expose JWKS directly — those should set `jwks_uri`
 * explicitly in the config.
 */
async function discoverJwksUri(issuer: string): Promise<string> {
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`OIDC discovery failed at ${url}: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { jwks_uri?: string };
  if (!body.jwks_uri) throw new Error(`OIDC discovery at ${url} returned no jwks_uri`);
  return body.jwks_uri;
}

/** Test-only: forget any memoized resolver so a fresh config takes effect. */
export function _clearJwksCache(): void {
  cachedResolver = undefined;
}
