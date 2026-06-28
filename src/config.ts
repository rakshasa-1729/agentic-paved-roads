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
import { GitLabSource } from "./sources/gitlab.js";
import { OpaBundleSource } from "./sources/opa-bundle.js";
import { LocalCmdSource } from "./sources/local-cmd.js";
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
  cache_ttl_ms: z.number().int().positive().optional(),
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
  cache_ttl_ms: z.number().int().positive().optional(),
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

const GitLabSrc = z.object({
  type: z.literal("gitlab"),
  name: z.string().optional(),
  project: z.string(),
  ref: z.string().optional(),
  path: z.string().optional(),
  patterns: z.array(z.string()).optional(),
  token: z.string().optional(),
  api_base_url: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
  cache_ttl_ms: z.number().int().positive().optional(),
});

const LocalCmdSrc = z.object({
  type: z.literal("local-cmd"),
  name: z.string().optional(),
  list_command: z.string(),
  list_args: z.array(z.string()).optional(),
  get_command: z.string(),
  get_args: z.array(z.string()).optional(),
  format: z.enum(["lines", "json"]).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  timeout_ms: z.number().int().positive().optional(),
  output_max_bytes: z.number().int().positive().optional(),
});

const ContentSource = z.discriminatedUnion("type", [
  FileSrc,
  HttpSrc,
  McpSrc,
  GitHubSrc,
  OpaBundleSrc,
  GitLabSrc,
  LocalCmdSrc,
]);

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
  usage: z.string().optional(),
  validate_command: z.string().optional(),
  validate_args: z.array(z.string()).optional(),
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
  output_max_bytes: z.number().int().positive().optional(),
  usage: z.string().optional(),
});

export const InlineTool = z.discriminatedUnion("type", [InlineCommandTool, InlineHttpTool]);

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
  // When (if ever) `usage` is attached to responses. `every` is the
  // default (and the historical behavior) — the directive repeats on
  // every list/get so the model can't skip it. `never` drops it
  // entirely, useful for context-budget-sensitive hosts where the
  // directive is already in the tool description at tools/list time.
  // There is intentionally no `first`-only mode: the HTTP transport is
  // stateless and keeps no per-session memory of which calls have
  // already seen the directive.
  usage_on: z.enum(["every", "never"]).optional(),
  sources: z.array(ContentSource).default([]),
});

