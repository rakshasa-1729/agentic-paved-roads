// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Server } from "node:http";
import { AddressInfo } from "node:net";
import { isToolAllowed, isCollectionAllowed, buildHttpApp } from "../../src/server.js";
import type { LoadedConfig } from "../../src/config.js";
import { InlineToolSource } from "../../src/sources/command.js";

// Unit tests for isToolAllowed
describe("isToolAllowed", () => {
  it("returns true when RBAC is not configured", () => {
    expect(isToolAllowed(undefined, "alice", "policy_tool")).toBe(true);
  });

  it("allows listed tools for a known principal", () => {
    const rbac = { default_allow: false, rules: { "alice@example.com": ["policy_tool", "tool_registry"] } };
    expect(isToolAllowed(rbac, "alice@example.com", "policy_tool")).toBe(true);
    expect(isToolAllowed(rbac, "alice@example.com", "tool_registry")).toBe(true);
  });

  it("denies unlisted tools for a known principal (even with default_allow=true)", () => {
    const rbac = { default_allow: true, rules: { "alice@example.com": ["policy_tool"] } };
    expect(isToolAllowed(rbac, "alice@example.com", "exception_tool")).toBe(false);
  });

  it("allows all tools via wildcard *", () => {
    const rbac = { default_allow: false, rules: { "ci-bot": ["*"] } };
    expect(isToolAllowed(rbac, "ci-bot", "policy_tool")).toBe(true);
    expect(isToolAllowed(rbac, "ci-bot", "exception_tool")).toBe(true);
    expect(isToolAllowed(rbac, "ci-bot", "anything")).toBe(true);
  });

  it("denies unlisted principals when default_allow is false", () => {
    const rbac = { default_allow: false, rules: { "alice@example.com": ["policy_tool"] } };
    expect(isToolAllowed(rbac, "bob@example.com", "policy_tool")).toBe(false);
  });

  it("allows unlisted principals when default_allow is true", () => {
    const rbac = { default_allow: true, rules: { "alice@example.com": ["policy_tool"] } };
    expect(isToolAllowed(rbac, "bob@example.com", "policy_tool")).toBe(true);
    expect(isToolAllowed(rbac, "bob@example.com", "exception_tool")).toBe(true);
  });

  it("denies when principal is undefined and default_allow is false", () => {
    const rbac = { default_allow: false, rules: {} };
    expect(isToolAllowed(rbac, undefined, "policy_tool")).toBe(false);
  });

  it("allows when principal is undefined and default_allow is true", () => {
    const rbac = { default_allow: true, rules: {} };
    expect(isToolAllowed(rbac, undefined, "policy_tool")).toBe(true);
  });
});

describe("isCollectionAllowed", () => {
  it("returns true when rbac.collections is not configured", () => {
    expect(isCollectionAllowed(undefined, "alice", "policy_tool")).toBe(true);
    expect(isCollectionAllowed({ default_allow: false, rules: {} }, "alice", "policy_tool")).toBe(true);
  });

  it("always returns true for tool_registry (tool-level RBAC covers it)", () => {
    const rbac = { default_allow: false, rules: {}, collections: { default_allow: false, rules: { alice: ["policy_tool"] } } };
    expect(isCollectionAllowed(rbac, "alice", "tool_registry")).toBe(true);
    expect(isCollectionAllowed(rbac, "bob", "tool_registry")).toBe(true);
  });

  it("allows listed collections for a known principal", () => {
    const rbac = { default_allow: false, rules: {}, collections: { default_allow: false, rules: { alice: ["policy_tool", "risk_index"] } } };
    expect(isCollectionAllowed(rbac, "alice", "policy_tool")).toBe(true);
    expect(isCollectionAllowed(rbac, "alice", "risk_index")).toBe(true);
  });

  it("denies unlisted collections for a known principal", () => {
    const rbac = { default_allow: false, rules: {}, collections: { default_allow: false, rules: { alice: ["policy_tool"] } } };
    expect(isCollectionAllowed(rbac, "alice", "risk_index")).toBe(false);
  });

  it("allows all collections via wildcard *", () => {
    const rbac = { default_allow: false, rules: {}, collections: { default_allow: false, rules: { alice: ["*"] } } };
    expect(isCollectionAllowed(rbac, "alice", "policy_tool")).toBe(true);
    expect(isCollectionAllowed(rbac, "alice", "anything")).toBe(true);
  });

  it("denies unlisted principals when default_allow is false", () => {
    const rbac = { default_allow: false, rules: {}, collections: { default_allow: false, rules: { alice: ["policy_tool"] } } };
    expect(isCollectionAllowed(rbac, "bob", "policy_tool")).toBe(false);
  });

  it("allows unlisted principals when default_allow is true", () => {
    const rbac = { default_allow: false, rules: {}, collections: { default_allow: true, rules: { alice: ["policy_tool"] } } };
    expect(isCollectionAllowed(rbac, "bob", "policy_tool")).toBe(true);
    expect(isCollectionAllowed(rbac, "bob", "risk_index")).toBe(true);
  });
});

// E2E tests for RBAC enforcement through the HTTP app
let server: Server;
let baseUrl: string;
const originalLogLevel = process.env.LOG_LEVEL;

const cfg: LoadedConfig = {
  server: { name: "rbac-test", version: "0.0.0" },
  collections: [],
  tools: { registry: new InlineToolSource([]), mcpSources: [] },
  auth: { mode: "iap", trusted_header: "X-Goog-Authenticated-User-Email" },
  rbac: {
    default_allow: false,
    rules: {
      "allowed@example.com": ["tool_registry"],
      "bot@example.com": ["*"],
    },
  },
};

beforeAll(async () => {
  process.env.LOG_LEVEL = "error";
  const app = buildHttpApp(cfg, { allowedHosts: ["127.0.0.1"] });
  server = await new Promise<Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
});

async function callTool(principal: string, tool: string = "tool_registry", action: string = "list"): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "X-Goog-Authenticated-User-Email": principal,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: { action } },
    }),
  });
}

describe("RBAC enforcement (E2E)", () => {
  it("allows a principal with an explicit tool rule", async () => {
    const res = await callTool("allowed@example.com", "tool_registry", "list");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("not authorized");
  });

  it("denies a principal whose rule does not include the requested tool", async () => {
    const res = await callTool("allowed@example.com", "other_tool", "list");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("not authorized");
  });

  it("allows a principal with wildcard * rule", async () => {
    const res = await callTool("bot@example.com", "tool_registry", "list");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("not authorized");
  });

  it("denies an unlisted principal (default_allow: false)", async () => {
    const res = await callTool("unknown@example.com", "tool_registry", "list");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("not authorized");
  });
});
