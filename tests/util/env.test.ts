// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { interpolateEnv } from "../../src/util/env.js";

describe("interpolateEnv", () => {
  const snapshot = { ...process.env };

  beforeEach(() => {
    delete process.env.SECURITY_MCP_TEST_TOKEN;
    delete process.env.SECURITY_MCP_TEST_HOST;
    delete process.env.security_mcp_test_lower;
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in snapshot)) delete process.env[k];
    }
    Object.assign(process.env, snapshot);
  });

  it("replaces a single ${VAR} with its env value", () => {
    process.env.SECURITY_MCP_TEST_TOKEN = "abc123";
    expect(interpolateEnv("Bearer ${SECURITY_MCP_TEST_TOKEN}")).toBe("Bearer abc123");
  });

  it("replaces multiple distinct vars in one string", () => {
    process.env.SECURITY_MCP_TEST_TOKEN = "tok";
    process.env.SECURITY_MCP_TEST_HOST = "example.com";
    expect(
      interpolateEnv("https://${SECURITY_MCP_TEST_HOST}/v1?t=${SECURITY_MCP_TEST_TOKEN}"),
    ).toBe("https://example.com/v1?t=tok");
  });

  it("substitutes the same var multiple times", () => {
    process.env.SECURITY_MCP_TEST_TOKEN = "x";
    expect(interpolateEnv("${SECURITY_MCP_TEST_TOKEN}-${SECURITY_MCP_TEST_TOKEN}")).toBe("x-x");
  });

  it("emits empty string for a missing variable (does not throw)", () => {
    expect(interpolateEnv("Bearer ${SECURITY_MCP_TEST_TOKEN}")).toBe("Bearer ");
  });

  it("leaves strings without placeholders untouched", () => {
    expect(interpolateEnv("plain string with no placeholders")).toBe(
      "plain string with no placeholders",
    );
  });

  it("matches case-insensitively (lowercase var names work)", () => {
    process.env.security_mcp_test_lower = "ok";
    expect(interpolateEnv("v=${security_mcp_test_lower}")).toBe("v=ok");
  });

  it("ignores malformed placeholders ($VAR without braces, ${...} without close)", () => {
    process.env.SECURITY_MCP_TEST_TOKEN = "x";
    expect(interpolateEnv("$SECURITY_MCP_TEST_TOKEN")).toBe("$SECURITY_MCP_TEST_TOKEN");
    expect(interpolateEnv("${SECURITY_MCP_TEST_TOKEN")).toBe("${SECURITY_MCP_TEST_TOKEN");
  });

  it("does not interpolate non-alphanumeric placeholder names", () => {
    expect(interpolateEnv("${HAS-DASH}")).toBe("${HAS-DASH}");
    expect(interpolateEnv("${HAS SPACE}")).toBe("${HAS SPACE}");
  });

  it("returns the input unchanged when given an empty string", () => {
    expect(interpolateEnv("")).toBe("");
  });
});
