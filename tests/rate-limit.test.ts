import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rate-limit.js";

describe("RateLimiter", () => {
  it("allows requests within the budget", () => {
    const limiter = new RateLimiter({ window_ms: 60_000, max_requests: 5 });
    for (let i = 0; i < 5; i++) {
      expect(limiter.check("alice")).toBe(true);
    }
  });

  it("blocks requests exceeding the budget", () => {
    const limiter = new RateLimiter({ window_ms: 60_000, max_requests: 3 });
    for (let i = 0; i < 3; i++) limiter.check("alice");
    expect(limiter.check("alice")).toBe(false);
  });

  it("tracks different keys independently", () => {
    const limiter = new RateLimiter({ window_ms: 60_000, max_requests: 2 });
    expect(limiter.check("alice")).toBe(true);
    expect(limiter.check("alice")).toBe(true);
    expect(limiter.check("alice")).toBe(false);
    expect(limiter.check("bob")).toBe(true);
    expect(limiter.check("bob")).toBe(true);
    expect(limiter.check("bob")).toBe(false);
  });

  it("prunes expired entries and allows new requests", async () => {
    const limiter = new RateLimiter({ window_ms: 50, max_requests: 2 });
    expect(limiter.check("alice")).toBe(true);
    expect(limiter.check("alice")).toBe(true);
    expect(limiter.check("alice")).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(limiter.check("alice")).toBe(true);
  });
});
