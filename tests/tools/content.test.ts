// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { LoadedCollection } from "../../src/config.js";
import type { Item, Source } from "../../src/sources/types.js";
import { handleContent } from "../../src/tools/content.js";

/**
 * Direct unit tests for the content handler — the layer that turns
 * Source.list/get into agent-facing JSON. Covers the context-frugal
 * knobs (limit / fields / dedup / section / max_bytes), the usage
 * directive opt-out, multi-source get fallback, and the error-as-item
 * resiliency pattern for `list`.
 */

interface StubSourceConfig {
  id: string;
  items?: Item[];
  /** Names this source should report as findable via get(). */
  gettable?: string[];
  getFallback?: string[];
  /** Throw from list() to exercise the error-as-item path. */
  failList?: boolean;
}

function stubSource(cfg: StubSourceConfig): Source {
  const items: Item[] =
    cfg.items ??
      [
        { name: "d1.md", source: cfg.id, title: "D1", description: "first doc", content_type: "text/markdown", content: "# D1\nbody of d1" },
        { name: "d2.md", source: cfg.id, title: "D2", content_type: "text/markdown", content: "# D2\nbody of d2" },
      ];
  return {
    id: cfg.id,
    async list(query?: string): Promise<Item[]> {
      if (cfg.failList) throw new Error(`${cfg.id} boom`);
      if (!query) return items.map((i) => ({ ...i }));
      const q = query.toLowerCase();
      return items
        .filter((i) => i.name.toLowerCase().includes(q) || (i.title ?? "").toLowerCase().includes(q))
        .map((i) => ({ ...i }));
    },
    async get(name: string): Promise<Item> {
      // Simulate each source only serving a subset of names — used to
      // exercise the multi-source fallback ("try next source").
      const allow = cfg.gettable ?? items.map((i) => i.name);
      if (!allow.includes(name)) throw new Error(`not found in ${cfg.id}: ${name}`);
      const found = items.find((i) => i.name === name);
      if (!found) throw new Error(`not found in ${cfg.id}: ${name}`);
      return { ...found };
    },
  };
}

function collection(opts: Partial<LoadedCollection> & { sources: Source[] }): LoadedCollection {
  return {
    name: opts.name ?? "policy_tool",
    description: opts.description,
    usage: opts.usage,
    usageOn: opts.usageOn ?? "every",
    sources: opts.sources,
  };
}

describe("handleContent — list", () => {
  it("returns items without content and attaches the usage directive", async () => {
    const c = collection({ usage: "always run conftest", sources: [stubSource({ id: "s1" })] });
    const res = (await handleContent(c, { action: "list" })) as { items: Item[]; count: number; usage?: string };
    expect(res.usage).toBe("always run conftest");
    expect(res.count).toBe(2);
    expect(res.items.every((i) => !("content" in i))).toBe(true);
    expect(res.items.map((i) => i.name).sort()).toEqual(["d1.md", "d2.md"]);
  });

  it("dedups same-named items across sources by default and records the source ids", async () => {
    const c = collection({
      sources: [stubSource({ id: "src-a" }), stubSource({ id: "src-b" })],
    });
    const res = (await handleContent(c, { action: "list" })) as { items: Array<Item & { sources?: string[] }> };
    expect(res.items).toHaveLength(2);
    const d1 = res.items.find((i) => i.name === "d1.md")!;
    expect(d1.source).toBe("src-a");
    expect(d1.sources).toEqual(["src-a", "src-b"]);
  });

  it("dedup=false keeps both copies as independent list entries", async () => {
    const c = collection({ sources: [stubSource({ id: "a" }), stubSource({ id: "b" })] });
    const res = (await handleContent(c, { action: "list", dedup: false })) as { items: Array<Item & { sources?: string[] }> };
    expect(res.items).toHaveLength(4);
    expect(res.items.some((i) => i.sources !== undefined)).toBe(false);
  });

  it("fields selects only requested keys (drops metadata/uri/etc)", async () => {
    const c = collection({ sources: [stubSource({ id: "s1" })] });
    const res = (await handleContent(c, { action: "list", fields: ["name", "source"] })) as { items: Record<string, unknown>[] };
    expect(res.items).toHaveLength(2);
    for (const it of res.items) {
      expect(Object.keys(it).sort()).toEqual(["name", "source"]);
    }
  });

  it("limit caps the number of returned items", async () => {
    const many: Item[] = Array.from({ length: 50 }, (_, i) => ({
      name: `p${i}.md`,
      source: "s",
      content_type: "text/markdown",
      content: `body ${i}`,
    }));
    const c = collection({ sources: [stubSource({ id: "s", items: many })] });
    const res = (await handleContent(c, { action: "list", limit: 5 })) as { items: Item[]; count: number };
    expect(res.items).toHaveLength(5);
    expect(res.count).toBe(5);
  });

  it("surfaces a failing source as an __error__ item without failing the whole list", async () => {
    const c = collection({
      sources: [stubSource({ id: "good" }), stubSource({ id: "bad", failList: true })],
    });
    const res = (await handleContent(c, { action: "list" })) as { items: Item[] };
    const names = res.items.map((i) => i.name);
    expect(names).toContain("d1.md");
    expect(names).toContain("__error__:bad");
    const errItem = res.items.find((i) => i.name === "__error__:bad")!;
    expect(errItem.description).toBe("bad boom");
  });

  it("usage_on=never drops the directive even when usage is configured", async () => {
    const c = collection({ usage: "directive", usageOn: "never", sources: [stubSource({ id: "s1" })] });
    const res = (await handleContent(c, { action: "list" })) as { usage?: string };
    expect(res.usage).toBeUndefined();
  });
});

