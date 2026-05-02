// SPDX-License-Identifier: Apache-2.0
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { materializePolicies } from "../policies-cache.js";
import { buildHttpApp, buildServer, findPolicyCollection, logStarted } from "../server.js";
import { log } from "../log.js";
import { type AuditRecorder, openAuditLog } from "../audit.js";

const HELP = `Usage: security-mcp serve [options]

Run the MCP server. Default subcommand: invoking \`security-mcp\` with
no arguments runs \`serve\` with all defaults from env.

Options (each overrides the corresponding env var):
  --transport <stdio|http>   Default: \$MCP_TRANSPORT or stdio
  --port <number>            HTTP only. Default: \$PORT or 8080
  --host <addr>              HTTP only. Default: \$HOST or 0.0.0.0
  --config <path>            Default: \$SECURITY_MCP_CONFIG or
                             ./security.config.yaml
  -h, --help                 Show this help.
`;

interface ServeOptions {
  transport?: string;
  port?: number;
  host?: string;
  configPath?: string;
}

function parseArgs(argv: string[]): ServeOptions | { help: true } {
  const opts: ServeOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    if (a === "--transport") opts.transport = argv[++i];
    else if (a === "--port") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) throw new Error(`--port requires a non-negative number`);
      opts.port = n;
    } else if (a === "--host") opts.host = argv[++i];
    else if (a === "--config") opts.configPath = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

export function defaultConfigPath(): string {
  return process.env.SECURITY_MCP_CONFIG ?? "./security.config.yaml";
}

/**
 * Run the MCP server. Subcommand entrypoint: `security-mcp serve`.
 *
 * Transport is selected by `--transport` flag or `MCP_TRANSPORT` env
 * (flag wins), with stdio the default. Returns the process exit code;
 * the dispatcher passes it to `process.exit`.
 *
 * Note that for stdio the server runs forever (server.connect resolves
 * once, but the stdin reader keeps the event loop alive). The returned
 * promise effectively never settles in the happy path.
 */
export async function run(argv: string[]): Promise<number> {
  let opts: ServeOptions | { help: true };
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`security-mcp serve: ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.stderr.write(HELP);
    return 2;
  }
  if ("help" in opts) {
    process.stdout.write(HELP);
    return 0;
  }

  // Default cache dir for materialized .rego policies. Set before
  // loadConfig so YAML configs can reference ${POLICIES_CACHE_DIR} in
  // inline tool args.
  process.env.POLICIES_CACHE_DIR ??= join(tmpdir(), "security-mcp", "policies");
  const policiesCacheDir = process.env.POLICIES_CACHE_DIR!;

  const configPath = opts.configPath ?? defaultConfigPath();
  const cfg = await loadConfig(configPath);

  const audit = openAuditLog(cfg.auditLogPath);

  let materialized = 0;
  const policyCollection = findPolicyCollection(cfg.collections);
  if (policyCollection) {
    try {
      materialized = await materializePolicies(policyCollection.sources, policiesCacheDir);
    } catch (err) {
      log("error", "policies_cache.materialize_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const transport = (opts.transport ?? process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transport === "http" || transport === "streamable-http") {
    const port = opts.port ?? Number(process.env.PORT ?? 8080);
    const host = opts.host ?? process.env.HOST ?? "0.0.0.0";
    await serveHttp(cfg, materialized, policiesCacheDir, configPath, audit, port, host);
  } else if (transport === "stdio") {
    await serveStdio(cfg, materialized, policiesCacheDir, configPath, audit);
  } else {
    throw new Error(`unsupported transport="${transport}" (expected stdio or http)`);
  }
  return 0;
}

async function serveStdio(
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  materialized: number,
  policiesCacheDir: string,
  configPath: string,
  audit: AuditRecorder,
): Promise<void> {
  const server = buildServer(cfg, audit);
  await server.connect(new StdioServerTransport());
  logStarted(cfg, materialized, policiesCacheDir, "stdio", configPath);
}

async function serveHttp(
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  materialized: number,
  policiesCacheDir: string,
  configPath: string,
  audit: AuditRecorder,
  port: number,
  host: string,
): Promise<void> {
  const app = buildHttpApp(cfg, {
    host,
    allowedHosts: process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean),
    audit,
  });

  await new Promise<void>((resolve) => {
    app.listen(port, host, () => {
      logStarted(cfg, materialized, policiesCacheDir, `http :${port}`, configPath);
      resolve();
    });
  });
}
