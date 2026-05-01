import { spawn } from "node:child_process";
import type { ToolEntry, ToolInvokeResult, ToolSource } from "./types.js";
import { interpolateEnv } from "../util/env.js";

export interface CommandToolConfig {
  type: "command";
  name: string;
  description?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: boolean;
  input_schema?: Record<string, unknown>;
}

export interface HttpToolConfig {
  type: "http";
  name: string;
  description?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body_template?: unknown;
  input_schema?: Record<string, unknown>;
}

export type InlineToolConfig = CommandToolConfig | HttpToolConfig;

export class InlineToolSource implements ToolSource {
  readonly id = "inline";
  constructor(private readonly tools: InlineToolConfig[]) {}

  async list(query?: string): Promise<ToolEntry[]> {
    const all = this.tools.map((t) => ({
      name: t.name,
      source: this.id,
      description: t.description,
      input_schema: t.input_schema,
      metadata: { type: t.type },
    }));
    if (!query) return all;
    const q = query.toLowerCase();
    return all.filter((e) => e.name.toLowerCase().includes(q) || (e.description ?? "").toLowerCase().includes(q));
  }

  async describe(name: string): Promise<ToolEntry> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`inline tool not found: ${name}`);
    return {
      name: tool.name,
      source: this.id,
      description: tool.description,
      input_schema: tool.input_schema,
      metadata: { type: tool.type },
    };
  }

  async invoke(name: string, input: unknown): Promise<ToolInvokeResult> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return { ok: false, error: `tool not found: ${name}` };
    if (tool.type === "command") return this.runCommand(tool, input);
    return this.runHttp(tool, input);
  }

  private runCommand(cfg: CommandToolConfig, input: unknown): Promise<ToolInvokeResult> {
    return new Promise((resolveResult) => {
      const args = (cfg.args ?? []).map((a) => renderTemplate(interpolateEnv(a), input));
      const command = interpolateEnv(cfg.command);
      const env = {
        ...process.env,
        ...Object.fromEntries(Object.entries(cfg.env ?? {}).map(([k, v]) => [k, interpolateEnv(v)])),
      };
      const child = spawn(command, args, { cwd: cfg.cwd, env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => resolveResult({ ok: false, error: err.message, stdout, stderr }));
      child.on("close", (code) => {
        resolveResult({ ok: code === 0, exit_code: code ?? -1, stdout, stderr });
      });
      if (cfg.stdin && input != null) {
        child.stdin.write(typeof input === "string" ? input : JSON.stringify(input));
        child.stdin.end();
      } else {
        child.stdin.end();
      }
    });
  }

  private async runHttp(cfg: HttpToolConfig, input: unknown): Promise<ToolInvokeResult> {
    // Env interpolation first ({{input}} templating second) so config-time
    // tokens like ${EXCEPTION_API_BASE_URL} resolve before per-call args.
    const url = renderTemplate(interpolateEnv(cfg.url), input);
    const headers = Object.fromEntries(
      Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, interpolateEnv(v)]),
    );
    const method = cfg.method ?? "POST";
    let body: string | undefined;
    if (method !== "GET" && method !== "DELETE") {
      const tmpl = cfg.body_template ?? input;
      const rendered = typeof tmpl === "string" ? renderTemplate(tmpl, input) : renderObject(tmpl, input);
      body = typeof rendered === "string" ? rendered : JSON.stringify(rendered);
      headers["content-type"] ??= "application/json";
    }
    try {
      const res = await fetch(url, { method, headers, body });
      const ct = res.headers.get("content-type") ?? "";
      const data = ct.includes("application/json") ? await res.json() : await res.text();
      return {
        ok: res.ok,
        status: res.status,
        data,
        stdout: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function renderTemplate(tmpl: string, input: unknown): string {
  if (typeof input !== "object" || input == null) return tmpl;
  return tmpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const v = key.split(".").reduce<unknown>((acc, k) => (acc == null ? acc : (acc as Record<string, unknown>)[k]), input);
    return v == null ? "" : String(v);
  });
}

function renderObject(obj: unknown, input: unknown): unknown {
  if (typeof obj === "string") return renderTemplate(obj, input);
  if (Array.isArray(obj)) return obj.map((v) => renderObject(v, input));
  if (obj && typeof obj === "object") {
    return Object.fromEntries(Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, renderObject(v, input)]));
  }
  return obj;
}
