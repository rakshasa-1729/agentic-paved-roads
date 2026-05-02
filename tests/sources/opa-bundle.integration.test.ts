// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { gzipSync } from "node:zlib";
import { OpaBundleSource } from "../../src/sources/opa-bundle.js";

// Build a real `.tar.gz` OPA-bundle-shape archive in a tmp dir, then
// have a localhost stub serve its bytes. Exercises the actual gunzip
// + tar pipeline, not a mocked one.

let server: Server;
let baseUrl: string;
let bundleBytes: Buffer;
let tmp: string;
let lastAuthHeader: string | undefined;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "security-mcp-bundle-"));
  // Lay out a bundle:
  //   .manifest                — JSON
  //   policies/tagging.rego    — rego module
  //   policies/network.rego    — rego module
  //   docs/tagging.md          — markdown
  //   data.json                — supporting data
  mkdirSync(join(tmp, "policies"), { recursive: true });
  mkdirSync(join(tmp, "docs"), { recursive: true });
  writeFileSync(join(tmp, ".manifest"), JSON.stringify({ revision: "v1.0.0", roots: ["policies"] }));
  writeFileSync(join(tmp, "policies", "tagging.rego"), 'package tagging\ndeny[m] { m := "untagged" }\n');
  writeFileSync(join(tmp, "policies", "network.rego"), "package network\n");
  writeFileSync(join(tmp, "docs", "tagging.md"), "# Tagging policy\nAll resources must carry an owner tag.\n");
  writeFileSync(join(tmp, "data.json"), JSON.stringify({ allowed_regions: ["us-east-1"] }));

  // tar.create returns a stream; collect it into a buffer.
  const chunks: Buffer[] = [];
  const stream = tar.create(
    { cwd: tmp, gzip: false, portable: true },
    [".manifest", "policies", "docs", "data.json"],
  );
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  bundleBytes = gzipSync(Buffer.concat(chunks));

  server = createServer((req, res) => {
    lastAuthHeader = req.headers.authorization;
    if (req.url === "/bundle.tar.gz") {
      res.writeHead(200, { "content-type": "application/gzip", "content-length": bundleBytes.length });
      res.end(bundleBytes);
      return;
    }
    if (req.url === "/empty.tar.gz") {
      // Valid empty archive (gzip of an empty tar).
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(gzipSync(Buffer.alloc(1024)));
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

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  rmSync(tmp, { recursive: true, force: true });
});

describe("OpaBundleSource (integration)", () => {
  it("downloads, gunzips, and lists every regular file in the bundle", async () => {
    const src = new OpaBundleSource({
      type: "opa-bundle",
      name: "stub-bundle",
      url: `${baseUrl}/bundle.tar.gz`,
    });
    const items = await src.list();
    const names = items.map((i) => i.name).sort();
    expect(names).toEqual([
      ".manifest",
      "data.json",
      "docs/tagging.md",
      "policies/network.rego",
      "policies/tagging.rego",
    ]);
    const reg = items.find((i) => i.name === "policies/tagging.rego");
    expect(reg?.content_type).toBe("application/rego");
    expect(reg?.uri).toContain("#policies/tagging.rego");
  });

  it("filters by patterns at list-time", async () => {
    const src = new OpaBundleSource({
      type: "opa-bundle",
      name: "stub-bundle",
      url: `${baseUrl}/bundle.tar.gz`,
      patterns: ["**/*.rego"],
    });
    const items = await src.list();
    expect(items.map((i) => i.name).sort()).toEqual([
      "policies/network.rego",
      "policies/tagging.rego",
    ]);
  });

  it("get() returns the file body verbatim", async () => {
    const src = new OpaBundleSource({
      type: "opa-bundle",
      name: "stub-bundle",
      url: `${baseUrl}/bundle.tar.gz`,
    });
    const item = await src.get("policies/tagging.rego");
    expect(item.content).toBe('package tagging\ndeny[m] { m := "untagged" }\n');
  });

  it("get() also accepts a suffix when the prefix is omitted", async () => {
    const src = new OpaBundleSource({
      type: "opa-bundle",
      name: "stub-bundle",
      url: `${baseUrl}/bundle.tar.gz`,
    });
    const item = await src.get("tagging.md");
    expect(item.content).toMatch(/All resources must carry/);
  });

  it("throws a clean error for an unknown name", async () => {
    const src = new OpaBundleSource({
      type: "opa-bundle",
      name: "stub-bundle",
      url: `${baseUrl}/bundle.tar.gz`,
    });
    await expect(src.get("no-such.rego")).rejects.toThrow(/stub-bundle: not found: no-such\.rego/);
  });

  it("forwards configured headers (e.g. ${AUTH_TOKEN}) to the registry", async () => {
    process.env.OPA_BUNDLE_TEST_TOKEN = "ghp-fake-123";
    try {
      const src = new OpaBundleSource({
        type: "opa-bundle",
        name: "stub-bundle",
        url: `${baseUrl}/bundle.tar.gz`,
        headers: { Authorization: "Bearer ${OPA_BUNDLE_TEST_TOKEN}" },
      });
      await src.list();
      expect(lastAuthHeader).toBe("Bearer ghp-fake-123");
    } finally {
      delete process.env.OPA_BUNDLE_TEST_TOKEN;
    }
  });

  it("caches the bundle within refresh_ttl_ms (only one HTTP fetch)", async () => {
    let count = 0;
    const localServer = createServer((_req, res) => {
      count++;
      res.writeHead(200).end(bundleBytes);
    });
    await new Promise<void>((r) => localServer.listen(0, "127.0.0.1", r));
    const port = (localServer.address() as AddressInfo).port;
    try {
      const src = new OpaBundleSource({
        type: "opa-bundle",
        name: "cached",
        url: `http://127.0.0.1:${port}/bundle.tar.gz`,
        refresh_ttl_ms: 60_000,
      });
      await src.list();
      await src.list();
      await src.get("policies/tagging.rego");
      expect(count).toBe(1);
    } finally {
      await new Promise<void>((r, j) => localServer.close((err) => (err ? j(err) : r())));
    }
  });

  it("surfaces a clear error when the registry returns a non-2xx", async () => {
    const src = new OpaBundleSource({
      type: "opa-bundle",
      name: "stub-404",
      url: `${baseUrl}/missing`,
    });
    await expect(src.list()).rejects.toThrow(/stub-404: download failed: 404/);
  });
});
