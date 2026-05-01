// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { HttpSource } from "../../src/sources/http.js";
import { GitHubSource } from "../../src/sources/github.js";

// Spawn a localhost server that holds requests open forever, then assert
// each source aborts within its timeout budget rather than hanging.

let server: Server;
let baseUrl: string;
const heldSockets: Array<{ req: IncomingMessage; res: ServerResponse }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    // Never call res.end(); let the timeout side handle it.
    heldSockets.push({ req, res });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  // Tear down any held responses so the server can close cleanly.
  for (const { res } of heldSockets) {
    try {
      res.destroy();
    } catch {
      // best effort
    }
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("HttpSource timeout", () => {
  it("aborts a hung list() within timeout_ms (+ slack)", async () => {
    const src = new HttpSource({
      type: "http",
      name: "stub-http",
      base_url: baseUrl,
      list_path: "/list",
      timeout_ms: 100,
    });

    const start = Date.now();
    await expect(src.list()).rejects.toThrow(/stub-http: timed out after 100ms/);
    const elapsed = Date.now() - start;
    // Generous upper bound — CI runners can be slow. Lower bound proves it
    // didn't return early.
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(2000);
  });

  it("aborts a hung get() within timeout_ms", async () => {
    const src = new HttpSource({
      type: "http",
      name: "stub-http",
      base_url: baseUrl,
      get_path: "/items/{name}",
      timeout_ms: 100,
    });
    await expect(src.get("anything")).rejects.toThrow(/stub-http: timed out after 100ms/);
  });
});

describe("GitHubSource timeout", () => {
  it("aborts when api_base_url points at a server that never responds", async () => {
    const src = new GitHubSource({
      type: "github",
      name: "stub-gh",
      owner: "o",
      repo: "r",
      api_base_url: baseUrl,
      // skip the gh-cli token-resolution path
      token: "static-token",
      timeout_ms: 100,
    });
    await expect(src.list()).rejects.toThrow(/stub-gh: timed out after 100ms/);
  });
});
