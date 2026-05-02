// SPDX-License-Identifier: Apache-2.0
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { materializePolicies } from "../policies-cache.js";
import { buildHttpApp, buildServer, findPolicyCollection, logStarted } from "../server.js";
import { log } from "../log.js";

export function defaultConfigPath(): string {
  return process.env.SECURITY_MCP_CONFIG ?? "./security.config.yaml";
}

/**
 * Run the MCP server. Subcommand entrypoint: `security-mcp serve`.
 *
 * Transport is selected by `MCP_TRANSPORT` ({stdio,http}), with stdio
 * the default. Returns the process exit code; the dispatcher passes it
 * to `process.exit`.
 *
 * Note that for stdio the server runs forever (server.connect resolves
 * once, but the stdin reader keeps the event loop alive). The returned
 * promise effectively never settles in the happy path.
 */
export async function run(_args: string[]): Promise<number> {
  // Default cache dir for materialized .rego policies. Set before
  // loadConfig so YAML configs can reference ${POLICIES_CACHE_DIR} in
  // inline tool args.
  process.env.POLICIES_CACHE_DIR ??= join(tmpdir(), "security-mcp", "policies");
  const policiesCacheDir = process.env.POLICIES_CACHE_DIR!;

  const configPath = defaultConfigPath();
  const cfg = await loadConfig(configPath);

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

  const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transport === "http" || transport === "streamable-http") {
    await serveHttp(cfg, materialized, policiesCacheDir, configPath);
  } else if (transport === "stdio") {
    await serveStdio(cfg, materialized, policiesCacheDir, configPath);
  } else {
    throw new Error(`unsupported MCP_TRANSPORT="${transport}" (expected stdio or http)`);
  }
  return 0;
}

async function serveStdio(
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  materialized: number,
  policiesCacheDir: string,
  configPath: string,
): Promise<void> {
  const server = buildServer(cfg);
  await server.connect(new StdioServerTransport());
  logStarted(cfg, materialized, policiesCacheDir, "stdio", configPath);
}

async function serveHttp(
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  materialized: number,
  policiesCacheDir: string,
  configPath: string,
): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "0.0.0.0";
  const app = buildHttpApp(cfg, {
    host,
    allowedHosts: process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean),
  });

  await new Promise<void>((resolve) => {
    app.listen(port, host, () => {
      logStarted(cfg, materialized, policiesCacheDir, `http :${port}`, configPath);
      resolve();
    });
  });
}
