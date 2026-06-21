// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpResourceSource, McpToolSource } from "../../src/sources/mcp.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mcp-server.mjs");
const SPAWN = { command: process.execPath, args: [FIXTURE] };

describe("McpResourceSource", () => {
  it("lists resources from the child MCP server", async () => {
    const src = new McpResourceSource({ type: "mcp", name: "test-rsrc", ...SPAWN });
    const items = await src.list();
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.name).sort()).toEqual(["doc:policies", "doc:runbook"]);
    expect(items.every((i) => i.source === "test-rsrc")).toBe(true);
  });

  it("filters resources by a case-insensitive query", async () => {
    const src = new McpResourceSource({ type: "mcp", name: "test-rsrc", ...SPAWN });
    const items = await src.list("policies");
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("doc:policies");
  });

  it("reads a resource and returns its text content", async () => {
    const src = new McpResourceSource({ type: "mcp", name: "test-rsrc", ...SPAWN });
    const item = await src.get("doc:policies");
    expect(item.content).toContain("doc:policies");
    expect(item.content_type).toBe("text/markdown");
  });
});

describe("McpToolSource", () => {
  it("lists tools from the child MCP server", async () => {
    const src = new McpToolSource({ type: "mcp", name: "test-tools", ...SPAWN });
    const tools = await src.list();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["greet", "ping"]);
    expect(tools[0].source).toBe("test-tools");
  });

  it("filters tools by a case-insensitive query", async () => {
    const src = new McpToolSource({ type: "mcp", name: "test-tools", ...SPAWN });
    const tools = await src.list("PING");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("ping");
  });

  it("describe returns the tool's input_schema", async () => {
    const src = new McpToolSource({ type: "mcp", name: "test-tools", ...SPAWN });
    const entry = await src.describe("greet");
    expect(entry.name).toBe("greet");
    expect(entry.input_schema).toMatchObject({ type: "object" });
  });

  it("describe throws on a non-existent tool", async () => {
    const src = new McpToolSource({ type: "mcp", name: "test-tools", ...SPAWN });
    await expect(src.describe("nope")).rejects.toThrow(/tool not found: nope/);
  });

  it("invoke returns the tool's text output on success", async () => {
    const src = new McpToolSource({ type: "mcp", name: "test-tools", ...SPAWN });
    const result = await src.invoke("greet", { name: "alice" });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("hello alice");
  });

  it("invoke returns ok=false when the server flags an error", async () => {
    const src = new McpToolSource({ type: "mcp", name: "test-tools", ...SPAWN });
    const result = await src.invoke("nonexistent", {});
    expect(result.ok).toBe(false);
    expect(result.stdout).toMatch(/unknown tool/);
  });

  it("caches list results across calls (no redundant subprocess calls)", async () => {
    const src = new McpToolSource({ type: "mcp", name: "test-tools", cache_ttl_ms: 10_000, ...SPAWN });
    const first = await src.list();
    const second = await src.list();
    expect(second).toEqual(first);
    expect(second).toHaveLength(2);
  });

  it("McpResourceSource also caches list results", async () => {
    const src = new McpResourceSource({ type: "mcp", name: "test-rsrc", cache_ttl_ms: 10_000, ...SPAWN });
    const first = await src.list();
    const second = await src.list();
    expect(second).toEqual(first);
    expect(second).toHaveLength(2);
  });
});
