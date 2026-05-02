// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { HttpSource } from "../../src/sources/http.js";

let server: Server;
let baseUrl: string;
let lastAuthHeader: string | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    lastAuthHeader = req.headers.authorization;
    if (req.url === "/list" || req.url === "/list?q=tag") {
      res.writeHead(200, { "content-type": "application/json" });
      const items = [
        { name: "tagging.md", title: "Tagging policy" },
        { name: "network.md", title: "Network exposure" },
      ];
      const filtered = req.url?.includes("q=tag") ? items.filter((i) => i.name.includes("tag")) : items;
      res.end(JSON.stringify(filtered));
      return;
    }
    if (req.url?.startsWith("/items/")) {
      const name = decodeURIComponent(req.url.replace("/items/", ""));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name, content: `# ${name}\nbody for ${name}` }));
      return;
    }
    if (req.url === "/wrapped") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ entries: [{ name: "a.md" }, { name: "b.md" }] }));
      return;
    }
    if (req.url === "/text") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("plain body");
      return;
    }
    if (req.url === "/missing") {
      res.writeHead(404).end("nope");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(
  () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
);

describe("HttpSource (integration)", () => {
  it("list() returns normalized items from a JSON array endpoint", async () => {
    const src = new HttpSource({ type: "http", name: "stub", base_url: baseUrl, list_path: "/list" });
    const items = await src.list();
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.name).sort()).toEqual(["network.md", "tagging.md"]);
    expect(items[0].source).toBe("stub");
  });

  it("list() forwards a query string the server can filter on", async () => {
    const src = new HttpSource({ type: "http", name: "stub", base_url: baseUrl, list_path: "/list" });
    const items = await src.list("tag");
    expect(items.map((i) => i.name)).toEqual(["tagging.md"]);
  });

  it("list() unwraps an items_field on the response body", async () => {
    const src = new HttpSource({
      type: "http",
      name: "stub",
      base_url: baseUrl,
      list_path: "/wrapped",
      items_field: "entries",
    });
    const items = await src.list();
    expect(items.map((i) => i.name)).toEqual(["a.md", "b.md"]);
  });

  it("get() returns the per-item content", async () => {
    const src = new HttpSource({
      type: "http",
      name: "stub",
      base_url: baseUrl,
      get_path: "/items/{name}",
    });
    const item = await src.get("tagging.md");
    expect(item.name).toBe("tagging.md");
    expect(item.content).toContain("body for tagging.md");
  });

  it("get() handles a text/plain response (no JSON parsing)", async () => {
    const src = new HttpSource({ type: "http", name: "stub", base_url: baseUrl, get_path: "/text" });
    const item = await src.get("anything");
    expect(item.content).toBe("plain body");
    expect(item.content_type).toBe("text/plain");
  });

  it("interpolates ${ENV_VAR} into headers and forwards them", async () => {
    process.env.HTTP_TEST_TOKEN = "secret-123";
    try {
      const src = new HttpSource({
        type: "http",
        name: "stub",
        base_url: baseUrl,
        list_path: "/list",
        headers: { Authorization: "Bearer ${HTTP_TEST_TOKEN}" },
      });
      await src.list();
      expect(lastAuthHeader).toBe("Bearer secret-123");
    } finally {
      delete process.env.HTTP_TEST_TOKEN;
    }
  });

  it("surfaces a clean error for non-2xx responses", async () => {
    const src = new HttpSource({
      type: "http",
      name: "stub",
      base_url: baseUrl,
      get_path: "/missing",
    });
    await expect(src.get("x")).rejects.toThrow(/stub get\(x\) failed: 404/);
  });
});
