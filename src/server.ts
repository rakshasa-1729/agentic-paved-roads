// SPDX-License-Identifier: Apache-2.0
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { LoadedCollection, LoadedConfig } from "./config.js";
import { handleContent, contentJsonSchema, ContentInputSchema } from "./tools/content.js";
import { handleToolRegistry, toolRegistryJsonSchema, ToolRegistryInputSchema } from "./tools/tool_registry.js";
import { currentPrincipal, log, withRequestId, currentRequestId } from "./log.js";
import { buildAuthMiddleware } from "./auth/index.js";
import { type AuditRecorder, noopAudit } from "./audit.js";
import { httpRequests, renderMetrics, toolDuration, toolInvocations } from "./metrics.js";
import { withSpan } from "./tracing.js";

// The conftest tool conventionally reads .rego files materialized from a
// collection named one of these. First match wins; falls back to no
// materialization (collection-less configs are valid).
const POLICY_COLLECTION_CANDIDATES = ["policy_tool", "policies", "policy"];

function defaultCollectionDescription(name: string): string {
  return `List or fetch items from the \`${name}\` collection.`;
}

export function findPolicyCollection(collections: LoadedCollection[]): LoadedCollection | undefined {
  for (const candidate of POLICY_COLLECTION_CANDIDATES) {
    const match = collections.find((c) => c.name === candidate);
    if (match) return match;
  }
  return undefined;
}

/**
 * RBAC gate: decide whether `principal` is allowed to call `tool`.
 *
 * - When `rbac` is not configured, all tools are allowed (backward compat).
 * - When `rbac` is configured, look up the principal in `rules`. If listed,
 *   only their specified tools (or `*`) are allowed. If not listed, fall
 *   through to `default_allow` (false = deny, true = allow).
 */
export function isToolAllowed(
  rbac: { default_allow: boolean; rules: Record<string, string[]> } | undefined,
  principal: string | undefined,
  tool: string,
): boolean {
  if (!rbac) return true;
  const rules = rbac.rules[principal ?? ""];
  if (rules) return rules.includes("*") || rules.includes(tool);
  return rbac.default_allow;
}

/**
 * Build a fully-wired MCP Server from a loaded config. Cheap — just
 * constructor + handler registration. Safe to call once per stdio
 * process or per-request in stateless HTTP mode.
 */
