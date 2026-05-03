// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/schema.js";

let tmp: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "security-mcp-schema-"));
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

describe("security-mcp schema", () => {
  it("emits a parseable JSON Schema covering the top-level config keys", async () => {
    const code = await run([]);
    expect(code).toBe(0);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    const schema = JSON.parse(out);
    expect(schema.$ref).toBe("#/definitions/SecurityMcpConfig");
    const root = schema.definitions.SecurityMcpConfig;
    expect(root.type).toBe("object");
    expect(Object.keys(root.properties)).toEqual(
      expect.arrayContaining(["server", "collections", "tools", "auth", "audit_log"]),
    );
  });

  it("includes every source-type discriminator under collections.sources", async () => {
    await run([]);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    const schema = JSON.parse(out);
    // All seven source types should appear somewhere as a const value
    // of `type`.
    const json = JSON.stringify(schema);
    for (const t of ["file", "http", "mcp", "github", "opa-bundle", "gitlab", "local-cmd"]) {
      expect(json).toContain(`"const":"${t}"`);
    }
  });

  it("--out <path> writes to a file and prints nothing to stdout", async () => {
    const out = join(tmp, "schema.json");
    const code = await run(["--out", out]);
    expect(code).toBe(0);
    expect(stdoutSpy).not.toHaveBeenCalled();
    const written = JSON.parse(readFileSync(out, "utf8"));
    expect(written.$ref).toBe("#/definitions/SecurityMcpConfig");
  });

  it("--help exits 0 and prints usage", async () => {
    const code = await run(["--help"]);
    expect(code).toBe(0);
    expect(stdoutSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/Usage: security-mcp schema/);
  });

  it("rejects unknown flags", async () => {
    const code = await run(["--bogus"]);
    expect(code).toBe(2);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/unknown argument/);
  });
});
