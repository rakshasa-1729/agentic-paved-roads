#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { log } from "./log.js";

const HELP = `Usage: security-mcp <command> [options]

Commands:
  serve       Run the MCP server (default if no command is given).
              Honors MCP_TRANSPORT={stdio,http}, PORT, HOST, ALLOWED_HOSTS.
  init        Write a starter security.config.yaml from a bundled preset.
  validate    Parse a config and probe each source.
  doctor      Print environment diagnostics.
  inspect     Connect in-process and list / describe / invoke tools.

Pass -h / --help to any command for its options.

Env:
  SECURITY_MCP_CONFIG   path to the config file (default: ./security.config.yaml)
  MCP_TRANSPORT         stdio | http (default: stdio)
  LOG_LEVEL             debug | info | warn | error (default: info)
`;

type CmdRunner = (args: string[]) => Promise<number>;

async function loadCommand(name: string): Promise<CmdRunner> {
  switch (name) {
    case "serve":
      return (await import("./cli/serve.js")).run;
    case "init":
      return (await import("./cli/init.js")).run;
    case "validate":
      return (await import("./cli/validate.js")).run;
    case "doctor":
      return (await import("./cli/doctor.js")).run;
    case "inspect":
      return (await import("./cli/inspect.js")).run;
    default:
      throw new Error(`unknown command: ${name}`);
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  // No subcommand → serve. Keeps the existing `node dist/index.js`
  // entrypoint (used by Docker, the bin launcher, MCP host configs)
  // working unchanged.
  const [cmd, ...rest] = argv.length === 0 || argv[0].startsWith("-") ? ["serve", ...argv] : argv;
  let run: CmdRunner;
  try {
    run = await loadCommand(cmd);
  } catch (err) {
    process.stderr.write(`security-mcp: ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.stderr.write(HELP);
    return 2;
  }
  return run(rest);
}

main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((err) => {
    log("error", "server.fatal", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
