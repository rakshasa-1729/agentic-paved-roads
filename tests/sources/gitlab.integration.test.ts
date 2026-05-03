// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { GitLabSource } from "../../src/sources/gitlab.js";

let server: Server;
let baseUrl: string;
const requests: Array<{ url: string | undefined; token: string | undefined; accept: string | undefined }> = [];

function handleTree(req: IncomingMessage, res: ServerResponse): boolean {
  if (!req.url?.includes("/repository/tree")) return false;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify([
      { id: "sha-tag", name: "tagging.md", type: "blob", path: "policies/tagging.md", mode: "100644" },
      { id: "sha-rego", name: "tagging.rego", type: "blob", path: "policies/tagging.rego", mode: "100644" },
      { id: "sha-net", name: "network.md", type: "blob", path: "policies/network.md", mode: "100644" },
      { id: "sha-readme", name: "README.md", type: "blob", path: "README.md", mode: "100644" },
      { id: "sha-tree", name: "policies", type: "tree", path: "policies", mode: "040000" },
    ]),
  );
  return true;
}

function handleRaw(req: IncomingMessage, res: ServerResponse): boolean {
  const m = req.url?.match(/\/repository\/files\/(.+?)\/raw\?/);
  if (!m) return false;
  const path = decodeURIComponent(m[1]);
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`raw content for ${path}`);
  return true;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({
      url: req.url,
      token: typeof req.headers["private-token"] === "string" ? req.headers["private-token"] : undefined,
      accept: typeof req.headers.accept === "string" ? req.headers.accept : undefined,
    });
    if (handleTree(req, res)) return;
    if (handleRaw(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(
  () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
);

describe("GitLabSource (integration)", () => {
  it("list() returns blobs under `path` matching `patterns`, prefix stripped", async () => {
    const src = new GitLabSource({
      type: "gitlab",
      name: "stub-gl",
      project: "group/repo",
      ref: "v1",
      path: "policies",
      patterns: ["**/*.md", "**/*.rego"],
      api_base_url: baseUrl,
      token: "t",
    });
    const items = await src.list();
    expect(items.map((i) => i.name).sort()).toEqual(["network.md", "tagging.md", "tagging.rego"]);
    expect(items[0].source).toBe("stub-gl");
  });

  it("forwards the PRIVATE-TOKEN header when configured", async () => {
    requests.length = 0;
    const src = new GitLabSource({
      type: "gitlab",
      name: "stub-gl",
      project: "group/repo",
      ref: "v1",
      api_base_url: baseUrl,
      token: "glpat-fake-123",
    });
    await src.list();
    const tree = requests.find((r) => r.url?.includes("/repository/tree"));
    expect(tree?.token).toBe("glpat-fake-123");
  });

  it("get() fetches raw content by exact path", async () => {
    const src = new GitLabSource({
      type: "gitlab",
      name: "stub-gl",
      project: "group/repo",
      ref: "v1",
      path: "policies",
      api_base_url: baseUrl,
      token: "t",
    });
    const item = await src.get("tagging.md");
    expect(item.content).toBe("raw content for policies/tagging.md");
  });

  it("get() falls back to suffix match when prefix omitted", async () => {
    const src = new GitLabSource({
      type: "gitlab",
      name: "stub-gl",
      project: "group/repo",
      ref: "v1",
      // no path: subpath empty; suffix-match path used
      api_base_url: baseUrl,
      token: "t",
    });
    const item = await src.get("tagging.md");
    expect(item.content).toContain("policies/tagging.md");
  });

  it("get() throws a clean error for a missing entry", async () => {
    const src = new GitLabSource({
      type: "gitlab",
      name: "stub-gl",
      project: "group/repo",
      ref: "v1",
      api_base_url: baseUrl,
      token: "t",
    });
    await expect(src.get("no-such.md")).rejects.toThrow(/stub-gl: not found: no-such\.md/);
  });

  it("URL-encodes group/subgroup project paths into the v4 endpoint", async () => {
    requests.length = 0;
    const src = new GitLabSource({
      type: "gitlab",
      name: "stub-gl",
      project: "group/sub/repo",
      ref: "v1",
      api_base_url: baseUrl,
      token: "t",
    });
    await src.list();
    const tree = requests.find((r) => r.url?.includes("/repository/tree"));
    expect(tree?.url).toContain("/projects/group%2Fsub%2Frepo/repository/tree");
  });

  it("caches the tree for 60s within a single source instance", async () => {
    requests.length = 0;
    const src = new GitLabSource({
      type: "gitlab",
      name: "cached",
      project: "group/repo",
      ref: "v1",
      api_base_url: baseUrl,
      token: "t",
    });
    await src.list();
    await src.list();
    const treeCalls = requests.filter((r) => r.url?.includes("/repository/tree"));
    expect(treeCalls).toHaveLength(1);
  });
});
