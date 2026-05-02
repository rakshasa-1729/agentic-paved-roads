// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Server } from "node:http";
import { AddressInfo } from "node:net";
import { buildHttpApp } from "../../src/server.js";
import type { LoadedConfig } from "../../src/config.js";
import { InlineToolSource } from "../../src/sources/command.js";
import { withPrincipal, log } from "../../src/log.js";

// End-to-end: under IAP, an authenticated /mcp call must produce a
// `tool.invoked` log line carrying the principal extracted from the
// trusted header. Confirms withPrincipal threads through the SDK call
// dispatcher (via AsyncLocalStorage) without explicit plumbing.

let server: Server;
let baseUrl: string;
const originalLogLevel = process.env.LOG_LEVEL;
let stderrSpy: ReturnType<typeof vi.spyOn>;

const cfg: LoadedConfig = {
  server: { name: "test", version: "0.0.0" },
  collections: [],
  tools: { registry: new InlineToolSource([]), mcpSources: [] },
  auth: { mode: "iap", trusted_header: "X-Goog-Authenticated-User-Email" },
};

beforeAll(async () => {
  // Pin LOG_LEVEL=info so tool.invoked is emitted; capture stderr.
  process.env.LOG_LEVEL = "info";
  const app = buildHttpApp(cfg, { allowedHosts: ["127.0.0.1"] });
  server = await new Promise<Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
});

describe("principal threading", () => {
  it("withPrincipal directly attaches the field to log records", () => {
    const buf: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      buf.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    });
    try {
      withPrincipal("alice@example.com", () => log("info", "test", { x: 1 }));
    } finally {
      spy.mockRestore();
    }
    const record = JSON.parse(buf.join("").trim()) as Record<string, unknown>;
    expect(record.principal).toBe("alice@example.com");
  });

  it("an authenticated tools/call records principal in the tool.invoked audit line", async () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // initialize → tools/call
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "X-Goog-Authenticated-User-Email": "accounts.google.com:bob@example.com",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "tool_registry", arguments: { action: "list" } },
        }),
      });
      // Drain the stderr buffer for the tool.invoked record.
      const lines = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return { event: "non-json" };
          }
        });
      const invoked = lines.find((l) => l.event === "tool.invoked");
      expect(invoked).toBeDefined();
      // The "accounts.google.com:" prefix is stripped by the IAP middleware.
      expect(invoked?.principal).toBe("bob@example.com");
      expect(invoked?.request_id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
