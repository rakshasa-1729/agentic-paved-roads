// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/init.js";

let tmp: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "security-mcp-init-"));
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

describe("security-mcp init", () => {
  it("writes the requested preset to the destination", async () => {
    const out = join(tmp, "config.yaml");
    const code = await run(["--preset", "empty", "--out", out]);
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("collections:");
  });

  it("defaults to the security preset", async () => {
    const out = join(tmp, "config.yaml");
    const code = await run(["--out", out]);
    expect(code).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("policy_tool");
  });

  it("refuses to overwrite an existing file without --force", async () => {
    const out = join(tmp, "config.yaml");
    writeFileSync(out, "existing-content");
    const code = await run(["--preset", "empty", "--out", out]);
    expect(code).toBe(1);
    expect(readFileSync(out, "utf8")).toBe("existing-content");
    const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderr).toMatch(/already exists/);
  });

  it("overwrites with --force", async () => {
    const out = join(tmp, "config.yaml");
    writeFileSync(out, "existing-content");
    const code = await run(["--preset", "empty", "--out", out, "--force"]);
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("collections:");
  });

  it("rejects unknown preset names with the available list", async () => {
    const out = join(tmp, "config.yaml");
    const code = await run(["--preset", "no-such-preset", "--out", out]);
    expect(code).toBe(2);
    const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderr).toMatch(/unknown preset/);
    expect(stderr).toMatch(/security/);
    expect(stderr).toMatch(/empty/);
  });

  it("rejects unknown flags", async () => {
    const code = await run(["--what"]);
    expect(code).toBe(2);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/unknown argument/);
  });

  it("--help exits 0 and prints usage to stdout", async () => {
    const code = await run(["--help"]);
    expect(code).toBe(0);
    expect(stdoutSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/Usage: security-mcp init/);
  });
});
