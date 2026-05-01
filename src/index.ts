#!/usr/bin/env node
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { LoadedCollection } from "./config.js";
import { loadConfig } from "./config.js";
import { materializePolicies } from "./policies-cache.js";
import { handleContent, contentJsonSchema, ContentInputSchema } from "./tools/content.js";
import { handleToolRegistry, toolRegistryJsonSchema, ToolRegistryInputSchema } from "./tools/tool_registry.js";

const CONFIG_PATH = process.env.SECURITY_MCP_CONFIG ?? "./security.config.yaml";

// Default cache dir for materialized .rego policies. Set before loadConfig
// so YAML configs can reference ${POLICIES_CACHE_DIR} in inline tool args.
process.env.POLICIES_CACHE_DIR ??= join(tmpdir(), "security-mcp", "policies");

// The conftest tool conventionally reads .rego files materialized from a
// collection named one of these. First match wins; falls back to no
// materialization (collection-less configs are valid).
const POLICY_COLLECTION_CANDIDATES = ["policy_tool", "policies", "policy"];

function defaultCollectionDescription(name: string): string {
  return `List or fetch items from the \`${name}\` collection.`;
}

function findPolicyCollection(collections: LoadedCollection[]): LoadedCollection | undefined {
  for (const candidate of POLICY_COLLECTION_CANDIDATES) {
    const match = collections.find((c) => c.name === candidate);
    if (match) return match;
  }
  return undefined;
}

async function main(): Promise<void> {
  const cfg = await loadConfig(CONFIG_PATH);

  const policiesCacheDir = process.env.POLICIES_CACHE_DIR!;
  let materialized = 0;
  const policyCollection = findPolicyCollection(cfg.collections);
  if (policyCollection) {
    try {
      materialized = await materializePolicies(policyCollection.sources, policiesCacheDir);
    } catch (err) {
      process.stderr.write(
        `security-mcp: materializePolicies failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

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
    try {
      let result: unknown;
      if (name === "tool_registry") {
        result = await handleToolRegistry(cfg.tools, ToolRegistryInputSchema.parse(args ?? {}));
      } else {
        const collection = collectionByName.get(name);
        if (!collection) throw new Error(`unknown tool: ${name}`);
        result = await handleContent(collection, ContentInputSchema.parse(args ?? {}));
      }
      return {
        content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const collectionSummary = cfg.collections.length === 0
    ? "collections=0"
    : `collections=${cfg.collections.length}[${cfg.collections.map((c) => `${c.name}:${c.sources.length}`).join(",")}]`;

  process.stderr.write(
    `security-mcp started (config=${CONFIG_PATH}, org=${cfg.server.organization ?? "n/a"}, ` +
      `${collectionSummary}, ` +
      `tools=registry+${cfg.tools.mcpSources.length} mcp, ` +
      `policies_cached=${materialized}@${policiesCacheDir})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`security-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
