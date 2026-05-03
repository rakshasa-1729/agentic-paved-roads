// SPDX-License-Identifier: Apache-2.0
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ConfigSchema } from "../config.js";

const HELP = `Usage: security-mcp schema [options]

Emit the JSON Schema for security.config.yaml. Wire it into your
editor for autocomplete + inline validation while editing the config:

  # VS Code / Cursor — settings.json
  "yaml.schemas": {
    "https://example.com/security-mcp.schema.json": "security.config*.yaml"
  }

  # Or use the bundled schema directly:
  "yaml.schemas": {
    "./node_modules/security-mcp/schema.json": "security.config*.yaml"
  }

Options:
  --out <path>   Write to a file (default: stdout).
  -h, --help     Show this help.
`;

interface SchemaOptions {
  outPath?: string;
}

function parseArgs(argv: string[]): SchemaOptions | { help: true } {
  const opts: SchemaOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    if (a === "--out") opts.outPath = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

export async function run(argv: string[]): Promise<number> {
  let opts: SchemaOptions | { help: true };
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`security-mcp schema: ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.stderr.write(HELP);
    return 2;
  }
  if ("help" in opts) {
    process.stdout.write(HELP);
    return 0;
  }

  const schema = zodToJsonSchema(ConfigSchema, {
    name: "SecurityMcpConfig",
    $refStrategy: "root",
  });
  const json = JSON.stringify(schema, null, 2);

  if (opts.outPath) {
    const abs = resolve(opts.outPath);
    await writeFile(abs, json + "\n", "utf8");
    process.stderr.write(`wrote ${abs}\n`);
    return 0;
  }
  process.stdout.write(json + "\n");
  return 0;
}
