// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { withTimeout, abortableFetch } from "../../src/util/timeout.js";

let server: Server;
let baseUrl: string;
const heldSockets: ServerResponse[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/hold") {
      heldSockets.push(res);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const res of heldSockets) {
    try {
      res.destroy();
    } catch {
      // best effort
    }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("withTimeout", () => {
  it("returns the value when the promise resolves before the deadline", async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, "test");
    expect(result).toBe(42);
  });

  it("rejects with '<label>: timed out after Xms' on timeout", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 500));
    await expect(withTimeout(slow, 50, "myop")).rejects.toThrow("myop: timed out after 50ms");
  });

  it("calls the onTimeout cleanup callback before rejecting", async () => {
    let cleaned = false;
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 500));
    await expect(withTimeout(slow, 50, "op", () => { cleaned = true; })).rejects.toThrow("timed out after 50ms");
    expect(cleaned).toBe(true);
  });

  it("propagates a non-timeout rejection from the inner promise unchanged", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("inner failure")), 1000, "op"),
    ).rejects.toThrow("inner failure");
  });

  it("races correctly when the promise resolves just before the deadline", async () => {
    const result = await withTimeout(
      new Promise<string>((resolve) => setTimeout(() => resolve("fast"), 10)),
      200,
      "race-test",
    );
    expect(result).toBe("fast");
  });
});

describe("abortableFetch", () => {
  it("returns a Response for a prompt server", async () => {
    const res = await abortableFetch(`${baseUrl}/`, undefined, 5000, "test-src");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("throws '<sourceId>: timed out after Xms' for a hung server", async () => {
    await expect(
      abortableFetch(`${baseUrl}/hold`, undefined, 100, "stub-src"),
    ).rejects.toThrow("stub-src: timed out after 100ms");
  });

  it("propagates a real connection error without reformatting it as a timeout", async () => {
    try {
      await abortableFetch("http://127.0.0.1:1/", undefined, 5000, "mysrc");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toMatch(/timed out/);
    }
  });
});
