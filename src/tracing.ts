// SPDX-License-Identifier: Apache-2.0
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";

/**
 * OpenTelemetry tracing — API only. Spans are emitted unconditionally;
 * adopters bring their own SDK to actually export them. The standard
 * pattern is:
 *
 *   NODE_OPTIONS="--require ./otel-init.js" node dist/index.js serve
 *
 * Where `otel-init.js` registers a NodeTracerProvider with the
 * exporter of choice (OTLP → Tempo / Honeycomb / Datadog / Jaeger).
 *
 * Without an SDK, the no-op tracer in @opentelemetry/api receives the
 * spans and discards them. Cost: a handful of object allocations per
 * tool call. Worth it for anyone who eventually wants traces.
 */
const tracer = trace.getTracer("security-mcp", "0.1.0");

export interface SpanFields {
  [k: string]: string | number | boolean | undefined;
}

/**
 * Run `fn` inside a new span. The span captures duration automatically;
 * thrown errors become span error events with status=ERROR.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanFields,
  fn: (span: Span) => T | Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [k, v] of Object.entries(attributes)) {
        if (v !== undefined) span.setAttribute(k, v);
      }
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
