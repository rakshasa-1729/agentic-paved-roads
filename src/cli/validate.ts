// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type LoadedCollection } from "../config.js";

const HELP = `Usage: security-mcp validate [path]

Parse a security-mcp config and reach out to each configured source to
confirm it's online. Exits non-zero on any parse or probe failure.

Arguments:
  path        Config file to validate (default: ./security.config.yaml,
              or \$SECURITY_MCP_CONFIG).

Options:
  --no-probe  Skip the live source probes; only validate the YAML/zod
              schema.
  -h, --help  Show this help.
`;

interface ValidateOptions {
  path: string;
  probe: boolean;
}

function parseArgs(argv: string[]): ValidateOptions | { help: true } {
  const opts: ValidateOptions = {
    path: process.env.SECURITY_MCP_CONFIG ?? "./security.config.yaml",
    probe: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    if (a === "--no-probe") opts.probe = false;
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else opts.path = a;
  }
  return opts;
}

async function probeCollection(c: LoadedCollection): Promise<{ ok: number; failed: number; lines: string[] }> {
  const lines: string[] = [];
  let ok = 0;
  let failed = 0;
  for (const src of c.sources) {
    const start = Date.now();
    try {
      const items = await src.list();
      const ms = Date.now() - start;
      lines.push(`    ✓ ${src.id} (${items.length} items, ${ms}ms)`);
      ok++;
    } catch (err) {
      const ms = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`    ✗ ${src.id} (${ms}ms): ${msg}`);
      failed++;
    }
  }
  return { ok, failed, lines };
}

export async function run(args: string[]): Promise<number> {
  let opts: ValidateOptions | { help: true };
  try {
    opts = parseArgs(args);
  } catch (err) {
    process.stderr.write(`security-mcp validate: ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.stderr.write(HELP);
    return 2;
  }
  if ("help" in opts) {
    process.stdout.write(HELP);
    return 0;
  }

  const abs = resolve(opts.path);
  if (!existsSync(abs)) {
    process.stderr.write(`security-mcp validate: config not found: ${abs}\n`);
    return 1;
  }

  let cfg;
  try {
    cfg = await loadConfig(abs);
  } catch (err) {
    process.stderr.write(`security-mcp validate: config invalid: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  process.stdout.write(`✓ ${abs} parses cleanly\n`);
  process.stdout.write(`  collections: ${cfg.collections.length}\n`);
  process.stdout.write(`  registry tools: ${cfg.tools.registry instanceof Object ? "(loaded)" : "(none)"}\n`);

  if (!opts.probe) return 0;

  let totalFailed = 0;
  for (const c of cfg.collections) {
    process.stdout.write(`\n  [${c.name}] ${c.sources.length} source(s)\n`);
    const { failed, lines } = await probeCollection(c);
    for (const l of lines) process.stdout.write(l + "\n");
    totalFailed += failed;
  }

  if (totalFailed > 0) {
    process.stderr.write(`\nsecurity-mcp validate: ${totalFailed} source(s) failed to respond.\n`);
    return 1;
  }
  process.stdout.write(`\n✓ all sources responded\n`);
  return 0;
}
