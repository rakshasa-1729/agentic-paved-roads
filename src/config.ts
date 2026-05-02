// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import yaml from "yaml";
import type { Source, ToolSource } from "./sources/types.js";
import { FileSource } from "./sources/file.js";
import { HttpSource } from "./sources/http.js";
import { McpResourceSource, McpToolSource } from "./sources/mcp.js";
import { GitHubSource } from "./sources/github.js";
import { OpaBundleSource } from "./sources/opa-bundle.js";
import { InlineToolSource } from "./sources/command.js";
import { log } from "./log.js";

const FileSrc = z.object({
  type: z.literal("file"),
  name: z.string().optional(),
  path: z.string(),
  patterns: z.array(z.string()).optional(),
});

const HttpSrc = z.object({
  type: z.literal("http"),
  name: z.string().optional(),
  base_url: z.string(),
  list_path: z.string().optional(),
  get_path: z.string().optional(),
  headers: z.record(z.string()).optional(),
  method: z.enum(["GET", "POST"]).optional(),
  name_field: z.string().optional(),
  content_field: z.string().optional(),
  items_field: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
});

const McpSrc = z.object({
  type: z.literal("mcp"),
  name: z.string().optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  connect_timeout_ms: z.number().int().positive().optional(),
});

const GitHubSrc = z.object({
  type: z.literal("github"),
  name: z.string().optional(),
  owner: z.string(),
  repo: z.string(),
  ref: z.string().optional(),
  path: z.string().optional(),
  patterns: z.array(z.string()).optional(),
  token: z.string().optional(),
  api_base_url: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
});

const OpaBundleSrc = z.object({
  type: z.literal("opa-bundle"),
  name: z.string().optional(),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  patterns: z.array(z.string()).optional(),
  timeout_ms: z.number().int().positive().optional(),
  refresh_ttl_ms: z.number().int().positive().optional(),
});

const ContentSource = z.discriminatedUnion("type", [FileSrc, HttpSrc, McpSrc, GitHubSrc, OpaBundleSrc]);

const InlineCommandTool = z.object({
  type: z.literal("command"),
  name: z.string(),
  description: z.string().optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  stdin: z.boolean().optional(),
  input_schema: z.record(z.unknown()).optional(),
  command_timeout_ms: z.number().int().positive().optional(),
  output_max_bytes: z.number().int().positive().optional(),
});

const InlineHttpTool = z.object({
  type: z.literal("http"),
  name: z.string(),
  description: z.string().optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  url: z.string(),
  headers: z.record(z.string()).optional(),
  body_template: z.unknown().optional(),
  input_schema: z.record(z.unknown()).optional(),
  timeout_ms: z.number().int().positive().optional(),
});

const InlineTool = z.discriminatedUnion("type", [InlineCommandTool, InlineHttpTool]);

const Collection = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/i, "collection name must be a valid identifier (letters, digits, underscores)"),
  description: z.string().optional(),
  // Per-collection directive that gets attached to every list/get response.
  // Use this to make follow-up actions inescapable — e.g. "after reading
  // any policy, you MUST run conftest before opening a PR." The model sees
  // it on every call, not just once at tools/list time.
  usage: z.string().optional(),
  sources: z.array(ContentSource).default([]),
});

const ToolsCategory = z.object({
  description: z.string().optional(),
  registry: z.array(InlineTool).default([]),
  registry_files: z.array(z.string()).default([]),
  sources: z.array(McpSrc).default([]),
});

const ServerInfo = z.object({
  name: z.string().default("security-mcp"),
  version: z.string().default("0.1.0"),
  organization: z.string().optional(),
  instructions: z.string().optional(),
});

// Auth shape for the streamable-HTTP transport. `none` is the default
// (safe for stdio, intended for behind a closed network or already-
// authenticated edge proxy). `iap` trusts a configured platform header.
// `oidc` verifies a Bearer JWT against a configured issuer + audience.
const AuthNone = z.object({ mode: z.literal("none") });
const AuthIap = z.object({
  mode: z.literal("iap"),
  trusted_header: z.string().default("X-Goog-Authenticated-User-Email"),
});
const AuthOidc = z.object({
  mode: z.literal("oidc"),
  issuer: z.string().url(),
  audience: z.union([z.string(), z.array(z.string())]),
  jwks_uri: z.string().url().optional(),
});
const AuthConfig = z.discriminatedUnion("mode", [AuthNone, AuthIap, AuthOidc]);
export type AuthConfigType = z.infer<typeof AuthConfig>;

