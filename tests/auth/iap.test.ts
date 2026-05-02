// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Server } from "node:http";
import { AddressInfo } from "node:net";
import { buildHttpApp } from "../../src/server.js";
import type { LoadedConfig } from "../../src/config.js";
import { InlineToolSource } from "../../src/sources/command.js";

let server: Server;
let baseUrl: string;
const originalLogLevel = process.env.LOG_LEVEL;

const cfg: LoadedConfig = {
  server: { name: "test", version: "0.0.0" },
  collections: [],
  tools: { registry: new InlineToolSource([]), mcpSources: [] },
  auth: { mode: "iap", trusted_header: "X-Goog-Authenticated-User-Email" },
};

beforeAll(async () => {
  process.env.LOG_LEVEL = "error";
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

async function callMcp(headers: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  });
}

describe("IAP middleware", () => {
  it("rejects requests missing the trusted header with 401", async () => {
    const res = await callMcp({});
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code: number; message: string } };
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.message).toMatch(/missing required header/i);
  });

  it("admits requests carrying the trusted header", async () => {
    const res = await callMcp({ "X-Goog-Authenticated-User-Email": "alice@example.com" });
    expect(res.status).toBe(200);
  });

  it("/healthz stays open even without the header", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("the GET /mcp 405 path runs before auth (so probes still get a structured 405)", async () => {
    const res = await fetch(`${baseUrl}/mcp`);
    // GET /mcp returns 405 with JSON-RPC envelope; auth never fires
    // because the route handler short-circuits on the wrong method.
    expect(res.status).toBe(405);
  });
});
