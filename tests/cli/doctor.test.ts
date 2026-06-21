// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/cli/doctor.js";

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let tmp: string;
const savedConfig = process.env.SECURITY_MCP_CONFIG;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  tmp = mkdtempSync(join(tmpdir(), "doctor-test-"));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
  if (savedConfig !== undefined) process.env.SECURITY_MCP_CONFIG = savedConfig;
  else delete process.env.SECURITY_MCP_CONFIG;
});

describe("security-mcp doctor", () => {
  it("prints diagnostics and exits 0 on a healthy environment", async () => {
    // The test environment runs Node ≥20 (CI matrix), so the only
    // potentially-failing check is Node version. All others are
    // optional/info.
    const code = await run([]);
    expect(code).toBe(0);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toMatch(/Node\.js >=20/);
    expect(out).toMatch(/config file/);
    expect(out).toMatch(/env:/);
    // Token vars are listed and either (unset) or masked — never raw.
    expect(out).toMatch(/SECURITY_REPO_TOKEN/);
  });

  it("masks token env vars instead of printing the value", async () => {
    process.env.SECURITY_REPO_TOKEN = "super-secret-token-do-not-print";
    try {
      await run([]);
      const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).not.toContain("super-secret-token-do-not-print");
      expect(out).toMatch(/SECURITY_REPO_TOKEN.*set \(\d+ chars\)/);
    } finally {
      delete process.env.SECURITY_REPO_TOKEN;
    }
  });

  it("--help exits 0 and prints usage", async () => {
    const code = await run(["--help"]);
    expect(code).toBe(0);
    expect(stdoutSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/Usage: security-mcp doctor/);
  });
});

describe("security-mcp doctor --probe", () => {
  it("reports skip when config file is not found", async () => {
    process.env.SECURITY_MCP_CONFIG = join(tmp, "nonexistent.yaml");
    const code = await run(["--probe"]);
    expect(code).toBe(0);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toMatch(/source probes:/);
    expect(out).toMatch(/config probe/);
    expect(out).toMatch(/not found/);
  });

  it("probes file sources and reports ok for reachable sources", async () => {
    const goodDir = resolve("examples/policies");
    const configPath = join(tmp, "config.yaml");
    writeFileSync(
      configPath,
      `collections:
  - name: policy_tool
    sources:
      - type: file
        name: local-policies
        path: ${goodDir}
        patterns: ["**/*.md"]
`,
    );
    process.env.SECURITY_MCP_CONFIG = configPath;

    const code = await run(["--probe"]);
    expect(code).toBe(0);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toMatch(/probe: local-policies/);
    expect(out).toMatch(/\d+ items/);
  });

  it("reports fail for an unreachable http source", async () => {
    const configPath = join(tmp, "config.yaml");
    writeFileSync(
      configPath,
      `collections:
  - name: bad_tool
    sources:
      - type: http
        name: dead-endpoint
        base_url: http://127.0.0.1:1
        list_path: /list
        timeout_ms: 500
`,
    );
    process.env.SECURITY_MCP_CONFIG = configPath;

    const code = await run(["--probe"]);
    expect(code).toBe(1);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toMatch(/probe: dead-endpoint/);
    expect(out).toMatch(/unreachable/i);
  });
});
