// SPDX-License-Identifier: Apache-2.0
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { LoadedCollection, LoadedConfig } from "./config.js";
import { handleContent, contentJsonSchema, ContentInputSchema } from "./tools/content.js";
import { handleToolRegistry, toolRegistryJsonSchema, ToolRegistryInputSchema } from "./tools/tool_registry.js";
import { log, withRequestId } from "./log.js";

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
 * Build a fully-wired MCP Server from a loaded config. Cheap — just
 * constructor + handler registration. Safe to call once per stdio
 * process or per-request in stateless HTTP mode.
 */
export function buildServer(cfg: LoadedConfig): Server {
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
      try {
        let result: unknown;
        if (name === "tool_registry") {
          result = await handleToolRegistry(cfg.tools, ToolRegistryInputSchema.parse(args ?? {}));
        } else {
          const collection = collectionByName.get(name);
          if (!collection) throw new Error(`unknown tool: ${name}`);
          result = await handleContent(collection, ContentInputSchema.parse(args ?? {}));
        }
        log("info", "tool.invoked", { tool: name, duration_ms: Date.now() - start });
        return {
          content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("warn", "tool.failed", { tool: name, duration_ms: Date.now() - start, error: message });
        return {
          isError: true,
          content: [{ type: "text", text: message }],
        };
      }
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
export function buildHttpApp(cfg: LoadedConfig, options: { host?: string; allowedHosts?: string[] } = {}): import("express").Express {
  const app = createMcpExpressApp({
    host: options.host,
    allowedHosts: options.allowedHosts,
  });

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", transport: "http" });
  });

  app.post("/mcp", async (req, res) => {
    const server = buildServer(cfg);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
