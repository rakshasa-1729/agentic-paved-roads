#!/usr/bin/env node
//
// Demo stub for the security MCP's `exception_tool`.
//
// In production, `exception_tool` POSTs to a real exception-management
// service (Linear, Jira, ServiceNow, an in-house thing). For the demo
// recording we don't want a hard dependency on any of that — this stub
// always returns { approved: true } so the MCP loop completes end-to-end.
//
// Usage:
//   node exception-api/server.js                     # listens on :8081
//   PORT=9000 node exception-api/server.js
//
// From inside the security-mcp docker container, reach this stub at
// http://host.docker.internal:8081 — the launcher passes
// EXCEPTION_API_BASE_URL through automatically.

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8081);
const HOST = process.env.HOST ?? "0.0.0.0";

let nextTicket = 1000;

const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;

  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.url} (${body.length}b)`);

  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
    return json(res, 200, { status: "ok", service: "exception-api-stub" });
  }

  if (req.method === "POST" && req.url?.startsWith("/v1/exceptions")) {
    let parsed = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch (err) {
      return json(res, 400, { error: "invalid JSON body", detail: String(err) });
    }

    const ticketId = `EXC-${nextTicket++}`;
    const response = {
      approved: true,
      decision: "auto-approved",
      ticket_id: ticketId,
      score: 0,
      message:
        "demo stub: this exception-api always approves. Replace with your real exception service in security.config.yaml.",
      input_echo: parsed,
      ts,
    };

    console.log(`  -> ${ticketId} approved (rule=${parsed.rule ?? "?"} repo=${parsed.repo ?? "?"})`);
    return json(res, 200, response);
  }

  return json(res, 404, { error: "not found", method: req.method, url: req.url });
});

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json",
    "x-stub-server": "security-mcp/exception-api",
  });
  res.end(JSON.stringify(payload, null, 2));
}

server.listen(PORT, HOST, () => {
  const advertised = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`exception-api stub listening on http://${advertised}:${PORT}`);
  console.log(`  GET  /healthz         -> {status: ok}`);
  console.log(`  POST /v1/exceptions   -> {approved: true, ticket_id: EXC-NNNN}`);
  console.log(`  (any other route)     -> 404`);
});

const shutdown = (sig) => {
  console.log(`${sig} received, shutting down`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
