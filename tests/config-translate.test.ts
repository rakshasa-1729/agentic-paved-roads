// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { translateLegacyShape } from "../src/config.js";

// Each legacy top-level key maps to a fixed collection name; the
// translator's contract is that old configs keep working unchanged
// after Move 0.

describe("translateLegacyShape", () => {
  it("migrates legacy `policies` into a `policy_tool` collection", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = translateLegacyShape({
      policies: {
        description: "org policies",
        sources: [{ type: "file", path: "./policies" }],
      },
    }) as Record<string, unknown>;

    expect(out.policies).toBeUndefined();
    expect(out.collections).toEqual([
      {
        name: "policy_tool",
        description: "org policies",
        sources: [{ type: "file", path: "./policies" }],
      },
    ]);
  });

  it("migrates all three legacy keys in one pass", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = translateLegacyShape({
      policies: { sources: [] },
      risk: { sources: [] },
      paved_roads: { sources: [] },
    }) as Record<string, unknown>;

    expect(out.policies).toBeUndefined();
    expect(out.risk).toBeUndefined();
    expect(out.paved_roads).toBeUndefined();

    const names = (out.collections as Array<{ name: string }>).map((c) => c.name);
    expect(names).toEqual(["policy_tool", "risk_index", "paved_road_tool"]);
  });

  it("emits a structured deprecation warning when migrating", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    translateLegacyShape({ policies: { sources: [] } });
    expect(writeSpy).toHaveBeenCalledOnce();

    const line = String(writeSpy.mock.calls[0][0]).trim();
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record.level).toBe("warn");
    expect(record.event).toBe("config.legacy_shape_migrated");
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(String(record.message)).toContain("policies/risk/paved_roads");
  });

  it("does not warn when the config already uses the new shape", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    translateLegacyShape({
      collections: [{ name: "policy_tool", sources: [] }],
    });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("preserves new-shape configs untouched", () => {
    const input = {
      server: { name: "x" },
      collections: [{ name: "runbooks", sources: [] }],
      tools: { registry: [] },
    };
    const out = translateLegacyShape(input) as Record<string, unknown>;

    expect(out.server).toEqual({ name: "x" });
    expect(out.collections).toEqual([{ name: "runbooks", sources: [] }]);
    expect(out.tools).toEqual({ registry: [] });
  });

  it("does not duplicate when a legacy key and a same-named new collection both exist", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // The user wrote both `policies:` (legacy) and `collections: [{name: policy_tool}]`
    // (new). The new entry wins; the legacy one is dropped without overwriting.
    const out = translateLegacyShape({
      policies: { description: "OLD", sources: [] },
      collections: [{ name: "policy_tool", description: "NEW", sources: [] }],
    }) as Record<string, unknown>;

    expect(out.policies).toBeUndefined();
    const cols = out.collections as Array<{ name: string; description: string }>;
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ name: "policy_tool", description: "NEW" });
  });

  it("returns non-object input unchanged", () => {
    expect(translateLegacyShape(null)).toBeNull();
    expect(translateLegacyShape(undefined)).toBeUndefined();
    expect(translateLegacyShape("a string")).toBe("a string");
    expect(translateLegacyShape([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("ignores legacy keys that are not objects", () => {
    const out = translateLegacyShape({ policies: "garbage" }) as Record<string, unknown>;
    // 'garbage' isn't an object, so the translator leaves it alone — the
    // schema validator will reject it downstream.
    expect(out.policies).toBe("garbage");
    expect(out.collections).toBeUndefined();
  });

  it("treats a missing `sources` array as []", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = translateLegacyShape({
      policies: { description: "no sources field" },
    }) as Record<string, unknown>;

    const cols = out.collections as Array<{ sources: unknown[] }>;
    expect(cols[0].sources).toEqual([]);
  });
});
