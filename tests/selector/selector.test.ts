// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import type { LoadedCollection } from "../../src/config.js";
import type { Item, Source } from "../../src/sources/types.js";
import { FileSource } from "../../src/sources/file.js";
import { GuidanceSelector, MAX_CHOICE_CANDIDATES, extractSummary, type SelectorCollectionSettings } from "../../src/selector/index.js";
import type { Answer, Question } from "../../src/selector/typesafe.js";
import { _resetMetrics, renderMetrics } from "../../src/metrics.js";

const EXAMPLES = resolve(__dirname, "../../examples");

function stubSource(id: string, items: Item[], opts: { failList?: boolean } = {}): Source & { gets: string[] } {
  const gets: string[] = [];
  return {
    id,
    gets,
    async list() {
      if (opts.failList) throw new Error(`${id} down`);
      return items.map(({ content, ...rest }) => rest);
    },
    async get(name: string) {
      gets.push(name);
      const found = items.find((i) => i.name === name);
      if (!found) throw new Error(`not found: ${name}`);
      return { ...found };
    },
  };
}

function col(name: string, sources: Source[], description?: string): LoadedCollection {
  return { name, description, usageOn: "every", sources };
}

function settings(collection: LoadedCollection, mode: "pick_one" | "pick_all", extra: Partial<SelectorCollectionSettings> = {}): SelectorCollectionSettings {
  return { collection, mode, minConfidence: 0.6, threshold: 0.5, topK: 3, ...extra };
}

type AskFn = (state: unknown, questions: Record<string, Question>) => Promise<{ model: string; answers: Record<string, Answer> }>;

const roads = col(
  "paved_road_tool",
  [
    stubSource("roads", [
      { name: "k8s-workloads.md", source: "roads", content_type: "text/markdown", content: "# Paved Road: Kubernetes Workloads\n\nUse the acme-workload Helm chart.\n\nMore." },
      { name: "terraform-modules.md", source: "roads", content_type: "text/markdown", content: "# Terraform Modules\n\nUse acme modules for S3 and RDS." },
    ]),
  ],
  "Approved templates",
);

const policySource = stubSource("pol", [
  { name: "tagging.md", source: "pol", content_type: "text/markdown", content: "# Tagging\n\nEvery resource needs owner and data_class tags." },
  { name: "tagging.rego", source: "pol", content_type: "application/rego", content: "package tagging\n" },
  { name: "network-exposure.md", source: "pol", content_type: "text/markdown", content: "# Network exposure\n\nNo public ingress without WAF." },
  { name: "logging.md", source: "pol", description: "Audit logging requirements", content_type: "text/markdown", content: "# Logging" },
]);
const policies = col("policy_tool", [policySource]);

