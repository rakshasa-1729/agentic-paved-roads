// SPDX-License-Identifier: Apache-2.0
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/**
 * Per-process Prometheus registry. Counters + histograms cover the
 * three interesting axes: tool invocations, source fetches, audit
 * writes. Default Node metrics (event-loop lag, GC, RSS) are also
 * collected so operators get the standard Node dashboard for free.
 *
 * Stays compatible with the stdio MCP transport: the registry exists
 * regardless of transport, but the /metrics endpoint is only mounted
 * on the http server (where it's actually scrapeable).
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "security_mcp_" });

const labels = (names: string[]): { labelNames: string[] } => ({ labelNames: names });

export const toolInvocations = new Counter({
  name: "security_mcp_tool_invocations_total",
  help: "Number of tools/call requests dispatched, partitioned by tool and outcome.",
  registers: [registry],
  ...labels(["tool", "ok"]),
});

export const toolDuration = new Histogram({
  name: "security_mcp_tool_duration_ms",
  help: "Wall-clock time spent dispatching a tool call, in milliseconds.",
  registers: [registry],
  ...labels(["tool", "ok"]),
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
});

export const httpRequests = new Counter({
  name: "security_mcp_http_requests_total",
  help: "Number of POST /mcp requests handled, partitioned by HTTP status class.",
  registers: [registry],
  ...labels(["status_class"]),
});

export const auditWrites = new Counter({
  name: "security_mcp_audit_writes_total",
  help: "Number of audit-log records written, partitioned by ok=true|false.",
  registers: [registry],
  ...labels(["ok"]),
});

/** Render the registry in the Prometheus text exposition format. */
export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}

/** Test-only: drop accumulated counters so suites don't bleed into each other. */
export function _resetMetrics(): void {
  registry.resetMetrics();
}
