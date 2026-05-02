// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentRequestId, log, withRequestId } from "../src/log.js";

interface Captured {
  ts: string;
  level: string;
  event: string;
  request_id?: string;
  [k: string]: unknown;
}

function captureStderr(): { lines: () => Captured[]; restore: () => void } {
  const buf: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    buf.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    return true;
  });
  return {
    lines: () =>
      buf
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Captured),
    restore: () => spy.mockRestore(),
  };
}

describe("log", () => {
  let cap: ReturnType<typeof captureStderr>;

  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    cap = captureStderr();
  });

  afterEach(() => cap.restore());

  it("emits one valid JSON line per call with the required schema fields", () => {
    log("info", "test.event", { source_id: "s1", count: 7 });
    const lines = cap.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("info");
    expect(lines[0].event).toBe("test.event");
    expect(lines[0].source_id).toBe("s1");
    expect(lines[0].count).toBe(7);
    expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("filters records below LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "warn";
    log("debug", "noisy");
    log("info", "noisy");
    log("warn", "loud");
    log("error", "fatal");
    const events = cap.lines().map((l) => l.event);
    expect(events).toEqual(["loud", "fatal"]);
  });

  it("falls back to info when LOG_LEVEL is bogus", () => {
    process.env.LOG_LEVEL = "florp";
    log("debug", "noisy");
    log("info", "kept");
    expect(cap.lines().map((l) => l.event)).toEqual(["kept"]);
  });

  it("omits a field when its value is undefined", () => {
    log("info", "test.event", { keep: "x", drop: undefined });
    const [line] = cap.lines();
    expect(line.keep).toBe("x");
    expect("drop" in line).toBe(false);
  });

  it("does not include request_id when none is set", () => {
    log("info", "test.event");
    const [line] = cap.lines();
    expect(line.request_id).toBeUndefined();
  });
});

describe("withRequestId", () => {
  let cap: ReturnType<typeof captureStderr>;
  beforeEach(() => {
    cap = captureStderr();
  });
  afterEach(() => cap.restore());

  it("attaches a UUID request_id to every log line in scope", async () => {
    await withRequestId(undefined, async () => {
      log("info", "a");
      log("info", "b");
    });
    const ids = cap.lines().map((l) => l.request_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[0]).toBe(ids[1]); // same scope, same id
  });

  it("uses the provided id verbatim when one is passed", async () => {
    await withRequestId("custom-id", async () => log("info", "x"));
    expect(cap.lines()[0].request_id).toBe("custom-id");
  });

  it("isolates ids across concurrent scopes", async () => {
    await Promise.all([
      withRequestId("a", async () => {
        await new Promise((r) => setTimeout(r, 10));
        log("info", "from-a");
      }),
      withRequestId("b", async () => {
        log("info", "from-b");
      }),
    ]);
    const lines = cap.lines();
    const a = lines.find((l) => l.event === "from-a");
    const b = lines.find((l) => l.event === "from-b");
    expect(a?.request_id).toBe("a");
    expect(b?.request_id).toBe("b");
  });

  it("currentRequestId() returns the in-scope id, undefined outside", async () => {
    expect(currentRequestId()).toBeUndefined();
    await withRequestId("zzz", async () => {
      expect(currentRequestId()).toBe("zzz");
    });
    expect(currentRequestId()).toBeUndefined();
  });
});
