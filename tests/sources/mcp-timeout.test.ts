// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { McpResourceSource } from "../../src/sources/mcp.js";

// A stub MCP child that consumes stdin but never replies. The source
// must surface a timeout rather than hanging on `initialize`.
//
// `node -e '...'` keeps stdin readable without writing anything, so
// the SDK's `initialize` request never gets a response. Plain shell
// utilities like `cat` echo stdin → stdout, which the SDK then parses
// as a malformed JSON-RPC reply (-32601), masking the timeout we want
// to test.
const HANG_CHILD = {
  command: process.execPath,
  args: ["-e", "process.stdin.on('data',()=>{});process.stdin.resume();"],
};

describe("McpResourceSource connect timeout", () => {
  it("aborts when the child never replies to initialize", async () => {
    const src = new McpResourceSource({
      type: "mcp",
      name: "stub-mcp",
      command: HANG_CHILD.command,
      args: HANG_CHILD.args,
      connect_timeout_ms: 200,
    });

    const start = Date.now();
    await expect(src.list()).rejects.toThrow(/stub-mcp mcp connect: timed out after 200ms/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("a second call after timeout starts a fresh connect (does not return cached error)", async () => {
    const src = new McpResourceSource({
      type: "mcp",
      name: "stub-mcp-retry",
      command: HANG_CHILD.command,
      args: HANG_CHILD.args,
      connect_timeout_ms: 200,
    });

    await expect(src.list()).rejects.toThrow(/timed out after 200ms/);
    const start = Date.now();
    await expect(src.list()).rejects.toThrow(/timed out after 200ms/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });
});