describe("handleContent — get", () => {
  it("returns the item with its content", async () => {
    const c = collection({ sources: [stubSource({ id: "s1" })] });
    const res = (await handleContent(c, { action: "get", name: "d1.md" })) as Item;
    expect(res.content).toBe("# D1\nbody of d1");
    expect(res.name).toBe("d1.md");
    expect(res.usage).toBeUndefined();
  });

  it("falls through to the next source that has the name", async () => {
    const c = collection({
      sources: [
        stubSource({ id: "only-d2", gettable: ["d2.md"], items: [
          { name: "d2.md", source: "only-d2", content_type: "text/markdown", content: "from d2 source" },
        ] }),
        stubSource({ id: "full" }),
      ],
    });
    const res = (await handleContent(c, { action: "get", name: "d1.md" })) as Item;
    expect(res.content).toBe("# D1\nbody of d1");
    expect(res.source).toBe("full");
  });

  it("throws a precise not-found message when no source has the name", async () => {
    const c = collection({ sources: [stubSource({ id: "s1" })] });
    await expect(handleContent(c, { action: "get", name: "missing.md" })).rejects.toThrow(
      /not found in any configured source: missing\.md/,
    );
  });

  it("max_bytes truncates content and flags the result", async () => {
    const long = "# H\n" + "x".repeat(500);
    const c = collection({
      sources: [stubSource({ id: "s", items: [{ name: "big.md", source: "s", content_type: "text/markdown", content: long }] })],
    });
    const res = (await handleContent(c, { action: "get", name: "big.md", max_bytes: 10 })) as Item & { truncated?: boolean; content_chars?: number };
    expect(res.truncated).toBe(true);
    expect(res.content_chars).toBe(long.length);
    expect(res.content!.length).toBeLessThan(long.length);
    expect(res.content).toContain("[truncated");
  });

  it("section returns only the body under the matched heading", async () => {
    const md = `# Top\nintro\n## Tagging\ntag body\n## Network\nnet body\n`;
    const c = collection({
      sources: [stubSource({ id: "s", items: [{ name: "policies.md", source: "s", content_type: "text/markdown", content: md }] })],
    });
    const res = (await handleContent(c, { action: "get", name: "policies.md", section: "tagging" })) as Item & { section?: string };
    expect(res.section).toBe("tagging");
    expect(res.content).toBe("## Tagging\ntag body");
  });

  it("section stops at the next same-or-higher heading", async () => {
    const md = `# A\na\n## B\nb\n### B1\nb1\n## C\nc\n`;
    const c = collection({
      sources: [stubSource({ id: "s", items: [{ name: "x.md", source: "s", content_type: "text/markdown", content: md }] })],
    });
    const res = (await handleContent(c, { action: "get", name: "x.md", section: "b" })) as Item;
    // Should start at "## B" and end before "## C", including ### B1 sub.
    expect(res.content).toBe("## B\nb\n### B1\nb1");
  });

  it("section not found throws a precise error (not swallowed as 'not found')", async () => {
    const c = collection({
      sources: [stubSource({ id: "s", items: [{ name: "x.md", source: "s", content_type: "text/markdown", content: "# Only\nbody" }] })],
    });
    await expect(handleContent(c, { action: "get", name: "x.md", section: "nope" })).rejects.toThrow(
      /section not found in 'x\.md': nope/,
    );
  });

  it("section on a non-markdown item returns full content with a note", async () => {
    const c = collection({
      sources: [stubSource({ id: "s", items: [{ name: "p.rego", source: "s", content_type: "application/rego", content: "package main\n" }] })],
    });
    const res = (await handleContent(c, { action: "get", name: "p.rego", section: "main" })) as Item & { note?: string };
    expect(res.note).toMatch(/not sectionable/);
    expect(res.content).toBe("package main\n");
  });

  it("combines section + max_bytes (section first, then truncate)", async () => {
    const md = `# T\n${"y".repeat(200)}\n## Big\n${"z".repeat(200)}\n`;
    const c = collection({
      sources: [stubSource({ id: "s", items: [{ name: "t.md", source: "s", content_type: "text/markdown", content: md }] })],
    });
    const res = (await handleContent(c, { action: "get", name: "t.md", section: "big", max_bytes: 10 })) as Item & { truncated?: boolean; section?: string };
    expect(res.section).toBe("big");
    expect(res.truncated).toBe(true);
    expect(res.content!.startsWith("## Big")).toBe(true);
  });
});

describe("handleContent — empty collection", () => {
  it("returns a helpful note when no sources are configured", async () => {
    const c = collection({ sources: [] });
    const res = (await handleContent(c, { action: "list" })) as { items: unknown[]; note: string };
    expect(res.items).toEqual([]);
    expect(res.note).toContain("no sources configured");
  });
});
