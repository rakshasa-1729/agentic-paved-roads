// SPDX-License-Identifier: Apache-2.0
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// At runtime this lives in dist/cli/, so presets resolve to ../../presets.
// Under tsx (`npm run dev init`), it lives in src/cli/ — same relative path.
const PRESETS_DIR = resolve(HERE, "../../presets");

interface InitOptions {
  preset: string;
  outPath: string;
  force: boolean;
}

const HELP = `Usage: security-mcp init [options]

Write a starter security.config.yaml from one of the bundled presets.

Options:
  --preset <name>     Preset to copy (default: security). Run with
                      no args to see the list.
  --out <path>        Destination file (default: ./security.config.yaml).
  --force             Overwrite the destination if it already exists.
  -h, --help          Show this help.

Examples:
  security-mcp init                       # writes ./security.config.yaml from 'security'
  security-mcp init --preset empty        # minimal starter for non-security adopters
  security-mcp init --out ./mcp.yaml      # custom destination
`;

function parseArgs(argv: string[]): InitOptions | { help: true } {
  const opts: InitOptions = {
    preset: "security",
    outPath: "./security.config.yaml",
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    if (a === "--preset") {
      opts.preset = argv[++i] ?? "";
    } else if (a === "--out") {
      opts.outPath = argv[++i] ?? "";
    } else if (a === "--force") {
      opts.force = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!opts.preset) throw new Error("--preset requires a value");
  if (!opts.outPath) throw new Error("--out requires a value");
  return opts;
}

async function listPresets(): Promise<string[]> {
  const entries = await readdir(PRESETS_DIR);
  return entries
    .filter((e) => e.endsWith(".yaml"))
    .map((e) => e.replace(/\.yaml$/, ""))
    .sort();
}

export async function run(args: string[]): Promise<number> {
  let opts: InitOptions | { help: true };
  try {
    opts = parseArgs(args);
  } catch (err) {
    process.stderr.write(`security-mcp init: ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.stderr.write(HELP);
    return 2;
  }
  if ("help" in opts) {
    process.stdout.write(HELP);
    return 0;
  }

  const presetPath = join(PRESETS_DIR, `${opts.preset}.yaml`);
  if (!existsSync(presetPath)) {
    const available = await listPresets();
    process.stderr.write(
      `security-mcp init: unknown preset "${opts.preset}". Available: ${available.join(", ")}\n`,
    );
    return 2;
  }

  const dest = resolve(opts.outPath);
  if (existsSync(dest) && !opts.force) {
    process.stderr.write(
      `security-mcp init: ${dest} already exists. Re-run with --force to overwrite.\n`,
    );
    return 1;
  }

  await mkdir(dirname(dest), { recursive: true });
  await copyFile(presetPath, dest);

  process.stdout.write(
    `wrote ${dest} (preset=${opts.preset})\n` +
      `\nNext steps:\n` +
      `  1. Edit ${dest} to point at your sources.\n` +
      `  2. Validate it:    npx security-mcp validate ${opts.outPath}\n` +
      `  3. Run the server: npx security-mcp serve\n` +
      `  4. Wire your editor — see README.md "Wire into ..." sections.\n`,
  );
  return 0;
}
