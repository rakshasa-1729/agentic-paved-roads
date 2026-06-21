// SPDX-License-Identifier: Apache-2.0
import type { RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import { withPrincipal, log } from "../log.js";
import { reject } from "./index.js";
import { authAttempts } from "../metrics.js";

interface ApiKeyConfig {
  mode: "api_key";
  header_name: string;
  keys_env: string;
}

/**
 * Validate an API-key header against a list of keys loaded from an
 * environment variable. The env var value is a comma-separated list
 * of `key` or `key:principal` entries:
 *
 *   SECURITY_MCP_API_KEYS=secret-1:ci-bot,secret-2:audit-service,read-only
 *
 * A bare key uses itself as the principal (matching IAP behaviour).
 * A `key:principal` pair uses the label after the last `:` so the key
 * material never surfaces in logs or audit records.
 *
 * Keys are compared with `crypto.timingSafeEqual` to avoid timing
 * side-channels that would let an attacker enumerate valid keys.
 *
 * On success, the resolved principal is set via `withPrincipal`; on
 * failure the request is short-circuited with a 401.
 */
export function apiKeyMiddleware(cfg: ApiKeyConfig): RequestHandler {
  const headerName = cfg.header_name.toLowerCase();
  return (req, res, next) => {
    const raw = req.headers[headerName];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) {
      log("warn", "auth.rejected", { mode: "api_key", reason: "missing_header", header: cfg.header_name });
      authAttempts.inc({ mode: "api_key", ok: "false" });
      reject(res, `missing required header: ${cfg.header_name}`);
      return;
    }
    const entries = getValidKeys(cfg.keys_env);
    if (entries.length === 0) {
      log("error", "auth.rejected", { mode: "api_key", reason: "no_keys_configured", env: cfg.keys_env });
      authAttempts.inc({ mode: "api_key", ok: "false" });
      reject(res, "server has no API keys configured");
      return;
    }
    const matched = entries.find((entry) => safeEqual(value, entry.key));
    if (!matched) {
      log("warn", "auth.rejected", { mode: "api_key", reason: "invalid_key" });
      authAttempts.inc({ mode: "api_key", ok: "false" });
      reject(res, "invalid API key");
      return;
    }
    authAttempts.inc({ mode: "api_key", ok: "true" });
    withPrincipal(matched.principal, () => next());
  };
}

interface KeyEntry {
  key: string;
  principal: string;
}

function parseKeys(raw: string): KeyEntry[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.lastIndexOf(":");
      if (idx <= 0) return { key: entry, principal: entry };
      return { key: entry.slice(0, idx), principal: entry.slice(idx + 1) };
    });
}

let cachedKeys: { env: string; keys: KeyEntry[] } | undefined;

function getValidKeys(envName: string): KeyEntry[] {
  if (cachedKeys?.env === envName) return cachedKeys.keys;
  const raw = process.env[envName] ?? "";
  const keys = parseKeys(raw);
  cachedKeys = { env: envName, keys };
  return keys;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/** Test-only: clear the memoized key list so a fresh env var takes effect. */
export function _clearApiKeyCache(): void {
  cachedKeys = undefined;
}
