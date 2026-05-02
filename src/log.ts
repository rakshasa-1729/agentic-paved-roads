// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

interface LogContext {
  request_id?: string;
  principal?: string;
}

const ctx = new AsyncLocalStorage<LogContext>();

function currentThreshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVELS[raw] ?? LEVELS.info;
}

/**
 * Resolve the active output format. `LOG_FORMAT=pretty|json` wins; if
 * unset, pretty when stderr is a TTY (interactive dev), json otherwise
 * (containers, pipes, log shippers). The MCP transport choice is
 * irrelevant — logs always go to stderr while framing rides on stdout.
 */
function currentFormat(): "json" | "pretty" {
  const raw = process.env.LOG_FORMAT?.toLowerCase();
  if (raw === "pretty" || raw === "json") return raw;
  return process.stderr.isTTY ? "pretty" : "json";
}

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};
const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: ANSI.dim,
  info: ANSI.green,
  warn: ANSI.yellow,
  error: ANSI.red,
};

function formatPretty(record: Record<string, unknown>): string {
  const { ts, level, event, request_id, principal, ...rest } = record as {
    ts: string;
    level: LogLevel;
    event: string;
    request_id?: string;
    principal?: string;
  } & Record<string, unknown>;
  // HH:MM:SS.mmm — drop the date prefix; ops will care about wall
  // clock at the line scale, not the year.
  const time = ts.slice(11, 23);
  const lvl = LEVEL_COLOR[level] + level.padEnd(5) + ANSI.reset;
  const evt = ANSI.cyan + event + ANSI.reset;
  const id = request_id ? ` ${ANSI.dim}[${request_id.slice(0, 8)}]${ANSI.reset}` : "";
  const who = principal ? ` ${ANSI.blue}${principal}${ANSI.reset}` : "";
  const fields = Object.keys(rest).length
    ? " " + Object.entries(rest).map(([k, v]) => `${ANSI.dim}${k}=${ANSI.reset}${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")
    : "";
  return `${ANSI.dim}${time}${ANSI.reset} ${lvl} ${evt}${id}${who}${fields}`;
}

/**
 * Emit one JSON-line log record to stderr.
 *
 * Stable schema:
 *   {ts, level, event, request_id?, principal?, ...fields}
 *
 * - `ts` is ISO-8601 UTC.
 * - `event` is a stable identifier (`fetch_error`, `config_migrated`,
 *   …) — not a free-form message. Use `fields.message` for human text.
 * - `request_id` and `principal` are pulled from AsyncLocalStorage
 *   when set via `withRequestId` / `withPrincipal`.
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
  if (store?.principal) record.principal = store.principal;
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) record[k] = v;
  }
  const line = currentFormat() === "pretty" ? formatPretty(record) : JSON.stringify(record);
  process.stderr.write(line + "\n");
}

/**
 * Run `fn` with a request_id attached to all log lines emitted from
 * within (transitively, via AsyncLocalStorage). If `id` is omitted, a
 * fresh UUID is generated.
 */
export function withRequestId<T>(id: string | undefined, fn: () => T | Promise<T>): T | Promise<T> {
  const inherited = ctx.getStore() ?? {};
  return ctx.run({ ...inherited, request_id: id ?? randomUUID() }, fn);
}

/**
 * Run `fn` with an authenticated principal attached to log lines.
 * Inherits any existing context (request_id) so the auth middleware
 * can wrap the route handler before withRequestId fires.
 */
export function withPrincipal<T>(principal: string, fn: () => T | Promise<T>): T | Promise<T> {
  const inherited = ctx.getStore() ?? {};
  return ctx.run({ ...inherited, principal }, fn);
}

/** Read the current request_id, or `undefined` if none is set. */
export function currentRequestId(): string | undefined {
  return ctx.getStore()?.request_id;
}

/** Read the current authenticated principal, or `undefined`. */
export function currentPrincipal(): string | undefined {
  return ctx.getStore()?.principal;
}
