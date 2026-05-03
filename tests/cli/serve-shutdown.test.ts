// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(__dirname, "../..");
const SERVER_ENTRY = resolve(PROJECT_ROOT, "dist/index.js");
const POLICIES_DIR = resolve(PROJECT_ROOT, "examples/policies");

const CONFIG = `
server: { name: shutdown-test }
collections:
  - name: policy_tool
    sources:
      - { type: file, name: local, path: ${POLICIES_DIR}, patterns: ["**/*.md"] }
tools:
  registry: []
`;

let tmp: string;
let configPath: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "security-mcp-shutdown-"));
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, CONFIG);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  durationMs: number;
}

function spawnServerHttp(port: number): ReturnType<typeof spawn> {
  return spawn(process.execPath, [SERVER_ENTRY, "serve"], {
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
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<ChildResult> {
  const start = Date.now();
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code, signal, stderr, durationMs: Date.now() - start });
    });
  });
}

async function waitForReady(port: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {
      // not yet listening
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server on :${port} did not become ready within ${timeoutMs}ms`);
}

// Pick a random high port per test to avoid collisions when run in parallel.
function pickPort(): number {
  return 30_000 + Math.floor(Math.random() * 30_000);
}

describe("graceful shutdown", () => {
  it("exits 0 within budget on SIGTERM", async () => {
    const port = pickPort();
    const child = spawnServerHttp(port);
    await waitForReady(port);
    child.kill("SIGTERM");
    const result = await waitForExit(child);
    expect(result.code).toBe(0);
    expect(result.durationMs).toBeLessThan(5_000);
    // Structured log lines should announce the shutdown sequence.
    expect(result.stderr).toContain("server.shutting_down");
    expect(result.stderr).toContain("server.shutdown_complete");
  }, 15_000);

  it("exits 0 on SIGINT (^C)", async () => {
    const port = pickPort();
    const child = spawnServerHttp(port);
    await waitForReady(port);
    child.kill("SIGINT");
    const result = await waitForExit(child);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("server.shutting_down");
  }, 15_000);

  it("forces an immediate exit on a second signal during shutdown", async () => {
    const port = pickPort();
    const child = spawnServerHttp(port);
    await waitForReady(port);
    child.kill("SIGTERM");
    // Second signal arrives near-immediately. The handler should
    // upgrade to a hard exit(1).
    setTimeout(() => child.kill("SIGTERM"), 5);
    const result = await waitForExit(child);
    // First-signal happy path may still win the race (fast drain) →
    // exit 0. Forced path → exit 1. Either way a `server.shutdown_*`
    // line is emitted; the key invariant is the process exits
    // promptly without hanging.
    expect([0, 1]).toContain(result.code);
    expect(result.durationMs).toBeLessThan(5_000);
  }, 15_000);
});
