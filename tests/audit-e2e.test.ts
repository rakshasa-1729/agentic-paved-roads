// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Server } from "node:http";
import { AddressInfo } from "node:net";
import { buildHttpApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { type AuditRecorder, openAuditLog } from "../src/audit.js";

// Confirm a real /mcp tools/call produces an audit-log line carrying
// the principal extracted by the IAP middleware. End-to-end through
// the actual express app + auth middleware + tool dispatcher.

const PROJECT_ROOT = resolve(__dirname, "..");
const POLICIES_DIR = resolve(PROJECT_ROOT, "examples/policies");

let tmp: string;
let auditPath: string;
let server: Server;
let baseUrl: string;
let recorder: AuditRecorder;
const originalLogLevel = process.env.LOG_LEVEL;

beforeAll(async () => {
  process.env.LOG_LEVEL = "error";
  tmp = mkdtempSync(join(tmpdir(), "security-mcp-audit-e2e-"));
  const configPath = join(tmp, "config.yaml");
  auditPath = join(tmp, "audit.jsonl");
  writeFileSync(
    configPath,
    `
server: { name: audit-e2e }
audit_log: ${auditPath}
auth: { mode: iap, trusted_header: X-Goog-Authenticated-User-Email }
collections:
  - name: policy_tool
    sources:
      - { type: file, name: local, path: ${POLICIES_DIR}, patterns: ["**/*.md"] }
tools:
  registry: []
`,
  );
  const cfg = await loadConfig(configPath);
  recorder = openAuditLog(cfg.auditLogPath);
  const app = buildHttpApp(cfg, { allowedHosts: ["127.0.0.1"], audit: recorder });
  server = await new Promise<Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await recorder.close();
  rmSync(tmp, { recursive: true, force: true });
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
});

async function rpc(body: unknown, principal = "accounts.google.com:audit@example.com"): Promise<Response> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "X-Goog-Authenticated-User-Email": principal,
    },
    body: JSON.stringify(body),
  });
  // Streamable HTTP sends headers (200) immediately and writes the
  // body afterwards. Drain the body so that by the time we return,
  // the handler — including audit.record — has completed.
  await res.text();
  return res;
}

describe("audit log E2E", () => {
  it("writes one record per tools/call carrying the authenticated principal", async () => {
    // Stateless mode still requires initialize before tools/call,
    // since each POST gets its own Server instance.
    await rpc({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "policy_tool", arguments: { action: "list" } },
    });

    // Flush the writer so the line is on disk before we read.
    await recorder.close();
    const lines = readFileSync(auditPath, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    expect(last.tool).toBe("policy_tool");
    expect(last.action).toBe("list");
    expect(last.principal).toBe("audit@example.com");
    expect(last.ok).toBe(true);
    expect(typeof last.duration_ms).toBe("number");
    expect(last.args_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(last.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
