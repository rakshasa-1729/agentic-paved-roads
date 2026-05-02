// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { FileSource } from "../../src/sources/file.js";

const POLICIES = resolve(__dirname, "../../examples/policies");

describe("FileSource (integration)", () => {
  it("lists every file matching the configured patterns", async () => {
    const src = new FileSource({
      type: "file",
      name: "local-policies",
      path: POLICIES,
      patterns: ["**/*.md", "**/*.rego"],
    });
    const items = await src.list();
    const names = items.map((i) => i.name).sort();
    expect(names).toEqual(["network-exposure.md", "tagging.md", "tagging.rego"]);
    for (const item of items) {
      expect(item.source).toBe("local-policies");
      expect(item.uri).toMatch(/^file:\/\/.*examples\/policies\//);
      expect(item.title).toBeDefined();
    }
  });

  it("filters list() output by query (case-insensitive)", async () => {
    const src = new FileSource({
      type: "file",
      name: "local-policies",
      path: POLICIES,
      patterns: ["**/*.md", "**/*.rego"],
    });
    const items = await src.list("TAGGING");
    expect(items.map((i) => i.name).sort()).toEqual(["tagging.md", "tagging.rego"]);
  });

  it("get() returns full file content with the right metadata", async () => {
    const src = new FileSource({
      type: "file",
      name: "local-policies",
      path: POLICIES,
      patterns: ["**/*.md"],
    });
    const item = await src.get("tagging.md");
    expect(item.name).toBe("tagging.md");
    expect(item.source).toBe("local-policies");
    expect(item.content_type).toBe("text/markdown");
    expect(item.content).toBeDefined();
    expect(item.content!.length).toBeGreaterThan(0);
  });

  it("get() throws a clear error when the file is missing", async () => {
    const src = new FileSource({
      type: "file",
      name: "local-policies",
      path: POLICIES,
      patterns: ["**/*.md"],
    });
    await expect(src.get("does-not-exist.md")).rejects.toThrow(/not found in local-policies/);
  });

  it("respects the patterns filter (excludes unmatched extensions)", async () => {
    const src = new FileSource({
      type: "file",
      name: "md-only",
      path: POLICIES,
      patterns: ["**/*.md"],
    });
    const items = await src.list();
    expect(items.every((i) => i.name.endsWith(".md"))).toBe(true);
    expect(items.some((i) => i.name.endsWith(".rego"))).toBe(false);
  });
});
