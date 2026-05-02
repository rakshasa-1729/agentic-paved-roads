// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/doctor.js";

let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
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
