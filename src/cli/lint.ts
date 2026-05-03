// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import fg from "fast-glob";
import yaml from "yaml";
import { InlineTool } from "../config.js";

const HELP = `Usage: security-mcp lint <repo-path>

Validate a content repo (the kind that backs a github / gitlab / file
collection) against publisher conventions:

  - Every .rego policy has a co-located .md spec of the same stem
    (so the model has a human-readable companion to the enforcement
    rule).
  - Every tools/*.yaml file parses as an InlineTool descriptor
    (type=command|http with name + the right shape per type).
  - Markdown links of the form [text](relative/path) resolve to a
    file in the repo. Absolute (https://) and anchor (#section)
    links are skipped.

Exits 0 if clean, 1 with a per-issue report otherwise. Use in CI on
your security / runbooks / paved-roads repo to catch convention
drift before adopters' agents do.

Options:
  --json    Emit machine-readable findings instead of the human report.
  -h, --help

Example:
  security-mcp lint ../acme-security-repo
`;

interface LintOptions {
  repoPath: string;
  json: boolean;
}

interface Finding {
  file: string;
  line?: number;
  rule: string;
  message: string;
}

function parseArgs(argv: string[]): LintOptions | { help: true } {
  const opts: Partial<LintOptions> = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    if (a === "--json") opts.json = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else if (!opts.repoPath) opts.repoPath = a;
    else throw new Error(`unexpected positional argument: ${a}`);
  }
  if (!opts.repoPath) throw new Error("missing required <repo-path>");
  return opts as LintOptions;
}

export async function run(argv: string[]): Promise<number> {
  let opts: LintOptions | { help: true };
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`security-mcp lint: ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.stderr.write(HELP);
    return 2;
  }
  if ("help" in opts) {
    process.stdout.write(HELP);
    return 0;
  }

  const root = resolve(opts.repoPath);
  if (!existsSync(root)) {
    process.stderr.write(`security-mcp lint: not found: ${root}\n`);
    return 1;
  }

  const findings: Finding[] = [];
  findings.push(...(await checkRegoMarkdownPairing(root)));
  findings.push(...(await checkToolDescriptors(root)));
  findings.push(...(await checkMarkdownLinks(root)));

  if (opts.json) {
    process.stdout.write(JSON.stringify({ root, findings }, null, 2) + "\n");
    return findings.length > 0 ? 1 : 0;
  }

  if (findings.length === 0) {
    process.stdout.write(`✓ ${root}: no issues\n`);
    return 0;
  }
  process.stderr.write(`security-mcp lint: ${findings.length} issue(s) in ${root}\n\n`);
  for (const f of findings) {
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    process.stderr.write(`  [${f.rule}] ${where}\n    ${f.message}\n`);
  }
  return 1;
}

async function checkRegoMarkdownPairing(root: string): Promise<Finding[]> {
  const regoFiles = await fg(["**/*.rego"], { cwd: root, absolute: true, dot: false, ignore: ["node_modules/**"] });
  const findings: Finding[] = [];
  for (const abs of regoFiles) {
    const md = abs.replace(/\.rego$/i, ".md");
    if (!existsSync(md)) {
      findings.push({
        file: relative(root, abs),
        rule: "rego-md-pairing",
        message: `no companion .md (expected ${relative(root, md)})`,
      });
    }
  }
  return findings;
}

async function checkToolDescriptors(root: string): Promise<Finding[]> {
  const toolFiles = await fg(["tools/**/*.yaml", "tools/**/*.yml"], {
    cwd: root,
    absolute: true,
    dot: false,
    ignore: ["node_modules/**"],
  });
  const findings: Finding[] = [];
  for (const abs of toolFiles) {
    let parsed: unknown;
    try {
      parsed = yaml.parse(readFileSync(abs, "utf8"));
    } catch (err) {
      findings.push({
        file: relative(root, abs),
        rule: "tool-yaml-parse",
        message: `yaml parse failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const result = InlineTool.safeParse(parsed);
    if (!result.success) {
      findings.push({
        file: relative(root, abs),
        rule: "tool-schema",
        message: result.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; "),
      });
    }
  }
  return findings;
}

async function checkMarkdownLinks(root: string): Promise<Finding[]> {
  const mdFiles = await fg(["**/*.md", "**/*.markdown"], {
    cwd: root,
    absolute: true,
    dot: false,
    ignore: ["node_modules/**"],
  });
  const findings: Finding[] = [];
  // Markdown link pattern, skipping <link>, image links, and code spans.
  // Naive but catches the common case.
  const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const abs of mdFiles) {
    const text = readFileSync(abs, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m: RegExpExecArray | null;
      const re = new RegExp(linkRe);
      while ((m = re.exec(line)) !== null) {
        const target = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // absolute scheme
        if (target.startsWith("#")) continue; // intra-doc anchor
        if (target.startsWith("mailto:")) continue;
        const [pathPart] = target.split("#");
        if (!pathPart) continue;
        const targetAbs = resolve(dirname(abs), pathPart);
        if (!existsSync(targetAbs)) {
          findings.push({
            file: relative(root, abs),
            line: i + 1,
            rule: "broken-link",
            message: `link to ${target} does not resolve (${relative(root, targetAbs)})`,
          });
        }
      }
    }
  }
  return findings;
}

// Re-export helpers for unit tests.
export const _internals = {
  checkRegoMarkdownPairing,
  checkToolDescriptors,
  checkMarkdownLinks,
};

// Silence linter for unused imports in some build environments.
void basename;
void extname;
void join;
