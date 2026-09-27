// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { TypeSafeClient } from "../../src/selector/typesafe.js";

function client(overrides: Partial<ConstructorParameters<typeof TypeSafeClient>[0]> = {}): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: "sk-test",
    baseUrl: "https://api.typesafe.test/",
    model: "jev-latest",
    timeoutMs: 2_000,
    backoffMs: 1,
    ...overrides,
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const OK_BODY = { model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.9 } } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TypeSafeClient.ask", () => {
  it("posts state, model and questions with a bearer key", async () => {
    const fetchMock = vi.fn(async () => json(200, OK_BODY));
    vi.stubGlobal("fetch", fetchMock);

    const res = await client().ask({ task: "t" }, { q: { type: "noul", instructions: "?" } });

    expect(res).toEqual({ model: "jev-1.13.0", answers: OK_BODY.answers });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.test/v1/systemone");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body as string)).toEqual({
      state: { task: "t" },
      model: "jev-latest",
      questions: { q: { type: "noul", instructions: "?" } },
    });
  });

  it("retries 429 and 529, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(429, { error: "slow down" }))
      .mockResolvedValueOnce(json(529, { error: "overloaded" }))
      .mockResolvedValueOnce(json(200, OK_BODY));
    vi.stubGlobal("fetch", fetchMock);

    const res = await client().ask("s", {});
    expect(res.answers).toEqual(OK_BODY.answers);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxRetries on repeated 529", async () => {
    const fetchMock = vi.fn(async () => json(529, { error: "overloaded" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client({ maxRetries: 1 }).ask("s", {})).rejects.toThrow(/HTTP 529/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry 401 and does not leak the key in the error", async () => {
    const fetchMock = vi.fn(async () => json(401, { error: "invalid key" }));
    vi.stubGlobal("fetch", fetchMock);

    const err = await client().ask("s", {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/HTTP 401/);
    expect((err as Error).message).not.toContain("sk-test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects when the response has no answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { model: "jev" })));
    await expect(client().ask("s", {})).rejects.toThrow(/missing 'answers'/);
  });

  it("fails fast without calling the API when the key is empty", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(client({ apiKey: "" }).ask("s", {})).rejects.toThrow(/api_key is empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a clean timeout error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
          }),
      ),
    );
    await expect(client({ timeoutMs: 20 }).ask("s", {})).rejects.toThrow(/typesafe: timed out after 20ms/);
  });
});
