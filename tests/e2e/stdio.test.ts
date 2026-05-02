// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Spawn the built server as a real subprocess and drive it over the
// stdio JSON-RPC framing using the SDK's own client. This is the
// closest-to-production end-to-end check: any regression in the wiring
// (collection registration, tool dispatcher, content handler) shows up
// here.

const PROJECT_ROOT = resolve(__dirname, "../..");
const SERVER_ENTRY = resolve(PROJECT_ROOT, "dist/index.js");
const POLICIES_DIR = resolve(PROJECT_ROOT, "examples/policies");

const CONFIG = `
server:
  name: e2e-stdio
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
let configPath: string;
let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "security-mcp-e2e-stdio-"));
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, CONFIG);

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      ...(process.env as Record<string, string>),
      SECURITY_MCP_CONFIG: configPath,
      MCP_TRANSPORT: "stdio",
      // suppress the startup log line so it doesn't pollute test output
      LOG_LEVEL: "error",
    },
    stderr: "ignore",
  });
  client = new Client({ name: "e2e-stdio-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
}, 15_000);

afterAll(async () => {
  try {
    await client.close();
  } catch {
    // best effort
  }
  try {
    await transport.close();
  } catch {
    // best effort
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("stdio E2E", () => {
  it("tools/list returns the configured collection plus tool_registry", async () => {
    const res = await client.listTools();
    const names = (res.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["policy_tool", "tool_registry"]);
  });

  it("policy_tool list returns markdown policies from examples/", async () => {
    const res = await client.callTool({ name: "policy_tool", arguments: { action: "list" } });
    expect(res.isError).toBeFalsy();
    const text = ((res.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
    expect(text).toContain("tagging.md");
    expect(text).toContain("network-exposure.md");
  });

  it("policy_tool get returns the file body", async () => {
    const res = await client.callTool({
      name: "policy_tool",
      arguments: { action: "get", name: "tagging.md" },
    });
    expect(res.isError).toBeFalsy();
    const text = ((res.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
    // The example file should have *some* identifiable body content.
    expect(text.length).toBeGreaterThan(50);
  });

  it("an unknown tool name returns isError=true with a clear message", async () => {
    const res = await client.callTool({ name: "policy_tool", arguments: { action: "get", name: "no-such-file.md" } });
    expect(res.isError).toBe(true);
    const text = ((res.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
    expect(text).toMatch(/not found/i);
  });
});
