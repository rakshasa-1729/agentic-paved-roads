// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

interface LogContext {
  request_id?: string;
}

const ctx = new AsyncLocalStorage<LogContext>();

function currentThreshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVELS[raw] ?? LEVELS.info;
}

/**
 * Emit one JSON-line log record to stderr.
 *
 * Stable schema:
 *   {ts, level, event, request_id?, ...fields}
 *
 * - `ts` is ISO-8601 UTC.
 * - `event` is a stable identifier (`fetch_error`, `config_migrated`,
 *   …) — not a free-form message. Use `fields.message` for human text.
 * - `request_id` is pulled from AsyncLocalStorage when set via
 *   `withRequestId`.
 *
 * Stays compatible with the stdio MCP transport: framing rides on
 * stdout, logs go to stderr.
 */
export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < currentThreshold()) return;
  const store = ctx.getStore();
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  if (store?.request_id) record.request_id = store.request_id;
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) record[k] = v;
  }
  process.stderr.write(JSON.stringify(record) + "\n");
}

/**
 * Run `fn` with a request_id attached to all log lines emitted from
 * within (transitively, via AsyncLocalStorage). If `id` is omitted, a
 * fresh UUID is generated.
 */
export function withRequestId<T>(id: string | undefined, fn: () => T | Promise<T>): T | Promise<T> {
  return ctx.run({ request_id: id ?? randomUUID() }, fn);
}

/** Read the current request_id, or `undefined` if none is set. */
export function currentRequestId(): string | undefined {
  return ctx.getStore()?.request_id;
}
