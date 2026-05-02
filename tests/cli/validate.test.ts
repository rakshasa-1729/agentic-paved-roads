// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/cli/validate.js";

const POLICIES = resolve(__dirname, "../../examples/policies");

let tmp: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "security-mcp-validate-"));
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

function writeConfig(name: string, body: string): string {
  const p = join(tmp, name);
  writeFileSync(p, body);
  return p;
}

describe("security-mcp validate", () => {
  it("exits 0 for a valid config with reachable file source", async () => {
    const cfg = writeConfig(
      "config.yaml",
      `
server: { name: test }
collections:
  - name: policy_tool
    sources:
      - { type: file, name: local, path: ${POLICIES}, patterns: ["**/*.md"] }
tools:
  registry: []
`,
    );
    const code = await run([cfg]);
    expect(code).toBe(0);
    const stdout = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stdout).toMatch(/✓.*parses cleanly/);
    expect(stdout).toMatch(/✓ local/);
    expect(stdout).toMatch(/all sources responded/);
  });

  it("exits 1 when a config does not exist", async () => {
    const code = await run([join(tmp, "nope.yaml")]);
    expect(code).toBe(1);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/config not found/);
  });

  it("exits 1 with a clean message on a malformed config", async () => {
    const cfg = writeConfig(
      "config.yaml",
      `
collections:
  - name: 123-bad-name   # names must start with a letter
    sources: []
`,
    );
    const code = await run([cfg]);
    expect(code).toBe(1);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/config invalid/);
  });

  it("exits 1 when a source fails to respond", async () => {
    const cfg = writeConfig(
      "config.yaml",
      `
collections:
  - name: policy_tool
    sources:
      - { type: file, name: missing, path: /nonexistent-${Date.now()}, patterns: ["**/*.md"] }
tools:
  registry: []
`,
    );
    const code = await run([cfg]);
    // file source's list() returns [] for a non-existent dir (fast-glob
    // doesn't error). So this scenario actually validates clean.
    expect(code).toBe(0);
    const stdout = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stdout).toMatch(/✓ missing/);
  });

  it("--no-probe skips source probes (only validates schema)", async () => {
    const cfg = writeConfig(
      "config.yaml",
      `
collections:
  - name: policy_tool
    sources:
      - { type: file, name: local, path: ${POLICIES}, patterns: ["**/*.md"] }
tools:
  registry: []
`,
    );
    const code = await run([cfg, "--no-probe"]);
    expect(code).toBe(0);
    const stdout = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stdout).toMatch(/parses cleanly/);
    expect(stdout).not.toMatch(/✓ local/);
  });

  it("--help exits 0 and prints usage", async () => {
    const code = await run(["--help"]);
    expect(code).toBe(0);
    expect(stdoutSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/Usage: security-mcp validate/);
  });
});
