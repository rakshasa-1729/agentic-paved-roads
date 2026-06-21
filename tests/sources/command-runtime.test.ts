// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { InlineToolSource } from "../../src/sources/command.js";

// These tests use real child processes (sleep, sh -c). They run on Linux
// + macOS — the CI matrix uses ubuntu-latest, so /bin/sleep and /bin/sh
// are guaranteed.

describe("command tool: timeout + signal escalation", () => {
  it("kills a hung child with SIGTERM at command_timeout_ms", async () => {
    const src = new InlineToolSource([
      {
        type: "command",
        name: "hang",
        command: "sleep",
        args: ["30"],
        command_timeout_ms: 100,
      },
    ]);

    const start = Date.now();
    const result = await src.invoke("hang", {});
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/hang: timed out after 100ms/);
    // SIGTERM at 100 ms; child exits well before the 5 s SIGKILL grace.
    expect(elapsed).toBeLessThan(2000);
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });

  it("a fast-completing command is unaffected by the timeout", async () => {
    const src = new InlineToolSource([
      {
        type: "command",
        name: "echo",
        command: "sh",
        args: ["-c", "echo hello"],
        command_timeout_ms: 5_000,
      },
    ]);

    const result = await src.invoke("echo", {});
    expect(result.ok).toBe(true);
    expect(result.stdout?.trim()).toBe("hello");
    expect(result.exit_code).toBe(0);
  });
});

describe("command tool: stdout/stderr size cap", () => {
  it("caps stdout at output_max_bytes and appends a truncation marker", async () => {
    // 256 KiB of 'a' on stdout, 1 byte newline. Cap at 1024 bytes.
    const src = new InlineToolSource([
      {
        type: "command",
        name: "loud",
        command: "sh",
        args: ["-c", "head -c 262144 /dev/zero | tr '\\0' 'a'"],
        output_max_bytes: 1024,
        command_timeout_ms: 10_000,
      },
    ]);

    const result = await src.invoke("loud", {});
    expect(result.ok).toBe(true);
    const stdout = result.stdout ?? "";
    expect(stdout).toMatch(/\[truncated \d+ bytes\]/);
    // Captured payload: cap + marker. The marker is short — keep an
    // upper bound but allow for the trailing marker line.
    expect(stdout.length).toBeGreaterThanOrEqual(1024);
    expect(stdout.length).toBeLessThan(1024 + 64);
  });

  it("does not append a marker when output fits under the cap", async () => {
    const src = new InlineToolSource([
      {
        type: "command",
        name: "quiet",
        command: "sh",
        args: ["-c", "echo done"],
        output_max_bytes: 1024,
        command_timeout_ms: 5_000,
      },
    ]);

    const result = await src.invoke("quiet", {});
    expect(result.ok).toBe(true);
    expect(result.stdout?.trim()).toBe("done");
    expect(result.stdout).not.toMatch(/truncated/);
  });
});

describe("command tool: pre-invoke validation hook", () => {
  it("runs the main command when the validator exits 0", async () => {
    const src = new InlineToolSource([
      {
        type: "command",
        name: "safe",
        command: "sh",
        args: ["-c", "echo ok"],
        validate_command: "sh",
        validate_args: ["-c", "exit 0"],
        command_timeout_ms: 5_000,
      },
    ]);
    const result = await src.invoke("safe", {});
    expect(result.ok).toBe(true);
    expect(result.stdout?.trim()).toBe("ok");
  });

  it("blocks the main command when the validator exits non-zero", async () => {
    const src = new InlineToolSource([
      {
        type: "command",
        name: "blocked",
        command: "sh",
        args: ["-c", "echo should-not-run"],
        validate_command: "sh",
        validate_args: ["-c", "echo validation error && exit 1"],
        command_timeout_ms: 5_000,
      },
    ]);
    const result = await src.invoke("blocked", {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/validation failed/);
    expect(result.stdout).toMatch(/validation error/);
  });
});
