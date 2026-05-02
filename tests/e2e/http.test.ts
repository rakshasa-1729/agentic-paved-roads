// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Server } from "node:http";
import { AddressInfo } from "node:net";
import { buildHttpApp } from "../../src/index.js";
import { loadConfig } from "../../src/config.js";

// In-process HTTP E2E: build the same express app `serveHttp` uses,
// bind it to an ephemeral port, and drive it with raw fetch over the
// streamable-HTTP framing the SDK speaks.

const PROJECT_ROOT = resolve(__dirname, "../..");
const POLICIES_DIR = resolve(PROJECT_ROOT, "examples/policies");

const CONFIG = `
server:
  name: e2e-http
collections:
  - name: policy_tool
    description: Test policies served from examples/.
    sources:
      - type: file
        name: local-policies
        path: ${POLICIES_DIR}
        patterns: ["**/*.md"]
tools:
  registry: []
`;

let tmp: string;
let server: Server;
let baseUrl: string;

const originalLogLevel = process.env.LOG_LEVEL;

beforeAll(async () => {
  // Silence structured log output so the test runner stays readable.
  process.env.LOG_LEVEL = "error";
  tmp = mkdtempSync(join(tmpdir(), "security-mcp-e2e-http-"));
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, CONFIG);

  const cfg = await loadConfig(configPath);
  // Allow the loopback address the test server binds to so the SDK's
  // DNS-rebinding protection lets our request through.
  const app = buildHttpApp(cfg, { allowedHosts: ["127.0.0.1"] });
  server = await new Promise<Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  rmSync(tmp, { recursive: true, force: true });
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
});

/**
 * Parse a streamable-HTTP response body. The server picks `text/event-stream`
 * when streaming is useful — even single-shot responses come back as one
 * SSE `data:` line. Falls back to JSON for the application/json path.
 */
async function parseMcpBody(res: Response): Promise<Record<string, unknown>> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json() as Promise<Record<string, unknown>>;
  const raw = await res.text();
  const dataLine = raw
    .split("\n")
    .find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error(`no SSE data line in body: ${raw}`);
  return JSON.parse(dataLine.replace(/^data:\s*/, "")) as Record<string, unknown>;
}

async function rpc(method: string, params: unknown, id = 1): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  expect(res.ok).toBe(true);
  return parseMcpBody(res);
}

describe("http E2E", () => {
  it("/healthz returns 200 with status=ok", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; transport: string };
    expect(body).toEqual({ status: "ok", transport: "http" });
  });

  it("GET /mcp returns 405 (stateless mode)", async () => {
    const res = await fetch(`${baseUrl}/mcp`);
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32000);
  });

  it("DELETE /mcp returns 405 (stateless mode)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  it("initialize → tools/list returns the configured collection", async () => {
    await rpc(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e", version: "0" },
      },
      0,
    );
    const body = await rpc("tools/list", {}, 1);
    const result = body.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["policy_tool", "tool_registry"]);
  });

  it("tools/call policy_tool list returns the example markdown files", async () => {
    await rpc(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "e2e", version: "0" },
      },
      0,
    );
    const body = await rpc(
      "tools/call",
      { name: "policy_tool", arguments: { action: "list" } },
      2,
    );
    const result = body.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).toContain("tagging.md");
    expect(text).toContain("network-exposure.md");
  });
});
