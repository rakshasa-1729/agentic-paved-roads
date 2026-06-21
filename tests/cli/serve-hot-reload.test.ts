// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(__dirname, "../..");
const SERVER_ENTRY = resolve(PROJECT_ROOT, "dist/index.js");

const INITIAL_CONFIG = `
server:
  name: hot-reload-test
collections: []
tools:
  registry: []
`;

const UPDATED_CONFIG = `
server:
  name: hot-reload-test
collections:
  - name: reloaded_collection
    description: Added after SIGHUP
    sources: []
tools:
  registry: []
`;

let tmpDir: string;
let configPath: string;
let child: ChildProcess;
let stderr = "";
let port: number;

function pickPort(): number {
  return 30_000 + Math.floor(Math.random() * 30_000);
}

async function waitForReady(p: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/healthz`);
      if (res.ok) return;
    } catch {
      // not yet listening
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server on :${p} did not become ready within ${timeoutMs}ms`);
}

async function waitForReload(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stderr.includes("server.reloaded")) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not emit server.reloaded within timeout");
}

async function rpc(method: string, params: unknown, id = 1): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  expect(res.ok).toBe(true);
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json() as Promise<Record<string, unknown>>;
  const raw = await res.text();
  const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error(`no SSE data line in body: ${raw}`);
  return JSON.parse(dataLine.replace(/^data:\s*/, "")) as Record<string, unknown>;
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "security-mcp-hot-reload-"));
  configPath = join(tmpDir, "config.yaml");
  writeFileSync(configPath, INITIAL_CONFIG);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SIGHUP hot-reload", () => {
  it("reloads config on SIGHUP without restarting the process", async () => {
    port = pickPort();

    child = spawn(process.execPath, [SERVER_ENTRY, "serve"], {
      env: {
        ...(process.env as Record<string, string>),
        MCP_TRANSPORT: "http",
        PORT: String(port),
        HOST: "127.0.0.1",
        SECURITY_MCP_CONFIG: configPath,
        LOG_LEVEL: "info",
        LOG_FORMAT: "json",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });

    await waitForReady(port);

    // Verify initial tools/list has only tool_registry
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    }, 0);
    let body = await rpc("tools/list", {}, 1);
    let result = body.result as { tools: Array<{ name: string }> };
    let names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["tool_registry"]);

    // Modify the config file to add a collection
    writeFileSync(configPath, UPDATED_CONFIG);

    // Send SIGHUP to trigger hot-reload
    child.kill("SIGHUP");

    // Wait for the reload confirmation in stderr
    await waitForReload();

    expect(stderr).toContain("server.reloading");
    expect(stderr).toContain("server.reloaded");
    expect(stderr).toContain("reloaded_collection");

    // Verify tools/list now includes the new collection
    body = await rpc("tools/list", {}, 2);
    result = body.result as { tools: Array<{ name: string }> };
    names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["reloaded_collection", "tool_registry"]);

    // Clean up
    child.kill("SIGTERM");
    const exitPromise = new Promise<{ code: number | null }>((resolve) => {
      child.on("exit", (code) => resolve({ code }));
    });
    const exited = await exitPromise;
    expect(exited.code).toBe(0);
  }, 20_000);
});
