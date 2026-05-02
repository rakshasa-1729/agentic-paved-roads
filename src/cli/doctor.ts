// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const HELP = `Usage: security-mcp doctor

Print environment diagnostics relevant to running security-mcp:
  - Node version
  - gh CLI install + auth status (used as a fallback GitHub token)
  - docker availability (only needed if running the bundled image)
  - conftest on PATH (only needed if not using the bundled image)
  - default config file presence
  - relevant env vars

Exits 0 unless something is genuinely broken (e.g. Node too old).

Options:
  -h, --help  Show this help.
`;

interface Check {
  name: string;
  status: "ok" | "warn" | "fail" | "info";
  detail: string;
  hint?: string;
}

function fmt(c: Check): string {
  const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : c.status === "fail" ? "✗" : "•";
  const line = `${icon} ${c.name.padEnd(28)} ${c.detail}`;
  return c.hint ? `${line}\n    → ${c.hint}` : line;
}

async function checkNode(): Promise<Check> {
  const v = process.versions.node;
  const major = Number(v.split(".")[0]);
  if (Number.isNaN(major) || major < 20) {
    return {
      name: "Node.js >=20",
      status: "fail",
      detail: `found ${v}`,
      hint: "Install Node 20 or newer (https://nodejs.org).",
    };
  }
  return { name: "Node.js >=20", status: "ok", detail: `v${v}` };
}

async function commandVersion(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 2000 });
    return stdout.trim().split("\n")[0];
  } catch {
    return null;
  }
}

async function checkGh(): Promise<Check[]> {
  const ver = await commandVersion("gh", ["--version"]);
  if (!ver) {
    return [
      {
        name: "gh CLI",
        status: "info",
        detail: "not found",
        hint: "Optional. Install (`brew install gh`) if you want gh-based GitHub auth fallback.",
      },
    ];
  }
  const auth = await commandVersion("gh", ["auth", "status"]).catch(() => null);
  if (!auth) {
    return [
      { name: "gh CLI", status: "ok", detail: ver },
      {
        name: "gh auth",
        status: "warn",
        detail: "not signed in",
        hint: "Run `gh auth login` if you want to use the gh-CLI token fallback for GitHub sources.",
      },
    ];
  }
  return [
    { name: "gh CLI", status: "ok", detail: ver },
    { name: "gh auth", status: "ok", detail: "signed in" },
  ];
}

async function checkDocker(): Promise<Check> {
  const ver = await commandVersion("docker", ["--version"]);
  if (!ver) {
    return {
      name: "docker",
      status: "info",
      detail: "not found",
      hint: "Optional. Only needed if you launch the bundled image via bin/security-mcp.",
    };
  }
  return { name: "docker", status: "ok", detail: ver };
}

async function checkConftest(): Promise<Check> {
  const ver = await commandVersion("conftest", ["--version"]);
  if (!ver) {
    return {
      name: "conftest",
      status: "info",
      detail: "not on PATH",
      hint: "Only needed if you run the server outside the bundled image. The image bundles conftest.",
    };
  }
  return { name: "conftest", status: "ok", detail: ver };
}

function checkConfig(): Check {
  const path = process.env.SECURITY_MCP_CONFIG ?? "./security.config.yaml";
  const abs = resolve(path);
  if (!existsSync(abs)) {
    return {
      name: "config file",
      status: "warn",
      detail: `${abs} does not exist`,
      hint: "Run `security-mcp init` to create one from a preset.",
    };
  }
  return { name: "config file", status: "ok", detail: abs };
}

function checkEnv(): Check[] {
  const interesting = [
    "SECURITY_MCP_CONFIG",
    "MCP_TRANSPORT",
    "PORT",
    "LOG_LEVEL",
    "SECURITY_REPO_TOKEN",
    "GITHUB_TOKEN",
  ];
  return interesting.map<Check>((name) => {
    const v = process.env[name];
    if (!v) return { name, status: "info", detail: "(unset)" };
    const masked = name.endsWith("_TOKEN") ? `set (${v.length} chars)` : v;
    return { name, status: "ok", detail: masked };
  });
}

export async function run(args: string[]): Promise<number> {
  if (args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(HELP);
    return 0;
  }

  const checks: Check[] = [];
  checks.push(await checkNode());
  checks.push(...(await checkGh()));
  checks.push(await checkDocker());
  checks.push(await checkConftest());
  checks.push(checkConfig());
  process.stdout.write(checks.map(fmt).join("\n") + "\n");

  process.stdout.write("\nenv:\n");
  for (const c of checkEnv()) process.stdout.write(`  ${fmt(c)}\n`);

  const failed = checks.some((c) => c.status === "fail");
  return failed ? 1 : 0;
}
