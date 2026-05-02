// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { log } from "./log.js";

export interface AuditEntry {
  request_id?: string;
  principal?: string;
  tool: string;
  action?: string;
  args: unknown;
  ok: boolean;
  duration_ms: number;
  error?: string;
}

/**
 * Audit-log writer. One instance is constructed at startup
 * (`openAuditLog(path)`) and passed through the server build helpers
 * so per-request handlers can append records. A no-op recorder is
 * available via `noopAudit()` for the (default) case where auditing is
 * disabled.
 */
export interface AuditRecorder {
  record(entry: AuditEntry): void;
  close(): Promise<void>;
}

class FileAuditRecorder implements AuditRecorder {
  constructor(private readonly writer: WriteStream, private readonly path: string) {
    writer.on("error", (err) => {
      // Don't crash the server on audit write errors — log and keep
      // serving. The operator's monitoring should pick up the warn.
      log("warn", "audit.write_error", { error: err.message, path });
    });
  }

  record(entry: AuditEntry): void {
    const record = {
      ts: new Date().toISOString(),
      request_id: entry.request_id,
      principal: entry.principal,
      tool: entry.tool,
      action: entry.action,
      args_hash: hashArgs(entry.args),
      ok: entry.ok,
      duration_ms: entry.duration_ms,
      error: entry.error,
    };
    const compact: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) if (v !== undefined) compact[k] = v;
    this.writer.write(JSON.stringify(compact) + "\n");
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => this.writer.end(() => resolve()));
  }
}

const NOOP_RECORDER: AuditRecorder = {
  record() {},
  async close() {},
};

/** A do-nothing recorder used when audit logging is disabled. */
export function noopAudit(): AuditRecorder {
  return NOOP_RECORDER;
}

/**
 * Open an audit log for append. The directory is created if it does
 * not exist. Returns a recorder; pass `undefined` for `path` to get a
 * no-op recorder back (so callers don't have to branch on whether
 * auditing is configured).
 */
export function openAuditLog(path?: string): AuditRecorder {
  if (!path) return noopAudit();
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  const writer = createWriteStream(abs, { flags: "a" });
  return new FileAuditRecorder(writer, abs);
}

function hashArgs(args: unknown): string {
  if (args === undefined || args === null) return "0".repeat(16);
  const json = canonicalize(args);
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

/** Object-key-sorted JSON so equivalent inputs hash to the same digest. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}
