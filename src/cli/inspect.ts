// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";

const HELP = `Usage: security-mcp inspect [options]

Connect to the MCP server your config would build, list its tools, and
optionally invoke one. Runs entirely in-process — no port, no child
process, no docker. Useful for "did this config actually wire what I
expected?" without setting up an editor.

Options:
  --config <path>   Default: \$SECURITY_MCP_CONFIG or ./security.config.yaml
  --tool <name>     Print this tool's full description + input schema.
  --call <name>     Invoke this tool. Pair with --args (JSON).
  --args <json>     Arguments to pass to --call (default: {}).
  --json            Machine-readable output (one JSON object).
  -h, --help        Show this help.

Examples:
  security-mcp inspect                                  # list tools
  security-mcp inspect --tool policy_tool               # describe one
  security-mcp inspect --call policy_tool --args '{"action":"list"}'
  security-mcp inspect --json | jq                      # machine output
`;

interface InspectOptions {
  configPath: string;
  describeTool?: string;
  callTool?: string;
  callArgs?: string;
  json: boolean;
}

function parseArgs(argv: string[]): InspectOptions | { help: true } {
  const opts: InspectOptions = {
    configPath: process.env.SECURITY_MCP_CONFIG ?? "./security.config.yaml",
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    if (a === "--config") opts.configPath = argv[++i];
    else if (a === "--tool") opts.describeTool = argv[++i];
    else if (a === "--call") opts.callTool = argv[++i];
    else if (a === "--args") opts.callArgs = argv[++i];
    else if (a === "--json") opts.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

export async function run(argv: string[]): Promise<number> {
  let opts: InspectOptions | { help: true };
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`security-mcp inspect: ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.stderr.write(HELP);
    return 2;
  }
  if ("help" in opts) {
    process.stdout.write(HELP);
    return 0;
  }

  const abs = resolve(opts.configPath);
  if (!existsSync(abs)) {
    process.stderr.write(`security-mcp inspect: config not found: ${abs}\n`);
    return 1;
  }

  const cfg = await loadConfig(abs);
  const server = buildServer(cfg);

  // Wire up an in-memory transport pair so we can drive the server
  // through the SDK Client without spawning a process or binding a
  // port.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "security-mcp-inspect", version: "0.0.0" }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    if (opts.callTool) return await invokeAndPrint(client, opts);
    if (opts.describeTool) return await describeAndPrint(client, opts);
    return await listAndPrint(client, opts);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

async function listAndPrint(client: Client, opts: InspectOptions): Promise<number> {
  const res = await client.listTools();
  const tools = res.tools ?? [];
  if (opts.json) {
    process.stdout.write(JSON.stringify({ tools }, null, 2) + "\n");
    return 0;
  }
  if (tools.length === 0) {
    process.stdout.write("(no tools registered)\n");
    return 0;
  }
  const widest = Math.max(...tools.map((t) => t.name.length));
  process.stdout.write(`tools (${tools.length}):\n`);
  for (const t of tools) {
    const desc = (t.description ?? "").split("\n")[0].slice(0, 80);
    process.stdout.write(`  ${t.name.padEnd(widest)}  ${desc}\n`);
  }
  return 0;
}

async function describeAndPrint(client: Client, opts: InspectOptions): Promise<number> {
  const res = await client.listTools();
  const tool = (res.tools ?? []).find((t) => t.name === opts.describeTool);
  if (!tool) {
    process.stderr.write(`security-mcp inspect: tool not found: ${opts.describeTool}\n`);
    return 1;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(tool, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`${tool.name}\n`);
  if (tool.description) process.stdout.write(`\n${tool.description}\n`);
  process.stdout.write(`\ninput schema:\n${JSON.stringify(tool.inputSchema, null, 2)}\n`);
  return 0;
}

async function invokeAndPrint(client: Client, opts: InspectOptions): Promise<number> {
  let args: Record<string, unknown> = {};
  if (opts.callArgs) {
    try {
      const parsed = JSON.parse(opts.callArgs);
      if (typeof parsed !== "object" || parsed === null) throw new Error("must be a JSON object");
      args = parsed as Record<string, unknown>;
    } catch (err) {
      process.stderr.write(`security-mcp inspect: --args must be a JSON object: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }
  const res = await client.callTool({ name: opts.callTool!, arguments: args });
  if (opts.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return res.isError ? 1 : 0;
  }
  const content = (res.content ?? []) as Array<{ text?: string }>;
  for (const c of content) {
    if (typeof c.text === "string") process.stdout.write(c.text + "\n");
  }
  return res.isError ? 1 : 0;
}
