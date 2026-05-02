// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { GitHubSource } from "../../src/sources/github.js";

// Stand up a localhost stub that mimics the two GitHub Contents/Trees
// API endpoints we hit. Lets us exercise list/get without real HTTP and
// without dragging in a mocking library.

let server: Server;
let baseUrl: string;
const requests: Array<{ url: string | undefined; auth: string | undefined; accept: string | undefined }> = [];

function handleTreesRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (!req.url?.includes("/git/trees/")) return false;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      tree: [
        { path: "policies/tagging.md", type: "blob", sha: "sha-tag" },
        { path: "policies/tagging.rego", type: "blob", sha: "sha-rego" },
        { path: "policies/network.md", type: "blob", sha: "sha-net" },
        { path: "README.md", type: "blob", sha: "sha-readme" },
        { path: "policies", type: "tree", sha: "sha-tree" },
      ],
      truncated: false,
    }),
  );
  return true;
}

function handleContentsRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (!req.url?.includes("/contents/")) return false;
  const m = req.url.match(/\/contents\/(.+?)\?/);
  const path = m ? decodeURIComponent(m[1]) : "unknown";
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`raw content for ${path}`);
  return true;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({
      url: req.url,
      auth: req.headers.authorization,
      accept: Array.isArray(req.headers.accept) ? req.headers.accept[0] : req.headers.accept,
    });
    if (handleTreesRequest(req, res)) return;
    if (handleContentsRequest(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(
  () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
);

describe("GitHubSource (integration)", () => {
  it("list() returns blobs under `path` matching `patterns`, with prefix stripped", async () => {
    const src = new GitHubSource({
      type: "github",
      name: "stub-gh",
      owner: "o",
      repo: "r",
      path: "policies",
      patterns: ["**/*.md", "**/*.rego"],
      api_base_url: baseUrl,
      token: "t",
    });
    const items = await src.list();
    expect(items.map((i) => i.name).sort()).toEqual(["network.md", "tagging.md", "tagging.rego"]);
    expect(items.every((i) => i.source === "stub-gh")).toBe(true);
    expect(items.find((i) => i.name === "tagging.md")?.uri).toMatch(
      /github\.com\/o\/r\/blob\/main\/policies\/tagging\.md$/,
    );
  });

  it("list() filters by query (case-insensitive) on name + title", async () => {
    const src = new GitHubSource({
      type: "github",
      name: "stub-gh",
      owner: "o",
      repo: "r",
      path: "policies",
      patterns: ["**/*"],
      api_base_url: baseUrl,
      token: "t",
    });
    const items = await src.list("TAGGING");
    expect(items.map((i) => i.name).sort()).toEqual(["tagging.md", "tagging.rego"]);
  });

  it("get() fetches raw content with the expected Accept header", async () => {
    requests.length = 0;
    const src = new GitHubSource({
      type: "github",
      name: "stub-gh",
      owner: "o",
      repo: "r",
      path: "policies",
      patterns: ["**/*"],
      api_base_url: baseUrl,
      token: "tok-abc",
    });
    const item = await src.get("tagging.md");
    expect(item.name).toBe("tagging.md");
    expect(item.content).toBe("raw content for policies/tagging.md");

    const contentsRequest = requests.find((r) => r.url?.includes("/contents/"));
    expect(contentsRequest?.accept).toBe("application/vnd.github.raw");
    expect(contentsRequest?.auth).toBe("Bearer tok-abc");
  });

  it("get() also accepts a name without the `path` prefix", async () => {
    const src = new GitHubSource({
      type: "github",
      name: "stub-gh",
      owner: "o",
      repo: "r",
      path: "policies",
      patterns: ["**/*"],
      api_base_url: baseUrl,
      token: "t",
    });
    // The source should fall back to a `endsWith("/" + name)` match.
    const item = await src.get("tagging.md");
    expect(item.content).toBe("raw content for policies/tagging.md");
  });

  it("get() throws a clean error for an unknown name", async () => {
    const src = new GitHubSource({
      type: "github",
      name: "stub-gh",
      owner: "o",
      repo: "r",
      path: "policies",
      patterns: ["**/*"],
      api_base_url: baseUrl,
      token: "t",
    });
    await expect(src.get("nope.md")).rejects.toThrow(/stub-gh: not found: nope\.md/);
  });

  it("warns at construction when ref is unpinned (default 'main')", () => {
    const buf: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      buf.push(typeof c === "string" ? c : c.toString("utf8"));
      return true;
    });
    try {
      // No `ref` specified — defaults to 'main'.
      new GitHubSource({ type: "github", name: "unpinned", owner: "o", repo: "r", api_base_url: baseUrl, token: "t" });
    } finally {
      spy.mockRestore();
    }
    const events = buf
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; ref?: string });
    const warn = events.find((e) => e.event === "github.unpinned_ref");
    expect(warn?.ref).toBe("main");
  });

  it("does not warn when ref is pinned to a tag or sha", () => {
    const buf: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      buf.push(typeof c === "string" ? c : c.toString("utf8"));
      return true;
    });
    try {
      new GitHubSource({ type: "github", name: "pinned", owner: "o", repo: "r", ref: "v1.2.3", api_base_url: baseUrl, token: "t" });
    } finally {
      spy.mockRestore();
    }
    expect(buf.join("")).not.toContain("github.unpinned_ref");
  });

  it("warns once when GitHub returns x-ratelimit-remaining < 100", async () => {
    // Stand up a stub that emits a tight rate-limit header.
    const lowServer = createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-ratelimit-remaining": "42",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-reset": "1700000000",
      });
      res.end(JSON.stringify({ tree: [], truncated: false }));
    });
    await new Promise<void>((r) => lowServer.listen(0, "127.0.0.1", r));
    const port = (lowServer.address() as AddressInfo).port;

    const buf: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      buf.push(typeof c === "string" ? c : c.toString("utf8"));
      return true;
    });
    try {
      const src = new GitHubSource({
        type: "github",
        name: "rate-low",
        owner: "o",
        repo: "r",
        ref: "v1",                 // pinned, so we don't get a separate unpinned warn
        api_base_url: `http://127.0.0.1:${port}`,
        token: "t",
      });
      await src.list();
      await src.list(); // second call should NOT re-warn (cache hit + once-only flag)
    } finally {
      spy.mockRestore();
      await new Promise<void>((r, j) => lowServer.close((err) => (err ? j(err) : r())));
    }
    const warns = buf
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; remaining?: number })
      .filter((e) => e.event === "github.rate_limit_low");
    expect(warns).toHaveLength(1);
    expect(warns[0].remaining).toBe(42);
  });

  it("caches the tree for 60s within a single source instance", async () => {
    const src = new GitHubSource({
      type: "github",
      name: "stub-gh",
      owner: "o",
      repo: "r",
      api_base_url: baseUrl,
      token: "t",
    });
    requests.length = 0;
    await src.list();
    await src.list();
    const treeCalls = requests.filter((r) => r.url?.includes("/git/trees/"));
    expect(treeCalls).toHaveLength(1);
  });
});