const ToolsCategory = z.object({
  description: z.string().optional(),
  usage: z.string().optional(),
  usage_on: z.enum(["every", "never"]).optional(),
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
// `api_key` validates a shared secret from a configured header against
// a list of keys supplied via an environment variable.
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
const AuthApiKey = z.object({
  mode: z.literal("api_key"),
  header_name: z.string().default("X-API-Key"),
  keys_env: z.string().default("SECURITY_MCP_API_KEYS"),
});

/**
 * mTLS auth mode: extract the principal from the verified client
 * certificate's subject CN. Requires the `tls` config section — without
 * it, no client cert is presented. The TLS layer rejects unauthorized
 * peers before the application sees them; the middleware extracts the
 * principal from the ones that made it through.
 */
const AuthMtls = z.object({ mode: z.literal("mtls") });

const AuthConfig = z.discriminatedUnion("mode", [AuthNone, AuthIap, AuthOidc, AuthApiKey, AuthMtls]);
export type AuthConfigType = z.infer<typeof AuthConfig>;

/**
 * TLS transport config. When set, `serveHttp` runs as an HTTPS server
 * (`https.createServer`) and optionally verifies client certificates
 * against the provided CA bundle. Use with `auth.mode: mtls` for
 * cert-based principal extraction, or with any other auth mode for
 * defense-in-depth.
 */
const TlsConfig = z.object({
  cert: z.string(),
  key: z.string(),
  ca: z.string().optional(),
  request_cert: z.boolean().default(true),
  reject_unauthorized: z.boolean().default(true),
});
export type TlsConfigType = z.infer<typeof TlsConfig>;

export const ConfigSchema = z.object({
  server: ServerInfo.default({}),
  collections: z.array(Collection).default([]),
  tools: ToolsCategory.default({ registry: [], sources: [] }),
  auth: AuthConfig.default({ mode: "none" }),
  /** Path to a JSONL file. One redacted line per tools/call. */
  audit_log: z.string().optional(),
  /** When true, tool-call args are recorded verbatim in the audit log
   * (in addition to the hash). Default: false — args are hashed only,
   * preventing sensitive input from leaking into the audit trail. */
  audit_record_args: z.boolean().default(false),
  metrics_protect: z.boolean().default(true),
  /** TLS transport: enable HTTPS + optional client-cert verification.
   * When set, serveHttp runs as https.createServer. Paths are relative
   * to the config file (resolved at load time). */
  tls: TlsConfig.optional(),
  rate_limit: z
    .object({
      window_ms: z.number().int().positive().default(60_000),
      max_requests: z.number().int().positive().default(100),
    })
    .optional(),
  /** RBAC: restrict which tools a principal can call. When absent,
   * all tools are available to all principals. When present, each
   * principal is looked up in `rules`; their listed tools (or `*`)
   * are allowed. Principals not in `rules` fall through to
   * `default_allow`. Securing by default: `default_allow` is false
   * (deny unlisted principals) unless overridden. */
  rbac: z
    .object({
      default_allow: z.boolean().default(false),
      rules: z.record(z.array(z.string())).default({}),
      collections: z
        .object({
          default_allow: z.boolean().default(false),
          rules: z.record(z.array(z.string())).default({}),
        })
        .optional(),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface LoadedCollection {
  name: string;
  description?: string;
  usage?: string;
  usageOn: "every" | "never";
  sources: Source[];
}

/** @deprecated alias kept for code that took LoadedCategory pre-Move-0. */
export type LoadedCategory = LoadedCollection;

export interface LoadedToolsCategory {
  description?: string;
  usage?: string;
  usageOn: "every" | "never";
  registry: InlineToolSource;
  mcpSources: ToolSource[];
}

export interface LoadedConfig {
  server: Config["server"];
  collections: LoadedCollection[];
  tools: LoadedToolsCategory;
  auth: AuthConfigType;
  auditLogPath?: string;
  auditRecordArgs?: boolean;
  metrics_protect?: boolean;
  /** TLS config (resolved paths). When set, serveHttp uses HTTPS. */
  tlsConfig?: { cert: string; key: string; ca?: string; request_cert: boolean; reject_unauthorized: boolean };
  rateLimit?: { window_ms: number; max_requests: number };
  rbac?: {
    default_allow: boolean;
    rules: Record<string, string[]>;
    collections?: { default_allow: boolean; rules: Record<string, string[]> };
  };
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
    usageOn: col.usage_on ?? "every",
    sources: col.sources.map((s) => {
      if (s.type === "file") return new FileSource({ ...s, path: resolvePath(s.path) });
      if (s.type === "http") return new HttpSource(s);
      if (s.type === "github") return new GitHubSource(s);
      if (s.type === "gitlab") return new GitLabSource(s);
      if (s.type === "opa-bundle") return new OpaBundleSource(s);
      if (s.type === "local-cmd") return new LocalCmdSource(s);
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
      usage: cfg.tools.usage,
      usageOn: cfg.tools.usage_on ?? "every",
      registry: new InlineToolSource(dedupTools),
      mcpSources: cfg.tools.sources.map((s) => new McpToolSource(s)),
    },
    auth: cfg.auth,
    auditLogPath: cfg.audit_log ? resolvePath(cfg.audit_log) : undefined,
    auditRecordArgs: cfg.audit_record_args,
    metrics_protect: cfg.metrics_protect,
    tlsConfig: cfg.tls
      ? {
          cert: resolvePath(cfg.tls.cert),
          key: resolvePath(cfg.tls.key),
          ca: cfg.tls.ca ? resolvePath(cfg.tls.ca) : undefined,
          request_cert: cfg.tls.request_cert,
          reject_unauthorized: cfg.tls.reject_unauthorized,
        }
      : undefined,
    rateLimit: cfg.rate_limit,
    rbac: cfg.rbac
      ? {
          default_allow: cfg.rbac.default_allow,
          rules: cfg.rbac.rules,
          collections: cfg.rbac.collections
            ? { default_allow: cfg.rbac.collections.default_allow, rules: cfg.rbac.collections.rules }
            : undefined,
        }
      : undefined,
  };
}
