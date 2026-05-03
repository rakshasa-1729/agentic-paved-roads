// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/cli/lint.js";

let tmp: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "security-mcp-lint-"));
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

function write(rel: string, body: string): void {
  const p = join(tmp, rel);
  mkdirSync(join(tmp, rel.includes("/") ? rel.replace(/\/[^/]+$/, "") : "."), { recursive: true });
  writeFileSync(p, body);
}

describe("security-mcp lint", () => {
  it("returns 0 with a clean report on a valid repo", async () => {
    write("policies/tagging.md", "# Tagging\nspec.\n");
    write("policies/tagging.rego", "package tagging\n");
    write("README.md", "see [tagging](policies/tagging.md)\n");
    const code = await run([tmp]);
    expect(code).toBe(0);
    expect(stdoutSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/no issues/);
  });

  it("flags a .rego without a co-located .md", async () => {
    write("policies/tagging.rego", "package tagging\n");
    const code = await run([tmp]);
    expect(code).toBe(1);
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(err).toMatch(/rego-md-pairing/);
    expect(err).toMatch(/no companion \.md/);
  });

  it("flags a malformed tools/*.yaml against the InlineTool schema", async () => {
    write("tools/bad.yaml", "type: command\n# missing required `name` and `command`\n");
    const code = await run([tmp]);
    expect(code).toBe(1);
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(err).toMatch(/tool-schema/);
  });

  it("accepts a well-formed tools/*.yaml", async () => {
    write(
      "tools/conftest.yaml",
      `
type: command
name: conftest
command: conftest
args: ["test", "--policy", "{{policy_path}}", "{{input_path}}"]
input_schema:
  type: object
  properties:
    policy_path: { type: string }
    input_path: { type: string }
  required: [policy_path, input_path]
`,
    );
    const code = await run([tmp]);
    expect(code).toBe(0);
  });

  it("flags broken intra-repo markdown links", async () => {
    write("README.md", "see [missing](./not-here.md)\n");
    const code = await run([tmp]);
    expect(code).toBe(1);
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(err).toMatch(/broken-link/);
    expect(err).toMatch(/not-here\.md/);
  });

  it("ignores absolute and anchor links", async () => {
    write(
      "README.md",
      `
[ext](https://example.com)
[anchor](#section)
[mail](mailto:a@b.c)
`,
    );
    const code = await run([tmp]);
    expect(code).toBe(0);
  });

  it("--json emits parseable findings + exits 1 when issues exist", async () => {
    write("policies/tagging.rego", "package tagging\n");
    const code = await run([tmp, "--json"]);
    expect(code).toBe(1);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(out) as { findings: Array<{ rule: string }> };
    expect(parsed.findings.length).toBeGreaterThan(0);
    expect(parsed.findings.some((f) => f.rule === "rego-md-pairing")).toBe(true);
  });

  it("missing repo path exits 2 with usage", async () => {
    const code = await run([]);
    expect(code).toBe(2);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/missing required <repo-path>/);
  });

  it("non-existent repo exits 1", async () => {
    const code = await run([join(tmp, "nope")]);
    expect(code).toBe(1);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/not found/);
  });

  it("--help exits 0 and prints usage", async () => {
    const code = await run(["--help"]);
    expect(code).toBe(0);
    expect(stdoutSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/Usage: security-mcp lint/);
  });
});