const ConfigSchema = z.object({
  server: ServerInfo.default({}),
  collections: z.array(Collection).default([]),
  tools: ToolsCategory.default({ registry: [], sources: [] }),
  auth: AuthConfig.default({ mode: "none" }),
  /** Path to a JSONL file. One redacted line per tools/call. */
  audit_log: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface LoadedCollection {
  name: string;
  description?: string;
  usage?: string;
  sources: Source[];
}

/** @deprecated alias kept for code that took LoadedCategory pre-Move-0. */
export type LoadedCategory = LoadedCollection;

export interface LoadedToolsCategory {
  description?: string;
  registry: InlineToolSource;
  mcpSources: ToolSource[];
}

export interface LoadedConfig {
  server: Config["server"];
  collections: LoadedCollection[];
  tools: LoadedToolsCategory;
  auth: AuthConfigType;
  auditLogPath?: string;
}

/**
 * Pre-Move-0, the config had top-level `policies` / `risk` / `paved_roads`
 * keys, each translated into one MCP tool with a hard-coded name. Move 0
 * unifies those into a generic `collections: [{ name, sources, ... }]`
 * array. This translator keeps old configs working: it migrates legacy
 * keys into entries in `collections` (using the same tool names the
 * server used to register), then deletes the legacy keys so the new
 * schema can validate cleanly. New-shape configs pass through untouched.
 */
const LEGACY_KEY_TO_COLLECTION_NAME: Record<string, string> = {
  policies: "policy_tool",
  risk: "risk_index",
  paved_roads: "paved_road_tool",
};

export function translateLegacyShape(raw: unknown): unknown {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const root = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...root };

  const existing: Array<Record<string, unknown>> = Array.isArray(out.collections)
    ? [...(out.collections as Array<Record<string, unknown>>)]
    : [];
  const haveByName = new Set(existing.map((c) => String(c.name)));

  let migrated = false;
  for (const [legacyKey, collectionName] of Object.entries(LEGACY_KEY_TO_COLLECTION_NAME)) {
    const cat = out[legacyKey];
    if (cat && typeof cat === "object" && !Array.isArray(cat)) {
      if (!haveByName.has(collectionName)) {
        const c = cat as Record<string, unknown>;
        existing.push({
          name: collectionName,
          description: c.description,
          sources: Array.isArray(c.sources) ? c.sources : [],
        });
        haveByName.add(collectionName);
        migrated = true;
      }
      delete out[legacyKey];
    }
  }

  if (migrated) {
    out.collections = existing;
    log("warn", "config.legacy_shape_migrated", {
      message:
        "migrated legacy top-level keys (policies/risk/paved_roads) into collections[]. " +
        "Update your config to use the new shape — see docs/CONFIGURING.md.",
    });
  } else if (existing.length > 0) {
    out.collections = existing;
  }

  return out;
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const abs = resolve(path);
  const baseDir = dirname(abs);
  const raw = await readFile(abs, "utf8");
  const parsed = translateLegacyShape(yaml.parse(raw) ?? {});
  const cfg = ConfigSchema.parse(parsed);

  const dupNames = new Set<string>();
  for (const c of cfg.collections) {
    if (dupNames.has(c.name)) {
      throw new Error(`duplicate collection name: ${c.name}`);
    }
    if (c.name === "tool_registry") {
      throw new Error(`collection name 'tool_registry' is reserved`);
    }
    dupNames.add(c.name);
  }

  const resolvePath = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));

  const buildCollection = (col: z.infer<typeof Collection>): LoadedCollection => ({
    name: col.name,
    description: col.description,
    usage: col.usage,
    sources: col.sources.map((s) => {
      if (s.type === "file") return new FileSource({ ...s, path: resolvePath(s.path) });
      if (s.type === "http") return new HttpSource(s);
      if (s.type === "github") return new GitHubSource(s);
      if (s.type === "opa-bundle") return new OpaBundleSource(s);
      return new McpResourceSource(s);
    }),
  });

  const fileTools = await Promise.all(
    cfg.tools.registry_files.map(async (rel) => {
      const filePath = resolvePath(rel);
      const text = await readFile(filePath, "utf8");
      const parsedTool = yaml.parse(text);
      try {
        return InlineTool.parse(parsedTool);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`invalid tool descriptor at ${filePath}: ${reason}`);
      }
    }),
  );

  const dedupTools: typeof fileTools = [];
  const seenTool = new Set<string>();
  for (const t of [...cfg.tools.registry, ...fileTools]) {
    if (seenTool.has(t.name)) continue;
    seenTool.add(t.name);
    dedupTools.push(t);
  }

  return {
    server: cfg.server,
    collections: cfg.collections.map(buildCollection),
    tools: {
      description: cfg.tools.description,
      registry: new InlineToolSource(dedupTools),
      mcpSources: cfg.tools.sources.map((s) => new McpToolSource(s)),
    },
    auth: cfg.auth,
    auditLogPath: cfg.audit_log ? resolvePath(cfg.audit_log) : undefined,
  };
}
