// SPDX-License-Identifier: Apache-2.0
import { type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type LoadedConfig } from "../config.js";
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

  const audit = openAuditLog(cfg.auditLogPath, { recordArgs: cfg.auditRecordArgs });

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

  process.on("SIGHUP", () => {
    log("info", "server.sighup_ignored", {
      transport: "stdio",
      reason: "stdio transport does not support hot-reload; restart the process to pick up config changes",
    });
  });

  installSignalHandlers({
    label: "stdio",
    drain: async () => {
      // stdio is single-session; nothing to drain. Just close the
      // server (and pending audit writes via audit.close in the
      // shared handler).
      await server.close().catch(() => undefined);
    },
    audit,
  });
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
  let currentCfg = cfg;
  let currentAudit: AuditRecorder = audit;
  let currentMaterialized = materialized;
  let currentServer: HttpServer;

  function buildHttpAppForCfg(c: LoadedConfig, a: AuditRecorder) {
    return buildHttpApp(c, {
      host,
      allowedHosts: process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean),
      audit: a,
    });
  }

  /** Build https.createServer options from the TLS config. Returns
   * undefined when TLS is not configured (caller uses plain HTTP). */
  function buildTlsOptions(tls: LoadedConfig["tlsConfig"]): Record<string, unknown> | undefined {
    if (!tls) return undefined;
    try {
      return {
        cert: readFileSync(tls.cert),
        key: readFileSync(tls.key),
        ca: tls.ca ? readFileSync(tls.ca) : undefined,
        requestCert: tls.request_cert,
        rejectUnauthorized: tls.reject_unauthorized,
      };
    } catch (err) {
      log("error", "tls.cert_read_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Listen on port/host — HTTPS when TLS is configured, HTTP otherwise. */
  function listenWithApp(app: import("express").Express, tls: LoadedConfig["tlsConfig"]): Promise<HttpServer> {
    const tlsOpts = buildTlsOptions(tls);
    return new Promise((resolve, reject) => {
      if (tlsOpts) {
        const httpsServer = createHttpsServer(tlsOpts as Parameters<typeof createHttpsServer>[0], app);
        httpsServer.on("error", reject);
        const s = httpsServer.listen(port, host, () => resolve(s as HttpServer));
      } else {
        const s = app.listen(port, host, () => resolve(s));
        s.on("error", reject);
      }
    });
  }

  let app = buildHttpAppForCfg(currentCfg, currentAudit);
  currentServer = await listenWithApp(app, currentCfg.tlsConfig);
  logStarted(currentCfg, currentMaterialized, policiesCacheDir, `http${currentCfg.tlsConfig ? "s" : ""} :${port}`, configPath);

  // SIGHUP: hot-reload the config without restarting the process.
  process.on("SIGHUP", async () => {
    log("info", "server.reloading", { transport: `http :${port}` });
    try {
      const newCfg = await loadConfig(configPath);

      // Re-materialize policies for the new config (swallows per-source
      // errors — a missing source shouldn't prevent the reload).
      const newPolicyCollection = findPolicyCollection(newCfg.collections);
      let newMaterialized = 0;
      if (newPolicyCollection) {
        try {
          newMaterialized = await materializePolicies(newPolicyCollection.sources, policiesCacheDir);
        } catch (err) {
          log("error", "policies_cache.materialize_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Close the old audit log and open a new one (in case the path or
      // record-args setting changed).
      await currentAudit.close();
      const newAudit = openAuditLog(newCfg.auditLogPath, { recordArgs: newCfg.auditRecordArgs });

      // Build a fresh Express app from the new config (this recreates
      // auth middleware and rate limiter, so mode/header/limit changes
      // take effect immediately).
      const newApp = buildHttpAppForCfg(newCfg, newAudit);

      // Graceful swap: close the old server (drains in-flight requests)
      // then start the new one. TLS config changes (new cert, new CA)
      // are picked up here too — buildTlsOptions re-reads the files.
      await new Promise<void>((resolve) => currentServer.close(() => resolve()));
      currentServer = await listenWithApp(newApp, newCfg.tlsConfig);
      log("info", "server.reloaded", {
        transport: `http${newCfg.tlsConfig ? "s" : ""} :${port}`,
        collections: newCfg.collections.map((c: LoadedConfig["collections"][number]) => c.name),
        materialized: newMaterialized,
      });

      currentCfg = newCfg;
      currentAudit = newAudit;
      currentMaterialized = newMaterialized;
      app = newApp;
    } catch (err) {
      log("error", "server.reload_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  installSignalHandlers({
    label: `http :${port}`,
    drain: async () => {
      await Promise.race([
        new Promise<void>((resolve) => currentServer.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
      ]);
    },
    audit: () => currentAudit,
  });
}

/**
 * Install SIGTERM / SIGINT handlers that drain the active transport
 * and flush the audit log before exiting. Idempotent — a second signal
 * during shutdown forces an immediate exit so a stuck drain can't trap
 * an operator pressing ^C twice.
 */
function installSignalHandlers(opts: {
  label: string;
  drain: () => Promise<void>;
  audit: AuditRecorder | (() => AuditRecorder);
}): void {
  let shuttingDown = false;
  const getAudit = (typeof opts.audit === "function" ? opts.audit : () => opts.audit) as () => AuditRecorder;
  const handle = (sig: NodeJS.Signals): void => {
    if (shuttingDown) {
      log("warn", "server.shutdown_forced", { signal: sig, transport: opts.label });
      process.exit(1);
    }
    shuttingDown = true;
    log("info", "server.shutting_down", { signal: sig, transport: opts.label });
    void (async () => {
      try {
        await opts.drain();
        await getAudit().close();
        log("info", "server.shutdown_complete", { transport: opts.label });
        process.exit(0);
      } catch (err) {
        log("error", "server.shutdown_error", { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      }
    })();
  };
  process.on("SIGTERM", handle);
  process.on("SIGINT", handle);
}
