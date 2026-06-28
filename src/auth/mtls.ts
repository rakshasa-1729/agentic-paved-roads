// SPDX-License-Identifier: Apache-2.0
import type { RequestHandler } from "express";
import type { TLSSocket } from "node:tls";
import { withPrincipal, log } from "../log.js";
import { reject } from "./index.js";
import { authAttempts } from "../metrics.js";

/**
 * mTLS authentication: extract the principal from the verified client
 * certificate's subject CN. The TLS layer (https.createServer with
 * requestCert + rejectUnauthorized) rejects peers whose cert is not
 * signed by the configured CA before the request reaches Express.
 *
 * This middleware reads the peer certificate from the TLS socket and
 * uses its subject CN as the principal. If the socket is not a TLS
 * socket (transport isn't HTTPS) or the cert is missing, the request is
 * rejected.
 */
export function mtlsMiddleware(): RequestHandler {
  return (req, res, next) => {
    const socket = req.socket as unknown as Partial<TLSSocket>;
    const cert = socket.getPeerCertificate?.();
    if (!cert || Object.keys(cert).length === 0) {
      log("warn", "auth.rejected", { mode: "mtls", reason: "no_client_cert" });
      authAttempts.inc({ mode: "mtls", ok: "false" });
      reject(res, "client certificate required");
      return;
    }
    const principal = extractPrincipal(cert);
    authAttempts.inc({ mode: "mtls", ok: "true" });
    withPrincipal(principal, () => next());
  };
}

function extractPrincipal(cert: import("node:tls").PeerCertificate): string {
  const cn = cert.subject?.CN;
  if (cn) return Array.isArray(cn) ? cn[0] : cn;
  const o = cert.subject?.O;
  if (o) return Array.isArray(o) ? o[0] : o;
  return "unknown";
}
