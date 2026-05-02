// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/serve.js";

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

// We can't actually start the server in a unit test (it never resolves
// in stdio mode). Cover only the arg-parsing surface — the wider HTTP
// behavior is exercised by the e2e/http suite.

describe("security-mcp serve flag parsing", () => {
  it("--help exits 0 and prints usage", async () => {
    const code = await run(["--help"]);
    expect(code).toBe(0);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toMatch(/Usage: security-mcp serve/);
    expect(out).toMatch(/--transport/);
    expect(out).toMatch(/--port/);
    expect(out).toMatch(/--host/);
    expect(out).toMatch(/--config/);
  });

  it("rejects unknown flags with exit 2", async () => {
    const code = await run(["--bogus"]);
    expect(code).toBe(2);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/unknown argument/);
  });

  it("rejects a non-numeric --port with exit 2", async () => {
    const code = await run(["--port", "abc"]);
    expect(code).toBe(2);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toMatch(/--port requires/);
  });
});