export function buildServer(cfg: LoadedConfig, audit: AuditRecorder = noopAudit()): Server {
  const server = new Server(
    { name: cfg.server.name, version: cfg.server.version },
    { capabilities: { tools: {} }, instructions: cfg.server.instructions },
  );

  const collectionByName = new Map<string, LoadedCollection>();
  for (const c of cfg.collections) collectionByName.set(c.name, c);

  const tools = [
    ...cfg.collections.map((c) => ({
      name: c.name,
      description: c.description ?? defaultCollectionDescription(c.name),
      inputSchema: contentJsonSchema,
    })),
    {
      name: "tool_registry",
      description:
        cfg.tools.description ??
        "List, describe, and invoke tools registered with this server (e.g., conftest, exception_tool).",
      inputSchema: toolRegistryJsonSchema,
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    return withRequestId(undefined, async () => {
      const start = Date.now();
      const action = typeof (args as { action?: unknown })?.action === "string" ? (args as { action: string }).action : undefined;
      return withSpan("mcp.tool.call", { "mcp.tool": name, "mcp.action": action, "mcp.auth_mode": cfg.auth.mode, "mcp.principal": currentPrincipal() }, async (span) => {
      if (!isToolAllowed(cfg.rbac, currentPrincipal(), name)) {
        const duration_ms = Date.now() - start;
        const msg = `principal "${currentPrincipal() ?? ""}" is not authorized to call tool "${name}"`;
        log("warn", "authz.denied", { tool: name, principal: currentPrincipal(), duration_ms });
        toolInvocations.inc({ tool: name, ok: "false" });
        audit.record({
          request_id: currentRequestId(),
          principal: currentPrincipal(),
          auth_mode: cfg.auth.mode,
          tool: name,
          action,
          args,
          ok: false,
          duration_ms,
          error: msg,
        });
        return { isError: true, content: [{ type: "text", text: msg }] };
      }
      try {
        let result: unknown;
        if (name === "tool_registry") {
          result = await handleToolRegistry(cfg.tools, ToolRegistryInputSchema.parse(args ?? {}));
        } else {
          const collection = collectionByName.get(name);
          if (!collection) throw new Error(`unknown tool: ${name}`);
          result = await handleContent(collection, ContentInputSchema.parse(args ?? {}));
        }
        const duration_ms = Date.now() - start;
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        span.setAttribute("mcp.response_bytes", Buffer.byteLength(text));
        log("info", "tool.invoked", { tool: name, duration_ms });
        toolInvocations.inc({ tool: name, ok: "true" });
        toolDuration.observe({ tool: name, ok: "true" }, duration_ms);
        audit.record({
          request_id: currentRequestId(),
          principal: currentPrincipal(),
          auth_mode: cfg.auth.mode,
          tool: name,
          action,
          args,
          ok: true,
          duration_ms,
          response_bytes: Buffer.byteLength(text),
        });
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const duration_ms = Date.now() - start;
        log("warn", "tool.failed", { tool: name, duration_ms, error: message });
        toolInvocations.inc({ tool: name, ok: "false" });
        toolDuration.observe({ tool: name, ok: "false" }, duration_ms);
        audit.record({
          request_id: currentRequestId(),
          principal: currentPrincipal(),
          auth_mode: cfg.auth.mode,
          tool: name,
          action,
          args,
          ok: false,
          duration_ms,
          error: message,
        });
        return { isError: true, content: [{ type: "text", text: message }] };
      }
      });
    });
  });

  return server;
}

/**
 * Build the express app that fronts the streamable-HTTP transport.
 * Pure (no listen) so tests can bind it to an ephemeral port without
 * dragging in supertest.
 *
 * Stateless: each POST /mcp gets its own Server + transport. Server
 * construction is cheap; the heavy lift (loadConfig + policies cache)
 * happened once at process start. The trade-off is no server-pushed
 * notifications across the connection, which we don't use anyway.
 */
export function buildHttpApp(
  cfg: LoadedConfig,
  options: { host?: string; allowedHosts?: string[]; audit?: AuditRecorder } = {},
): import("express").Express {
  const app = createMcpExpressApp({
    host: options.host,
    allowedHosts: options.allowedHosts,
  });
  const audit = options.audit ?? noopAudit();

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", transport: "http" });
  });

  // Auth runs on /mcp and (optionally) /metrics. /healthz stays open so
  // liveness probes and load-balancer health checks don't need credentials.
  const authMiddleware = buildAuthMiddleware(cfg.auth);
  const protectMetrics = cfg.auth.mode !== "none" && (cfg.metrics_protect ?? true);

  app.get("/metrics", ...(protectMetrics ? [authMiddleware] : []), async (_req, res) => {
    res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    res.status(200).send(await renderMetrics());
  });

  app.post("/mcp", authMiddleware, async (req, res) => {
    const server = buildServer(cfg, audit);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("finish", () => httpRequests.inc({ status_class: `${Math.floor(res.statusCode / 100)}xx` }));
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);
      });
    } catch (err) {
      log("error", "http.request_error", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode rejects GET / DELETE per the MCP spec.
  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless transport)" },
      id: null,
    });
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless transport)" },
      id: null,
    });
  });

  return app;
}

export function logStarted(cfg: LoadedConfig, materialized: number, policiesCacheDir: string, transportLabel: string, configPath: string): void {
  log("info", "server.started", {
    transport: transportLabel,
    config: configPath,
    organization: cfg.server.organization,
    collections: cfg.collections.map((c) => ({ name: c.name, sources: c.sources.length })),
    tool_registry_mcp_sources: cfg.tools.mcpSources.length,
    policies_cached: materialized,
    policies_cache_dir: policiesCacheDir,
  });
}
