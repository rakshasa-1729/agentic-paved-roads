import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Item, Source, ToolEntry, ToolInvokeResult, ToolSource } from "./types.js";
import { interpolateEnv } from "../util/env.js";
import { withTimeout } from "../util/timeout.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export interface McpSourceConfig {
  type: "mcp";
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  connect_timeout_ms?: number;
  cache_ttl_ms?: number;
  output_max_bytes?: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_OUTPUT_MAX_BYTES = 512 * 1024;

interface CacheEntry<T> {
  data: T;
  ts: number;
}

class McpClientHolder {
  private client?: Client;
  private connecting?: Promise<Client>;

  constructor(private readonly cfg: McpSourceConfig, private readonly id: string) {}

  async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    const timeoutMs = this.cfg.connect_timeout_ms ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: this.cfg.command,
        args: this.cfg.args ?? [],
        env: Object.fromEntries(
          Object.entries(this.cfg.env ?? {}).map(([k, v]) => [k, interpolateEnv(v)]),
        ),
      });
      const client = new Client({ name: `security-mcp/${this.id}`, version: "0.1.0" }, { capabilities: {} });
      try {
        await withTimeout(
          client.connect(transport),
          timeoutMs,
          `${this.id} mcp connect`,
          () => {
            // Kill the child + free pipes; the SDK transport.close()
            // sends a SIGTERM to the spawned process under the hood.
            transport.close().catch(() => undefined);
          },
        );
      } catch (err) {
        // Reset so a subsequent call retries from scratch instead of
        // returning the rejected connect promise forever.
        this.connecting = undefined;
        throw err;
      }
      this.client = client;
      return client;
    })();
    return this.connecting;
  }
}

export class McpResourceSource implements Source {
  readonly id: string;
  private readonly holder: McpClientHolder;
  private readonly cacheTtlMs: number;
  private listCache?: CacheEntry<Item[]>;

  constructor(cfg: McpSourceConfig) {
    this.id = cfg.name ?? `mcp:${cfg.command}`;
    this.holder = new McpClientHolder(cfg, this.id);
    this.cacheTtlMs = cfg.cache_ttl_ms ?? DEFAULT_CACHE_TTL_MS;
  }

  async list(query?: string): Promise<Item[]> {
    const now = Date.now();
    if (this.listCache && now - this.listCache.ts < this.cacheTtlMs) {
      const items = this.listCache.data;
      if (!query) return items;
      const q = query.toLowerCase();
      return items.filter((i) => i.name.toLowerCase().includes(q) || (i.title ?? "").toLowerCase().includes(q));
    }
    const client = await this.holder.connect();
    const res = await client.listResources();
    const items: Item[] = (res.resources ?? []).map((r) => ({
      name: r.uri,
      source: this.id,
      title: r.name,
      description: r.description,
      uri: r.uri,
      content_type: r.mimeType,
    }));
    this.listCache = { data: items, ts: now };
    if (!query) return items;
    const q = query.toLowerCase();
    return items.filter((i) => i.name.toLowerCase().includes(q) || (i.title ?? "").toLowerCase().includes(q));
  }

  async get(name: string): Promise<Item> {
    const client = await this.holder.connect();
    const res = await client.readResource({ uri: name });
    const part = res.contents?.[0];
    if (!part) throw new Error(`${this.id}: empty resource ${name}`);
    const content =
      "text" in part && typeof part.text === "string"
        ? part.text
        : "blob" in part && typeof part.blob === "string"
          ? part.blob
          : JSON.stringify(part);
    return {
      name,
      source: this.id,
      uri: name,
      content,
      content_type: part.mimeType,
    };
  }
}

export class McpToolSource implements ToolSource {
  readonly id: string;
  private readonly holder: McpClientHolder;
  private readonly cacheTtlMs: number;
  private listCache?: CacheEntry<ToolEntry[]>;

  constructor(cfg: McpSourceConfig) {
    this.id = cfg.name ?? `mcp:${cfg.command}`;
    this.holder = new McpClientHolder(cfg, this.id);
    this.cacheTtlMs = cfg.cache_ttl_ms ?? DEFAULT_CACHE_TTL_MS;
  }

  async list(query?: string): Promise<ToolEntry[]> {
    const now = Date.now();
    if (this.listCache && now - this.listCache.ts < this.cacheTtlMs) {
      const entries = this.listCache.data;
      if (!query) return entries;
      const q = query.toLowerCase();
      return entries.filter((e) => e.name.toLowerCase().includes(q) || (e.description ?? "").toLowerCase().includes(q));
    }
    const client = await this.holder.connect();
    const res = await client.listTools();
    const entries = (res.tools ?? []).map((t) => ({
      name: t.name,
      source: this.id,
      description: t.description,
      input_schema: t.inputSchema as Record<string, unknown> | undefined,
    }));
    this.listCache = { data: entries, ts: now };
    if (!query) return entries;
    const q = query.toLowerCase();
    return entries.filter((e) => e.name.toLowerCase().includes(q) || (e.description ?? "").toLowerCase().includes(q));
  }

  async describe(name: string): Promise<ToolEntry> {
    const all = await this.list();
    const match = all.find((t) => t.name === name);
    if (!match) throw new Error(`${this.id}: tool not found: ${name}`);
    return match;
  }

  async invoke(name: string, input: unknown): Promise<ToolInvokeResult> {
    const client = await this.holder.connect();
    try {
      const res = await client.callTool({ name, arguments: (input ?? {}) as Record<string, unknown> });
      const content = (res.content ?? []) as Array<Record<string, unknown>>;
      let text = content
        .map((c) => (typeof c.text === "string" ? c.text : JSON.stringify(c)))
        .join("\n");
      const maxBytes = DEFAULT_OUTPUT_MAX_BYTES;
      if (text.length > maxBytes) {
        text = text.slice(0, maxBytes) + `\n… [truncated ${text.length - maxBytes} bytes]`;
      }
      return { ok: !res.isError, stdout: text, data: res };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
