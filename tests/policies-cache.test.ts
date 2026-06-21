// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializePolicies } from "../src/policies-cache.js";
import type { Item, Source } from "../src/sources/types.js";

function stubSource(id: string, items: Item[], opts?: { failList?: boolean }): Source {
  return {
    id,
    async list() {
      if (opts?.failList) throw new Error(`${id} boom`);
      return items.map((i) => ({ ...i }));
    },
    async get(name: string) {
      const found = items.find((i) => i.name === name);
      if (!found) throw new Error(`not found: ${name}`);
      return { ...found };
    },
  };
}

describe("materializePolicies", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "policies-cache-"));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes .rego files from all sources to the target dir", async () => {
    const sources = [
      stubSource("s1", [
        { name: "a.rego", source: "s1", content: "package main\nallow = true" },
        { name: "readme.md", source: "s1", content: "# readme" },
      ]),
      stubSource("s2", [
        { name: "b.rego", source: "s2", content: "package main\ndeny = true" },
      ]),
    ];
    const count = await materializePolicies(sources, tmp);
    expect(count).toBe(2);
    expect(readFileSync(join(tmp, "a.rego"), "utf8")).toBe("package main\nallow = true");
    expect(readFileSync(join(tmp, "b.rego"), "utf8")).toBe("package main\ndeny = true");
    expect(existsSync(join(tmp, "readme.md"))).toBe(false);
  });

  it("creates nested subdirectories for names with slashes", async () => {
    const sources = [stubSource("s1", [{ name: "sub/deep/inner.rego", source: "s1", content: "package sub" }])];
    const count = await materializePolicies(sources, tmp);
    expect(count).toBe(1);
    expect(readFileSync(join(tmp, "sub/deep/inner.rego"), "utf8")).toBe("package sub");
  });

  it("swallows list() errors and continues to the next source", async () => {
    const sources = [
      stubSource("bad", [{ name: "x.rego", source: "bad", content: "x" }], { failList: true }),
      stubSource("good", [{ name: "y.rego", source: "good", content: "y" }]),
    ];
    const count = await materializePolicies(sources, tmp);
    expect(count).toBe(1);
    expect(existsSync(join(tmp, "x.rego"))).toBe(false);
    expect(readFileSync(join(tmp, "y.rego"), "utf8")).toBe("y");
  });

  it("swallows get() errors for individual items", async () => {
    const items: Item[] = [
      { name: "ok.rego", source: "flaky", content: "ok" },
      { name: "bad.rego", source: "flaky", content: "bad" },
    ];
    const sources: Source[] = [
      {
        id: "flaky",
        async list() { return [...items]; },
        async get(name: string) {
          if (name === "bad.rego") throw new Error("get failed");
          return items.find((i) => i.name === name)!;
        },
      },
    ];
    const count = await materializePolicies(sources, tmp);
    expect(count).toBe(1);
    expect(readFileSync(join(tmp, "ok.rego"), "utf8")).toBe("ok");
    expect(existsSync(join(tmp, "bad.rego"))).toBe(false);
  });

  it("skips .rego items with empty content", async () => {
    const sources = [
      stubSource("s1", [
        { name: "empty.rego", source: "s1", content: "" },
        { name: "has.rego", source: "s1", content: "package main" },
      ]),
    ];
    const count = await materializePolicies(sources, tmp);
    expect(count).toBe(1);
    expect(existsSync(join(tmp, "empty.rego"))).toBe(false);
    expect(readFileSync(join(tmp, "has.rego"), "utf8")).toBe("package main");
  });

  it("returns 0 on zero sources", async () => {
    const count = await materializePolicies([], tmp);
    expect(count).toBe(0);
  });

  it("skips files whose extension is not exactly .rego (case-insensitive match)", async () => {
    const sources = [
      stubSource("s1", [
        { name: "config.yaml", source: "s1", content: "rules: []" },
        { name: "data.json", source: "s1", content: "{}" },
        { name: "lower.rego", source: "s1", content: "package lower" },
        { name: "UPPER.REGO", source: "s1", content: "package upper" },
        { name: "backup.rego.bak", source: "s1", content: "old" },
      ]),
    ];
    const count = await materializePolicies(sources, tmp);
    expect(count).toBe(2);
    expect(readFileSync(join(tmp, "lower.rego"), "utf8")).toBe("package lower");
    expect(readFileSync(join(tmp, "UPPER.REGO"), "utf8")).toBe("package upper");
    expect(existsSync(join(tmp, "config.yaml"))).toBe(false);
    expect(existsSync(join(tmp, "backup.rego.bak"))).toBe(false);
  });
});
