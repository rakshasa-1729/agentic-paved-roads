// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { LoadedToolsCategory } from "../../src/config.js";
import { InlineToolSource } from "../../src/sources/command.js";
import type { ToolEntry, ToolInvokeResult, ToolSource } from "../../src/sources/types.js";
import { handleToolRegistry } from "../../src/tools/tool_registry.js";

/**
 * Direct unit tests for the tool_registry handler. Covers the compact
 * `list` response (context-frugal default), `verbose` opt-in, the
 * describe/invoke fan-out across registry + MCP sources, and the
 * error-vs-skipped-source distinction on invoke.
 */

function inlineReg(tools: Parameters<typeof InlineToolSource>[0]): InlineToolSource {
  return new InlineToolSource(tools);
}

function stubToolSource(
  id: string,
  opts: { tools?: ToolEntry[]; invokeResult?: ToolInvokeResult; invokeError?: string },
): ToolSource {
  const tools: ToolEntry[] = opts.tools ?? [];
  return {
    id,
    async list(): Promise<ToolEntry[]> {
      return tools.map((t) => ({ ...t }));
    },
    async describe(name: string): Promise<ToolEntry> {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`${id}: tool not found: ${name}`);
      return { ...t };
    },
    async invoke(name: string): Promise<ToolInvokeResult> {
      if (!tools.some((t) => t.name === name)) throw new Error(`${id}: tool not found: ${name}`);
      if (opts.invokeError) throw new Error(opts.invokeError);
      return opts.invokeResult ?? { ok: true, stdout: "ok" };
    },
  };
}

function cat(registry: InlineToolSource, mcp: ToolSource[] = []): LoadedToolsCategory {
  return { registry, mcpSources: mcp };
}

describe("handleToolRegistry — list", () => {
  it("returns a compact shape by default (no input_schema/metadata)", async () => {
    const reg = inlineReg([
      {
        type: "command",
        name: "conftest",
        description: "Run OPA policy checks.",
        command: "conftest",
        args: ["test"],
        input_schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
      },
    ]);
    const res = (await handleToolRegistry(cat(reg), { action: "list" })) as { tools: ToolEntry[]; count: number };
    expect(res.count).toBe(1);
    const t = res.tools[0];
    expect(t.name).toBe("conftest");
    expect(t.source).toBe("inline");
    expect(t.description).toBe("Run OPA policy checks.");
    expect("input_schema" in t).toBe(false);
    expect("metadata" in t).toBe(false);
  });

  it("verbose=true keeps input_schema and metadata", async () => {
    const reg = inlineReg([
      {
        type: "http",
        name: "exception_tool",
        description: "Request a policy exception.",
        url: "https://example.example/v1/exceptions",
        input_schema: { type: "object", required: ["repo"] },
      },
    ]);
    const res = (await handleToolRegistry(cat(reg), { action: "list", verbose: true })) as { tools: ToolEntry[] };
    const t = res.tools[0];
    expect(t.input_schema).toEqual({ type: "object", required: ["repo"] });
    expect(t.metadata).toEqual({ type: "http" });
  });

  it("query filters by name and description (substring, case-insensitive)", async () => {
    const reg = inlineReg([
      { type: "command", name: "conftest", command: "x", description: "OPA checks" },
      { type: "command", name: "terraform", command: "x", description: "infra" },
    ]);
    const res = (await handleToolRegistry(cat(reg), { action: "list", query: "OPA" })) as { tools: ToolEntry[] };
    expect(res.tools.map((t) => t.name)).toEqual(["conftest"]);
  });

  it("merges registry + MCP sources and surfaces a failing source as __error__", async () => {
    const reg = inlineReg([{ type: "command", name: "conftest", command: "x" }]);
    const mcp: ToolSource = {
      id: "remote-mcp",
      async list(): Promise<ToolEntry[]> {
        throw new Error("connection refused");
      },
      async describe(): Promise<ToolEntry> {
        throw new Error("unreachable");
      },
      async invoke(): Promise<ToolInvokeResult> {
        throw new Error("unreachable");
      },
    };
    const res = (await handleToolRegistry(cat(reg, [mcp]), { action: "list" })) as { tools: ToolEntry[] };
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("conftest");
    expect(names).toContain("__error__:remote-mcp");
    expect(res.tools.find((t) => t.name === "__error__:remote-mcp")?.description).toBe("connection refused");
  });
});

describe("handleToolRegistry — describe", () => {
  it("returns the full entry (with input_schema) from the registry", async () => {
    const reg = inlineReg([
      { type: "command", name: "conftest", command: "c", input_schema: { type: "object" } },
    ]);
    const res = (await handleToolRegistry(cat(reg), { action: "describe", name: "conftest" })) as ToolEntry;
    expect(res.input_schema).toEqual({ type: "object" });
    expect(res.source).toBe("inline");
  });

  it("falls through to an MCP source if the registry doesn't have it", async () => {
    const reg = inlineReg([]);
    const mcp = stubToolSource("remote", {
      tools: [{ name: "external", source: "remote", description: "remote tool", input_schema: { type: "object" } }],
    });
    const res = (await handleToolRegistry(cat(reg, [mcp]), { action: "describe", name: "external" })) as ToolEntry;
    expect(res.source).toBe("remote");
    expect(res.input_schema).toEqual({ type: "object" });
  });

  it("requires 'name'", async () => {
    const reg = inlineReg([]);
    await expect(handleToolRegistry(cat(reg), { action: "describe" } as never)).rejects.toThrow(/requires 'name'/);
  });

  it("throws tool not found when no source has it", async () => {
    const reg = inlineReg([]);
    await expect(handleToolRegistry(cat(reg), { action: "describe", name: "ghost" })).rejects.toThrow(/tool not found: ghost/);
  });
});

describe("handleToolRegistry — invoke", () => {
  it("invokes the tool and returns its result", async () => {
    const reg = inlineReg([]);
    const mcp = stubToolSource("remote", {
      tools: [{ name: "external", source: "remote" }],
      invokeResult: { ok: true, stdout: "ran", exit_code: 0 },
    });
    const res = (await handleToolRegistry(cat(reg, [mcp]), { action: "invoke", name: "external", input: { a: 1 } }));
    expect(res).toEqual({ ok: true, stdout: "ran", exit_code: 0 });
  });

  it("skips sources that don't know the tool and surfaces the last invoke error", async () => {
    const reg = inlineReg([]);
    const mcpA = stubToolSource("a", {
      tools: [], // doesn't know the tool → list empty → skip silently
    });
    const mcpB = stubToolSource("b", {
      tools: [{ name: "thing", source: "b" }],
      invokeError: "boom from b",
    });
    await expect(
      handleToolRegistry(cat(reg, [mcpA, mcpB]), { action: "invoke", name: "thing", input: {} }),
    ).rejects.toThrow(/boom from b/);
  });

  it("throws tool not found when no source knows the name", async () => {
    const reg = inlineReg([]);
    await expect(
      handleToolRegistry(cat(reg), { action: "invoke", name: "ghost", input: {} }),
    ).rejects.toThrow(/tool not found: ghost/);
  });
});
