// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditRecorder, openAuditLog } from "../src/audit.js";

let tmp: string;
let recorder: AuditRecorder | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "security-mcp-audit-"));
});

afterEach(async () => {
  if (recorder) await recorder.close();
  recorder = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function flush(path: string): Promise<void> {
  if (recorder) await recorder.close();
  recorder = undefined;
  if (!existsSync(path)) throw new Error(`audit file missing: ${path}`);
}

describe("audit log", () => {
  it("appends one JSONL record per record() call", async () => {
    const path = join(tmp, "audit.jsonl");
    recorder = openAuditLog(path);
    recorder.record({
      request_id: "rid-1",
      principal: "alice@example.com",
      tool: "policy_tool",
      action: "list",
      args: { action: "list" },
      ok: true,
      duration_ms: 12,
    });
    recorder.record({
      tool: "tool_registry",
      action: "invoke",
      args: { name: "conftest", input: { input_path: "./plan.json" } },
      ok: false,
      duration_ms: 800,
      error: "FAIL: untagged-resource",
    });
    await flush(path);

    const lines = readLines(path);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      request_id: "rid-1",
      principal: "alice@example.com",
      tool: "policy_tool",
      action: "list",
      ok: true,
      duration_ms: 12,
    });
    expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lines[0].args_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(lines[1].ok).toBe(false);
    expect(lines[1].error).toBe("FAIL: untagged-resource");
  });

  it("hashes args rather than writing them verbatim (no leakage)", async () => {
    const path = join(tmp, "audit.jsonl");
    recorder = openAuditLog(path);
    recorder.record({
      tool: "exception_tool",
      args: { token: "ghp-do-not-leak", justification: "approved by sec" },
      ok: true,
      duration_ms: 1,
    });
    await flush(path);

    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("ghp-do-not-leak");
    expect(raw).not.toContain("approved by sec");
    expect(raw).toMatch(/"args_hash":"[0-9a-f]{16}"/);
  });

  it("records full args when recordArgs is true (for regulated environments)", async () => {
    const path = join(tmp, "audit.jsonl");
    recorder = openAuditLog(path, { recordArgs: true });
    recorder.record({
      tool: "exception_tool",
      args: { policy_id: "AWS-001", justification: "approved by sec team" },
      ok: true,
      duration_ms: 1,
    });
    await flush(path);

    const lines = readLines(path);
    expect(lines).toHaveLength(1);
    expect(lines[0].args).toEqual({ policy_id: "AWS-001", justification: "approved by sec team" });
    // The hash is still present alongside full args for correlation
    expect(lines[0].args_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("records auth_mode and response_bytes when provided", async () => {
    const path = join(tmp, "audit.jsonl");
    recorder = openAuditLog(path);
    recorder.record({
      tool: "policy_tool",
      args: { action: "list" },
      ok: true,
      duration_ms: 5,
      auth_mode: "oidc",
      response_bytes: 4096,
    });
    await flush(path);

    const lines = readLines(path);
    expect(lines[0].auth_mode).toBe("oidc");
    expect(lines[0].response_bytes).toBe(4096);
  });

  it("hashes equivalent args to the same digest regardless of key order", async () => {
    const path = join(tmp, "audit.jsonl");
    recorder = openAuditLog(path);
    recorder.record({ tool: "x", args: { a: 1, b: 2 }, ok: true, duration_ms: 0 });
    recorder.record({ tool: "x", args: { b: 2, a: 1 }, ok: true, duration_ms: 0 });
    await flush(path);

    const lines = readLines(path);
    expect(lines[0].args_hash).toBe(lines[1].args_hash);
  });

  it("omits undefined fields (no `\"principal\":null` clutter)", async () => {
    const path = join(tmp, "audit.jsonl");
    recorder = openAuditLog(path);
    recorder.record({ tool: "x", args: {}, ok: true, duration_ms: 0 });
    await flush(path);

    const raw = readFileSync(path, "utf8").trim();
    expect(raw).not.toContain("null");
    expect(raw).not.toContain("principal");
    expect(raw).not.toContain("request_id");
  });

  it("creates intermediate directories if needed", async () => {
    const path = join(tmp, "nested", "deep", "audit.jsonl");
    recorder = openAuditLog(path);
    recorder.record({ tool: "x", args: {}, ok: true, duration_ms: 0 });
    await flush(path);
    expect(existsSync(path)).toBe(true);
  });

  it("openAuditLog(undefined) returns a no-op recorder that swallows record()", async () => {
    const noop = openAuditLog(undefined);
    noop.record({ tool: "x", args: {}, ok: true, duration_ms: 0 });
    await noop.close();
    // No file to assert on; just verify nothing threw.
  });

  it("appends across reopens (does not truncate)", async () => {
    const path = join(tmp, "audit.jsonl");
    recorder = openAuditLog(path);
    recorder.record({ tool: "first", args: {}, ok: true, duration_ms: 0 });
    await recorder.close();
    recorder = openAuditLog(path);
    recorder.record({ tool: "second", args: {}, ok: true, duration_ms: 0 });
    await flush(path);

    const lines = readLines(path);
    expect(lines.map((l) => l.tool)).toEqual(["first", "second"]);
  });
});
