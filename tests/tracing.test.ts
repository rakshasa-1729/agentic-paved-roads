// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { context, trace, type Span, type SpanContext } from "@opentelemetry/api";
import { withSpan } from "../src/tracing.js";

// Minimal in-memory tracer that captures spans without dragging in
// @opentelemetry/sdk-node. Implements just enough of the API surface
// for our usage: startActiveSpan + Span attribute / status / error
// recording + end.

interface CapturedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  exceptions: Array<{ name?: string; message?: string }>;
  ended: boolean;
}

const captured: CapturedSpan[] = [];

function makeSpan(name: string): Span {
  const c: CapturedSpan = { name, attributes: {}, exceptions: [], ended: false };
  captured.push(c);
  const span: Partial<Span> = {
    setAttribute(key, value) {
      c.attributes[key] = value;
      return this as Span;
    },
    setStatus(status) {
      c.status = status;
      return this as Span;
    },
    recordException(err) {
      const e = err as Error;
      c.exceptions.push({ name: e.name, message: e.message });
      return this as Span;
    },
    end() {
      c.ended = true;
    },
    spanContext(): SpanContext {
      return { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 };
    },
    isRecording: () => true,
    setAttributes(attrs) {
      for (const [k, v] of Object.entries(attrs)) c.attributes[k] = v;
      return this as Span;
    },
    addEvent: () => span as Span,
    addLink: () => span as Span,
    addLinks: () => span as Span,
    updateName: () => span as Span,
  };
  return span as Span;
}

beforeAll(() => {
  trace.setGlobalTracerProvider({
    getTracer: () => ({
      startActiveSpan: ((name: string, ...rest: unknown[]) => {
        // The signature has overloads; the one our code uses is
        // (name, fn).
        const fn = rest[rest.length - 1] as (s: Span) => unknown;
        const span = makeSpan(name);
        return context.with(trace.setSpan(context.active(), span), () => fn(span));
      }) as ReturnType<ReturnType<typeof trace.getTracer>>["startActiveSpan"],
    }),
  });
});

afterAll(() => {
  // Restore noop provider so other suites aren't tainted.
  trace.disable();
});

describe("withSpan", () => {
  it("creates a span around the callback and ends it", async () => {
    captured.length = 0;
    await withSpan("test.span", { foo: "bar", n: 42 }, async () => "result");
    expect(captured).toHaveLength(1);
    expect(captured[0].name).toBe("test.span");
    expect(captured[0].attributes).toMatchObject({ foo: "bar", n: 42 });
    expect(captured[0].status?.code).toBe(1); // OK
    expect(captured[0].ended).toBe(true);
  });

  it("records exceptions and sets status=ERROR when the callback throws", async () => {
    captured.length = 0;
    await expect(
      withSpan("failing.span", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(captured).toHaveLength(1);
    expect(captured[0].status?.code).toBe(2); // ERROR
    expect(captured[0].status?.message).toBe("boom");
    expect(captured[0].exceptions).toHaveLength(1);
    expect(captured[0].exceptions[0].message).toBe("boom");
    expect(captured[0].ended).toBe(true);
  });

  it("skips undefined attributes", async () => {
    captured.length = 0;
    await withSpan("partial.span", { defined: "x", missing: undefined }, async () => 0);
    expect("defined" in captured[0].attributes).toBe(true);
    expect("missing" in captured[0].attributes).toBe(false);
  });
});
