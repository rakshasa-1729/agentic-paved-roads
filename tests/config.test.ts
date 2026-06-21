// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "config-test-"));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeConfig(name: string, content: string): string {
  const path = join(tmp, name);
  writeFileSync(path, content, "utf8");
  return path;
}

describe("loadConfig — defaults and basic parsing", () => {
  it("loads a minimal empty config with defaults", async () => {
    const cfg = await loadConfig(writeConfig("c.yaml", "{}\n"));
    expect(cfg.server.name).toBe("security-mcp");
    expect(cfg.server.version).toBe("0.1.0");
    expect(cfg.collections).toEqual([]);
    expect(cfg.auth.mode).toBe("none");
    expect(cfg.auditLogPath).toBeUndefined();
  });

  it("honours explicit server.name and version", async () => {
    const cfg = await loadConfig(writeConfig("c.yaml", "server:\n  name: my-mcp\n  version: 1.2.3\n"));
    expect(cfg.server.name).toBe("my-mcp");
    expect(cfg.server.version).toBe("1.2.3");
  });
});

describe("loadConfig — collections and sources", () => {
  it("resolves file source paths relative to the config file's directory", async () => {
    mkdirSync(join(tmp, "policies"), { recursive: true });
    writeFileSync(join(tmp, "policies", "a.md"), "# A");
    const cfg = await loadConfig(writeConfig("c.yaml", `
collections:
  - name: my_policies
    sources:
      - type: file
        path: ./policies
`));
    expect(cfg.collections).toHaveLength(1);
    expect(cfg.collections[0].name).toBe("my_policies");
    const items = await cfg.collections[0].sources[0].list();
    expect(items.map((i) => i.name)).toContain("a.md");
  });

  it("keeps absolute file source paths as-is", async () => {
    const absDir = join(tmp, "abs_policies");
    mkdirSync(absDir, { recursive: true });
    writeFileSync(join(absDir, "x.md"), "# X");
    const cfg = await loadConfig(writeConfig("c.yaml", `
collections:
  - name: abs
    sources:
      - type: file
        path: ${absDir}
`));
    const items = await cfg.collections[0].sources[0].list();
    expect(items.map((i) => i.name)).toContain("x.md");
  });
});

describe("loadConfig — usage_on", () => {
  it("defaults usage_on to 'every' when not specified", async () => {
    const cfg = await loadConfig(writeConfig("c.yaml", `
collections:
  - name: test
    usage: "do something"
    sources: []
`));
    expect(cfg.collections[0].usageOn).toBe("every");
  });

  it("respects usage_on: never", async () => {
    const cfg = await loadConfig(writeConfig("c.yaml", `
collections:
  - name: test
    usage: "do something"
    usage_on: never
    sources: []
`));
    expect(cfg.collections[0].usageOn).toBe("never");
  });
});

describe("loadConfig — validation errors", () => {
  it("rejects duplicate collection names", async () => {
    await expect(
      loadConfig(writeConfig("c.yaml", `
collections:
  - name: dup
    sources: []
  - name: dup
    sources: []
`)),
    ).rejects.toThrow("duplicate collection name: dup");
  });

  it("rejects the reserved name 'tool_registry'", async () => {
    await expect(
      loadConfig(writeConfig("c.yaml", `
collections:
  - name: tool_registry
    sources: []
`)),
    ).rejects.toThrow("collection name 'tool_registry' is reserved");
  });
});

describe("loadConfig — registry_files", () => {
  it("loads tools from registry_files and merges with inline registry", async () => {
    writeFileSync(join(tmp, "tool1.yaml"), "type: command\nname: file_tool\ndescription: from file\ncommand: echo\n");
    const cfg = await loadConfig(writeConfig("c.yaml", `
tools:
  registry:
    - type: command
      name: inline_tool
      description: from inline
      command: echo
  registry_files:
    - tool1.yaml
`));
    const names = (await cfg.tools.registry.list()).map((t) => t.name);
    expect(names).toContain("inline_tool");
    expect(names).toContain("file_tool");
  });

  it("deduplicates tools by name (first definition wins)", async () => {
    writeFileSync(join(tmp, "dup.yaml"), "type: command\nname: shared\ndescription: file copy\ncommand: echo\n");
    const cfg = await loadConfig(writeConfig("c.yaml", `
tools:
  registry:
    - type: command
      name: shared
      description: inline copy
      command: echo
  registry_files:
    - dup.yaml
`));
    const entry = await cfg.tools.registry.describe("shared");
    expect(entry.description).toBe("inline copy");
  });

  it("rejects an invalid tool descriptor with a path in the error message", async () => {
    writeFileSync(join(tmp, "bad.yaml"), "type: command\nname: no_cmd\n");
    await expect(
      loadConfig(writeConfig("c.yaml", `
tools:
  registry_files:
    - bad.yaml
`)),
    ).rejects.toThrow(/invalid tool descriptor at.*bad\.yaml/);
  });
});

describe("loadConfig — audit_log path resolution", () => {
  it("resolves audit_log relative to the config file", async () => {
    const cfg = await loadConfig(writeConfig("c.yaml", "audit_log: ./audit.jsonl\n"));
    expect(cfg.auditLogPath).toBe(join(tmp, "audit.jsonl"));
  });

  it("leaves auditLogPath unset when not configured", async () => {
    const cfg = await loadConfig(writeConfig("c.yaml", "{}\n"));
    expect(cfg.auditLogPath).toBeUndefined();
  });
});

describe("loadConfig — legacy shape migration (smoke)", () => {
  it("migrates legacy `policies` key into a collection via loadConfig", async () => {
    const cfg = await loadConfig(writeConfig("c.yaml", `
policies:
  description: old-style
  sources: []
`));
    expect(cfg.collections).toHaveLength(1);
    expect(cfg.collections[0].name).toBe("policy_tool");
    expect(cfg.collections[0].description).toBe("old-style");
  });
});
