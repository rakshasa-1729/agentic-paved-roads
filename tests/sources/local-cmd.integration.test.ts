// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { LocalCmdSource } from "../../src/sources/local-cmd.js";

// Use real /bin commands shipped on every Linux + macOS runner. The
// CI matrix is ubuntu-latest only so this is safe.

describe("LocalCmdSource (integration)", () => {
  it("list() parses one item per stdout line by default", async () => {
    const src = new LocalCmdSource({
      type: "local-cmd",
      name: "stub-list",
      list_command: "printf",
      list_args: ["alpha\\nbeta\\ngamma\\n"],
      get_command: "echo",
    });
    const items = await src.list();
    expect(items.map((i) => i.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(items[0].source).toBe("stub-list");
  });

  it("list() filters by query (case-insensitive substring)", async () => {
    const src = new LocalCmdSource({
      type: "local-cmd",
      name: "stub-list",
      list_command: "printf",
      list_args: ["AlphaPolicy\\nBetaPolicy\\nGammaRule\\n"],
      get_command: "echo",
    });
    const items = await src.list("policy");
    expect(items.map((i) => i.name)).toEqual(["AlphaPolicy", "BetaPolicy"]);
  });

  it("list() with format=json parses a JSON array", async () => {
    const src = new LocalCmdSource({
      type: "local-cmd",
      name: "stub-json",
      list_command: "printf",
      list_args: ['%s', '["one","two","three"]'],
      format: "json",
      get_command: "echo",
    });
    const items = await src.list();
    expect(items.map((i) => i.name)).toEqual(["one", "two", "three"]);
  });

  it("get() substitutes {name} into args and returns stdout as content", async () => {
    const src = new LocalCmdSource({
      type: "local-cmd",
      name: "stub-get",
      list_command: "true",
      get_command: "echo",
      get_args: ["body-for", "{name}"],
    });
    const item = await src.get("foo.md");
    expect(item.content).toBe("body-for foo.md\n");
  });

  it("refuses unsafe names (shell metacharacters) without running the command", async () => {
    const src = new LocalCmdSource({
      type: "local-cmd",
      name: "stub-get",
      list_command: "true",
      get_command: "echo",
      get_args: ["{name}"],
    });
    await expect(src.get("foo;rm -rf /")).rejects.toThrow(/refusing to fetch unsafe name/);
    await expect(src.get("foo$(whoami)")).rejects.toThrow(/refusing to fetch unsafe name/);
    await expect(src.get("../escape")).resolves.toBeDefined(); // / and . are allowed
  });

  it("aborts a hung command at timeout_ms", async () => {
    const src = new LocalCmdSource({
      type: "local-cmd",
      name: "stub-hang",
      list_command: "sleep",
      list_args: ["30"],
      get_command: "true",
      timeout_ms: 100,
    });
    const start = Date.now();
    await expect(src.list()).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});
