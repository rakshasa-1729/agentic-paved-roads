// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Item, Source } from "./types.js";
import { interpolateEnv } from "../util/env.js";

const exec = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_MAX_BYTES = 1024 * 1024; // 1 MiB per stream

export interface LocalCmdSourceConfig {
  type: "local-cmd";
  name?: string;
  /**
   * Command + args run for `list()`. Stdout is parsed as one item per
   * line (default) or as a JSON array when `format: json`. Each line /
   * array element is the item name.
   */
  list_command: string;
  list_args?: string[];
  /**
   * Command + args run for `get(name)`. The literal token `{name}` in
   * any arg (or in the command) is replaced with the requested name.
   * Stdout becomes the item content.
   */
  get_command: string;
  get_args?: string[];
  /** "lines" (default) — one line per item; "json" — JSON array. */
  format?: "lines" | "json";
  /** Working directory for both commands. */
  cwd?: string;
  /** Extra env vars (with ${VAR} interpolation). */
  env?: Record<string, string>;
  /** Per-command timeout. Default 10s. */
  timeout_ms?: number;
  /** Cap stdout capture per command. Default 1 MiB. */
  output_max_bytes?: number;
}

/**
 * Source backed by two local commands. The agent's `list()` runs
 * `list_command` and parses stdout; `get(name)` runs `get_command`
 * with `{name}` substituted into args.
 *
 * Use cases: piping `kubectl get policies -o name`, an internal CLI's
 * "show all rules" subcommand, a wrapper script that fetches policies
 * from an unsupported backend (Vault, an internal artifact server,
 * etc.). One source type covers many bespoke integrations without
 * needing a custom Source class per backend.
 *
 * Security: this source executes shell commands at every list/get.
 * The command + args come from the YAML config (trusted at deploy
 * time); only the `{name}` substitution is per-call user input. Names
 * are validated against a conservative character class to prevent
 * shell injection through the substitution. Avoid pointing it at
 * commands that interpret their args as shell.
 */
const SAFE_NAME = /^[A-Za-z0-9._/-]+$/;

export class LocalCmdSource implements Source {
  readonly id: string;
  private readonly listCommand: string;
  private readonly listArgs: string[];
  private readonly getCommand: string;
  private readonly getArgs: string[];
  private readonly format: "lines" | "json";
  private readonly cwd?: string;
  private readonly env: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(cfg: LocalCmdSourceConfig) {
    this.id = cfg.name ?? `local-cmd:${cfg.list_command}`;
    this.listCommand = interpolateEnv(cfg.list_command);
    this.listArgs = (cfg.list_args ?? []).map((a) => interpolateEnv(a));
    this.getCommand = interpolateEnv(cfg.get_command);
    this.getArgs = (cfg.get_args ?? []).map((a) => interpolateEnv(a));
    this.format = cfg.format ?? "lines";
    this.cwd = cfg.cwd;
    this.env = Object.fromEntries(
      Object.entries(cfg.env ?? {}).map(([k, v]) => [k, interpolateEnv(v)]),
    );
    this.timeoutMs = cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = cfg.output_max_bytes ?? DEFAULT_OUTPUT_MAX_BYTES;
  }

  async list(query?: string): Promise<Item[]> {
    const out = await this.run(this.listCommand, this.listArgs);
    let names: string[];
    if (this.format === "json") {
      const parsed = JSON.parse(out);
      if (!Array.isArray(parsed)) throw new Error(`${this.id}: list_command did not return a JSON array`);
      names = parsed.map((v) => String(v));
    } else {
      names = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    }
    const items = names.map<Item>((n) => ({ name: n, source: this.id }));
    if (!query) return items;
    const q = query.toLowerCase();
    return items.filter((i) => i.name.toLowerCase().includes(q));
  }

  async get(name: string): Promise<Item> {
    if (!SAFE_NAME.test(name)) {
      throw new Error(`${this.id}: refusing to fetch unsafe name "${name}" (allowed: A-Z a-z 0-9 . _ - /)`);
    }
    const cmd = this.getCommand.replace(/\{name\}/g, name);
    const args = this.getArgs.map((a) => a.replace(/\{name\}/g, name));
    const content = await this.run(cmd, args);
    return { name, source: this.id, content };
  }

  private async run(command: string, args: string[]): Promise<string> {
    const { stdout } = await exec(command, args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      timeout: this.timeoutMs,
      maxBuffer: this.maxBytes,
      // Never spawn a shell — args go to the binary verbatim, no
      // command substitution / glob expansion / chained commands.
      shell: false,
    });
    return stdout;
  }
}
