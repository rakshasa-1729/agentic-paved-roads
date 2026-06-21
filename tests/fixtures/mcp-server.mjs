#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Minimal MCP server for integration tests. Spawns over stdio, exposes
// two test resources + two test tools. Used by tests/sources/mcp.test.ts
// to exercise McpResourceSource / McpToolSource happy paths.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema, ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "test-mcp-server", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} } },
);

const RESOURCES = [
  { uri: "doc:policies", name: "Policies", description: "Org security policies", mimeType: "text/markdown" },
  { uri: "doc:runbook", name: "Runbook", description: "On-call runbook", mimeType: "text/markdown" },
];

const TOOLS = [
  { name: "greet", description: "Echo a greeting", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
  { name: "ping", description: "Return pong", inputSchema: { type: "object" } },
];

server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: RESOURCES }));
server.setRequestHandler(ReadResourceRequestSchema, (req) => ({
  contents: [{ uri: req.params.uri, mimeType: "text/markdown", text: `# ${req.params.uri}\nbody of ${req.params.uri}` }],
}));
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, (req) => {
  if (!TOOLS.find((t) => t.name === req.params.name)) {
    return { isError: true, content: [{ type: "text", text: `unknown tool: ${req.params.name}` }] };
  }
  if (req.params.name === "ping") return { content: [{ type: "text", text: "pong" }] };
  const name = req.params.arguments?.name ?? "world";
  return { content: [{ type: "text", text: `hello ${name}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
