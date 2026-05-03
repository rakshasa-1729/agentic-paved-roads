// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Server } from "node:http";
import { AddressInfo } from "node:net";
import { buildHttpApp } from "../src/server.js";
import type { LoadedConfig } from "../src/config.js";
import { InlineToolSource } from "../src/sources/command.js";
import { _resetMetrics } from "../src/metrics.js";

const cfg: LoadedConfig = {
  server: { name: "metrics-test", version: "0.0.0" },
  collections: [],
  tools: { registry: new InlineToolSource([]), mcpSources: [] },
  auth: { mode: "none" },
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = buildHttpApp(cfg, { allowedHosts: ["127.0.0.1"] });
  server = await new Promise<Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(
  () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
);

beforeEach(() => _resetMetrics());

async function rpc(body: unknown): Promise<Response> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  await res.text(); // drain
  return res;
}

describe("/metrics endpoint", () => {
  it("exposes the Prometheus text-format with default Node metrics", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    const body = await res.text();
    // Default node metrics are auto-registered with our prefix.
    expect(body).toMatch(/security_mcp_process_cpu_user_seconds_total/);
    // Custom metrics surface even with zero observations.
    expect(body).toMatch(/security_mcp_tool_invocations_total/);
    expect(body).toMatch(/security_mcp_audit_writes_total/);
  });

  it("counts http_requests by status class for each /mcp call", async () => {
    await rpc({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    const body = await fetch(`${baseUrl}/metrics`).then((r) => r.text());
    expect(body).toMatch(/security_mcp_http_requests_total\{status_class="2xx"\} 1/);
  });

  it("increments tool_invocations on a tools/call", async () => {
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
      params: { name: "tool_registry", arguments: { action: "list" } },
    });
    const body = await fetch(`${baseUrl}/metrics`).then((r) => r.text());
    expect(body).toMatch(/security_mcp_tool_invocations_total\{tool="tool_registry",ok="true"\} 1/);
    expect(body).toMatch(/security_mcp_tool_duration_ms_count\{tool="tool_registry",ok="true"\} 1/);
  });
});
