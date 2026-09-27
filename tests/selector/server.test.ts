// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../../src/config.js";
import { buildServer } from "../../src/server.js";

const EXAMPLES = resolve(__dirname, "../../examples");

const COLLECTIONS = `
collections:
  - name: policy_tool
    sources:
      - type: file
        name: local-policies
        path: ${resolve(EXAMPLES, "policies")}
  - name: paved_road_tool
    sources:
      - type: file
        name: local-roads
        path: ${resolve(EXAMPLES, "paved-roads")}
`;

const SELECTOR = `
selector:
  api_key: "\${TEST_TYPESAFE_KEY}"
  collections:
    - name: paved_road_tool
      mode: pick_one
    - name: policy_tool
      mode: pick_all
      threshold: 0.5
`;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "selector-server-"));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.env.TEST_TYPESAFE_KEY = "sk-test";
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.TEST_TYPESAFE_KEY;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function writeConfig(content: string): string {
  const path = join(tmp, "c.yaml");
  writeFileSync(path, content, "utf8");
  return path;
}

async function connect(yaml: string): Promise<Client> {
  const cfg = await loadConfig(writeConfig(yaml));
  const server = buildServer(cfg);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(clientT);
  return client;
}

/** Answers every question: the choice picks k8s-workloads, nouls say yes only for tagging. */
function stubJev(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const { questions } = JSON.parse(init.body as string) as { questions: Record<string, { type: string; instructions: { item?: { name: string } } }> };
    const answers: Record<string, unknown> = {};
    for (const [key, q] of Object.entries(questions)) {
      answers[key] =
        q.type === "choice"
          ? { type: "choice", choice: "k8s-workloads", probabilities: { "k8s-workloads": 0.9, "terraform-modules": 0.08, none_of_these: 0.02 }, confidence: 0.85 }
          : { type: "noul", noul: q.instructions.item?.name === "tagging" ? 0.93 : 0.1 };
    }
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function parse(res: unknown): Record<string, unknown> {
  const content = (res as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe("selector config", () => {
  it("leaves the selector unset when not configured", async () => {
    const cfg = await loadConfig(writeConfig(COLLECTIONS));
    expect(cfg.selector).toBeUndefined();
  });

  it("builds a selector and resolves the api key from the environment", async () => {
    const cfg = await loadConfig(writeConfig(COLLECTIONS + SELECTOR));
    expect(cfg.selector?.collectionNames).toEqual(["paved_road_tool", "policy_tool"]);
    expect(cfg.selector?.info).toEqual({ model: "jev-latest", apiKeyConfigured: true });
  });

  it("reports an unresolved api key", async () => {
    delete process.env.TEST_TYPESAFE_KEY;
    const cfg = await loadConfig(writeConfig(COLLECTIONS + SELECTOR));
    expect(cfg.selector?.info?.apiKeyConfigured).toBe(false);
  });

  it("rejects unknown and duplicate collections", async () => {
    await expect(
      loadConfig(writeConfig(`${COLLECTIONS}\nselector:\n  collections:\n    - { name: nope, mode: pick_one }\n`)),
    ).rejects.toThrow(/unknown collection: nope/);
    await expect(
      loadConfig(
        writeConfig(`${COLLECTIONS}\nselector:\n  collections:\n    - { name: policy_tool, mode: pick_all }\n    - { name: policy_tool, mode: pick_one }\n`),
      ),
    ).rejects.toThrow(/twice: policy_tool/);
  });

  it("rejects an empty collections list and out-of-range thresholds", async () => {
    await expect(loadConfig(writeConfig(`${COLLECTIONS}\nselector:\n  collections: []\n`))).rejects.toThrow();
    await expect(
      loadConfig(writeConfig(`${COLLECTIONS}\nselector:\n  collections:\n    - { name: policy_tool, mode: pick_all, threshold: 1.5 }\n`)),
    ).rejects.toThrow();
  });

  it("reserves select_guidance as a collection name", async () => {
    await expect(loadConfig(writeConfig("collections:\n  - name: select_guidance\n"))).rejects.toThrow(/reserved/);
  });
});

describe("select_guidance over MCP", () => {
  it("is not registered without a selector", async () => {
    const client = await connect(COLLECTIONS);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("select_guidance");
  });

  it("is registered and returns picks from a single Jev call", async () => {
    const fetchMock = stubJev();
    const client = await connect(COLLECTIONS + SELECTOR);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("select_guidance");

    const res = await client.callTool({ name: "select_guidance", arguments: { task: "deploy the billing service to EKS" } });
    expect(res.isError).toBeFalsy();
    const out = parse(res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.results).toMatchObject({
      paved_road_tool: { pick: { name: "k8s-workloads", items: ["k8s-workloads.md"] }, reason: "confident" },
      policy_tool: { applies: [{ name: "tagging", items: ["tagging.md", "tagging.rego"], p: 0.93 }] },
    });
  });

  it("rejects bad input as a tool error", async () => {
    stubJev();
    const client = await connect(COLLECTIONS + SELECTOR);
    const res = await client.callTool({ name: "select_guidance", arguments: { task: "" } });
    expect(res.isError).toBe(true);
  });

  it("falls back instead of erroring when Jev is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const client = await connect(COLLECTIONS + SELECTOR);
    const res = await client.callTool({ name: "select_guidance", arguments: { task: "x" } });
    expect(res.isError).toBeFalsy();
    expect(parse(res).results).toMatchObject({
      paved_road_tool: { error: expect.stringContaining("HTTP 401"), fallback: expect.stringContaining("action=list") },
    });
  });

  it("is not blocked by collection RBAC and only covers collections the caller may read", async () => {
    const fetchMock = stubJev();
    const rbac = `
rbac:
  default_allow: true
  collections:
    default_allow: false
    rules:
      "": [policy_tool]
`;
    const client = await connect(COLLECTIONS + SELECTOR + rbac);
    const out = parse(await client.callTool({ name: "select_guidance", arguments: { task: "x" } }));
    expect(Object.keys(out.results as object)).toEqual(["policy_tool"]);
    const sent = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as { questions: object };
    expect(Object.keys(sent.questions).some((k) => k.startsWith("paved_road_tool"))).toBe(false);
  });
});
