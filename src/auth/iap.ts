// SPDX-License-Identifier: Apache-2.0
import type { RequestHandler } from "express";
import { withPrincipal, log } from "../log.js";
import { reject } from "./index.js";

interface IapConfig {
  mode: "iap";
  trusted_header: string;
}

/**
 * Trust a platform-injected identity header. The MCP container does
 * NOT verify a JWT itself in this mode — the assumption is that an
 * upstream proxy (IAP on Cloud Run, an API Gateway authorizer on AWS,
 * an Envoy filter, etc.) has already authenticated the user and is
 * the only thing on the network path that can set this header.
 *
 * Misuse mode: if the container is exposed without that proxy, ANY
 * client can spoof the header and authenticate as anyone. The doctor
 * command and the docs both flag this — keep IAP mode behind a real
 * edge auth.
 */
export function iapMiddleware(cfg: IapConfig): RequestHandler {
  const headerName = cfg.trusted_header.toLowerCase();
  return (req, res, next) => {
    const raw = req.headers[headerName];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) {
      log("warn", "auth.rejected", { mode: "iap", reason: "missing_header", header: cfg.trusted_header });
      reject(res, `missing required header: ${cfg.trusted_header}`);
      return;
    }
    // IAP prefixes the email with "accounts.google.com:" — strip for
    // log readability without losing the namespace info.
    const principal = value.replace(/^accounts\.google\.com:/, "");
    withPrincipal(principal, () => next());
  };
}