beforeEach(() => {
  _resetMetrics();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

function choiceAnswer(choice: string, probabilities: Record<string, number>, confidence: number): Answer {
  return { type: "choice", choice, probabilities, confidence };
}

describe("GuidanceSelector — request shape", () => {
  it("sends one batched request: a choice for pick_one and a noul per candidate for pick_all", async () => {
    const ask = vi.fn<AskFn>(async () => ({ model: "jev-1.13.0", answers: {} }));
    const sel = new GuidanceSelector({ client: { ask }, collections: [settings(roads, "pick_one"), settings(policies, "pick_all")], includeContent: false });

    await sel.select({ task: "deploy a service to EKS", context: { repo: "billing" } });

    expect(ask).toHaveBeenCalledTimes(1);
    const [state, questions] = ask.mock.calls[0];
    expect(state).toEqual({ task: "deploy a service to EKS", context: { repo: "billing" } });

    const choice = questions.paved_road_tool;
    expect(choice.type).toBe("choice");
    expect(Object.keys((choice as { criteria: object }).criteria)).toEqual(["k8s-workloads", "terraform-modules", "none_of_these"]);
    expect((choice as { criteria: Record<string, string> }).criteria["k8s-workloads"]).toBe(
      "Paved Road: Kubernetes Workloads: Use the acme-workload Helm chart.",
    );

    const noulKeys = Object.keys(questions).filter((k) => k.startsWith("policy_tool#"));
    // tagging.md + tagging.rego collapse into one candidate
    expect(noulKeys).toHaveLength(3);
    expect(noulKeys.every((k) => questions[k].type === "noul")).toBe(true);
  });

  it("prefers an item's own description over fetching content", async () => {
    const ask = vi.fn<AskFn>(async () => ({ model: "m", answers: {} }));
    const sel = new GuidanceSelector({ client: { ask }, collections: [settings(policies, "pick_all")], includeContent: false });
    policySource.gets.length = 0;
    await sel.select({ task: "x" });
    expect(policySource.gets).not.toContain("logging.md");
    const logging = Object.values(ask.mock.calls[0][1]).find(
      (q) => (q.instructions as { item: { name: string } }).item.name === "logging",
    );
    expect((logging!.instructions as { item: { summary: string } }).item.summary).toBe("Audit logging requirements");
  });

  it("caches summaries between calls", async () => {
    const source = stubSource("s", [{ name: "a.md", source: "s", content_type: "text/markdown", content: "# A\n\nbody" }]);
    const ask = vi.fn<AskFn>(async () => ({ model: "m", answers: {} }));
    const sel = new GuidanceSelector({ client: { ask }, collections: [settings(col("c", [source]), "pick_all")], includeContent: false });
    await sel.select({ task: "x" });
    await sel.select({ task: "y" });
    expect(source.gets).toEqual(["a.md"]);
  });
});

describe("GuidanceSelector — pick_one", () => {
  const probs = { "k8s-workloads": 0.88, "terraform-modules": 0.09, none_of_these: 0.03 };

  it("returns the highest-probability item when confident", async () => {
    const ask = vi.fn<AskFn>(async () => ({ model: "jev", answers: { paved_road_tool: choiceAnswer("k8s-workloads", probs, 0.81) } }));
    const sel = new GuidanceSelector({ client: { ask }, collections: [settings(roads, "pick_one")], includeContent: false });

    const out = await sel.select({ task: "deploy to EKS" });

    expect(out.model).toBe("jev");
    expect(out.results.paved_road_tool).toMatchObject({
      mode: "pick_one",
      reason: "confident",
      confidence: 0.81,
      pick: { name: "k8s-workloads", items: ["k8s-workloads.md"] },
    });
    expect((out.results.paved_road_tool as { ranked: unknown[] }).ranked[0]).toEqual({ name: "k8s-workloads", items: ["k8s-workloads.md"], p: 0.88 });
    expect(out.next).toEqual(["paved_road_tool(action=get, name=k8s-workloads.md)"]);
  });

  it("withholds the pick below min_confidence and returns ranked candidates", async () => {
    const ask = vi.fn<AskFn>(async () => ({ model: "jev", answers: { paved_road_tool: choiceAnswer("k8s-workloads", probs, 0.4) } }));
    const sel = new GuidanceSelector({ client: { ask }, collections: [settings(roads, "pick_one", { topK: 2 })], includeContent: false });

    const r = (await sel.select({ task: "?" })).results.paved_road_tool as { pick: unknown; reason: string; ranked: unknown[] };
    expect(r.pick).toBeNull();
    expect(r.reason).toBe("low_confidence");
    expect(r.ranked).toHaveLength(2);
  });

  it("reports none_applies when the none option wins", async () => {
    const ask = vi.fn<AskFn>(async () => ({
      model: "jev",
      answers: { paved_road_tool: choiceAnswer("none_of_these", { none_of_these: 0.9, "k8s-workloads": 0.1 }, 0.9) },
    }));
    const sel = new GuidanceSelector({ client: { ask }, collections: [settings(roads, "pick_one")], includeContent: false });
    const out = await sel.select({ task: "fix a typo in the README" });
    expect(out.results.paved_road_tool).toMatchObject({ pick: null, reason: "none_applies" });
    expect(out.next).toEqual([]);
  });

  it("inlines content when include_content is on", async () => {
    const ask = vi.fn<AskFn>(async () => ({ model: "jev", answers: { paved_road_tool: choiceAnswer("terraform-modules", probs, 0.9) } }));
    const sel = new GuidanceSelector({ client: { ask }, collections: [settings(roads, "pick_one")], includeContent: true });
    const r = (await sel.select({ task: "s3" })).results.paved_road_tool as { pick: { content: string } };
    expect(r.pick.content).toContain("# Terraform Modules");
  });

  it("refuses collections over the choice option limit without calling the API", async () => {
    const many = Array.from({ length: MAX_CHOICE_CANDIDATES + 1 }, (_, i) => ({ name: `r${i}.md`, source: "big", description: `road ${i}` }));
    const ask = vi.fn<AskFn>();
    const sel = new GuidanceSelector({ client: { ask }, collections: [settings(col("big", [stubSource("big", many)]), "pick_one")], includeContent: false });
    const out = await sel.select({ task: "x" });
    expect(out.results.big).toMatchObject({ error: expect.stringContaining("option limit") });
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("GuidanceSelector — pick_all", () => {
  it("returns every policy at or above the threshold, sorted by probability", async () => {
    const ask = vi.fn<AskFn>(async (_state, questions) => {
      const answers: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(questions)) {
        const name = (q.instructions as { item: { name: string } }).item.name;
        answers[key] = { type: "noul", noul: { tagging: 0.91, "network-exposure": 0.64, logging: 0.2 }[name]! };
      }
      return { model: "jev", answers };
    });
    const sel = new GuidanceSelector({ client: { ask }, collections: [settings(policies, "pick_all")], includeContent: false });

    const out = await sel.select({ task: "add a public S3 bucket" });
    const r = out.results.policy_tool as { applies: Array<{ name: string; items: string[]; p: number }>; considered: number };
    expect(r.applies.map((a) => [a.name, a.p])).toEqual([
      ["tagging", 0.91],
      ["network-exposure", 0.64],
    ]);
    expect(r.applies[0].items).toEqual(["tagging.md", "tagging.rego"]);
    expect(r.considered).toBe(3);
    expect(out.next).toEqual(["policy_tool(action=get, name=tagging.md)", "policy_tool(action=get, name=network-exposure.md)"]);
  });
});

describe("GuidanceSelector — failure handling", () => {
  it("fails open with a fallback per collection when the API errors", async () => {
    const ask = vi.fn<AskFn>(async () => {
      throw new Error("typesafe: HTTP 529");
    });
    const sel = new GuidanceSelector({ client: { ask }, collections: [settings(roads, "pick_one"), settings(policies, "pick_all")], includeContent: false });

    const out = await sel.select({ task: "x" });
    expect(out.results.paved_road_tool).toEqual({
      error: "typesafe: HTTP 529",
      fallback: "call paved_road_tool(action=list) and choose relevant items manually",
    });
    expect(out.results.policy_tool).toMatchObject({ error: "typesafe: HTTP 529" });
    expect(out.next).toHaveLength(2);
    expect(await renderMetrics()).toMatch(/security_mcp_selector_requests_total\{outcome="error"\} 1/);
  });

  it("reports a collection whose sources all fail, and still answers the others", async () => {
    const down = col("down", [stubSource("d", [], { failList: true })]);
    const ask = vi.fn<AskFn>(async () => ({
      model: "jev",
      answers: { paved_road_tool: choiceAnswer("k8s-workloads", { "k8s-workloads": 1 }, 1) },
    }));
    const sel = new GuidanceSelector({ client: { ask }, collections: [settings(roads, "pick_one"), settings(down, "pick_all")], includeContent: false });

    const out = await sel.select({ task: "x" });
    expect(out.results.down).toMatchObject({ error: expect.stringContaining("d down") });
    expect(out.results.paved_road_tool).toMatchObject({ reason: "confident" });
    expect(await renderMetrics()).toMatch(/security_mcp_selector_requests_total\{outcome="partial"\} 1/);
  });

  it("skips collections the principal cannot access, and errors if none remain", async () => {
    const ask = vi.fn<AskFn>(async () => ({ model: "jev", answers: {} }));
    const sel = new GuidanceSelector({ client: { ask }, collections: [settings(roads, "pick_one"), settings(policies, "pick_all")], includeContent: false });

    await sel.select({ task: "x" }, (c) => c === "policy_tool");
    expect(Object.keys(ask.mock.calls[0][1]).some((k) => k === "paved_road_tool")).toBe(false);

    await expect(sel.select({ task: "x" }, () => false)).rejects.toThrow(/no selector collections are accessible/);
  });
});

describe("catalog over the bundled examples", () => {
  it("merges tagging.md and tagging.rego and summarises from the markdown", async () => {
    const collection = col("policy_tool", [new FileSource({ type: "file", path: resolve(EXAMPLES, "policies"), name: "local" })]);
    const sel = new GuidanceSelector({ client: { ask: vi.fn() }, collections: [], includeContent: false });
    const { candidates } = await sel.buildCandidates(collection);

    const tagging = candidates.find((c) => c.key === "tagging");
    expect(tagging?.items.map((i) => i.name)).toEqual(["tagging.md", "tagging.rego"]);
    expect(tagging?.summary).toBeTruthy();
    expect(candidates.map((c) => c.key).sort()).toEqual(["network-exposure", "tagging"]);
  });
});

describe("extractSummary", () => {
  it("takes the first heading and paragraph of markdown, skipping code fences", () => {
    expect(extractSummary("# Title\n\n```yaml\na: 1\n```\n\nFirst line\nsecond line\n\nNext para", "text/markdown")).toBe(
      "Title: First line second line",
    );
  });

  it("uses the leading comment block for code files", () => {
    expect(extractSummary("# Require owner tags\n# on every resource\npackage tagging\n", "application/rego")).toBe(
      "Require owner tags on every resource",
    );
  });

  it("truncates long summaries", () => {
    const s = extractSummary(`# T\n\n${"word ".repeat(200)}`, "text/markdown")!;
    expect(s.length).toBe(300);
    expect(s.endsWith("…")).toBe(true);
  });
});
