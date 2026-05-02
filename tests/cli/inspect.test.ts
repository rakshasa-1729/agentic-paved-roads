// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/cli/inspect.js";

const POLICIES = resolve(__dirname, "../../examples/policies");

let tmp: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "security-mcp-inspect-"));
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

const BASE_CONFIG = `
server: { name: inspect-test }
collections:
  - name: policy_tool
    description: Test policies.
    sources:
      - { type: file, name: local, path: ${POLICIES}, patterns: ["**/*.md"] }
tools:
  registry: []
`;

describe("security-mcp inspect", () => {
  it("lists tools registered by the config", async () => {
    const cfg = writeConfig("config.yaml", BASE_CONFIG);
    const code = await run(["--config", cfg]);
    expect(code).toBe(0);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toMatch(/tools \(2\)/);
    expect(out).toMatch(/policy_tool/);
    expect(out).toMatch(/tool_registry/);
  });

  it("--json emits a parseable tools array", async () => {
    const cfg = writeConfig("config.yaml", BASE_CONFIG);
    const code = await run(["--config", cfg, "--json"]);
    expect(code).toBe(0);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(out) as { tools: Array<{ name: string }> };
    expect(parsed.tools.map((t) => t.name).sort()).toEqual(["policy_tool", "tool_registry"]);
  });

  it("--tool prints description + input schema", async () => {
    const cfg = writeConfig("config.yaml", BASE_CONFIG);
    const code = await run(["--config", cfg, "--tool", "policy_tool"]);
    expect(code).toBe(0);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toMatch(/policy_tool/);
    expect(out).toMatch(/Test policies/);
    expect(out).toMatch(/input schema:/);
    expect(out).toMatch(/"action"/);
  });

  it("--tool with an unknown name exits 1", async () => {
    const cfg = writeConfig("config.yaml", BASE_CONFIG);
    const code = await run(["--config", cfg, "--tool", "no-such-tool"]);
    expect(code).toBe(1);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/tool not found/);
  });

  it("--call invokes a tool and prints content text", async () => {
    const cfg = writeConfig("config.yaml", BASE_CONFIG);
    const code = await run([
      "--config",
      cfg,
      "--call",
      "policy_tool",
      "--args",
      JSON.stringify({ action: "list" }),
    ]);
    expect(code).toBe(0);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toMatch(/tagging\.md/);
    expect(out).toMatch(/network-exposure\.md/);
  });

  it("--call with bad JSON --args exits 2", async () => {
    const cfg = writeConfig("config.yaml", BASE_CONFIG);
    const code = await run(["--config", cfg, "--call", "policy_tool", "--args", "{not json"]);
    expect(code).toBe(2);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/--args must be a JSON object/);
  });

  it("missing config exits 1", async () => {
    const code = await run(["--config", join(tmp, "nope.yaml")]);
    expect(code).toBe(1);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/config not found/);
  });

  it("--help exits 0 and prints usage", async () => {
    const code = await run(["--help"]);
    expect(code).toBe(0);
    expect(stdoutSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/Usage: security-mcp inspect/);
  });
});
