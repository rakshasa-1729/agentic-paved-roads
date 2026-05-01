import type { Item, Source } from "./types.js";
import { interpolateEnv } from "../util/env.js";

export interface HttpSourceConfig {
  type: "http";
  name?: string;
  base_url: string;
  list_path?: string;
  get_path?: string;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  content_field?: string;
  name_field?: string;
  items_field?: string;
}

export class HttpSource implements Source {
  readonly id: string;
  private readonly base: string;
  private readonly listPath: string;
  private readonly getPath: string;
  private readonly headers: Record<string, string>;
  private readonly method: "GET" | "POST";
  private readonly nameField: string;
  private readonly contentField: string;
  private readonly itemsField?: string;

  constructor(cfg: HttpSourceConfig) {
    this.id = cfg.name ?? `http:${cfg.base_url}`;
    this.base = cfg.base_url.replace(/\/$/, "");
    this.listPath = cfg.list_path ?? "/";
    this.getPath = cfg.get_path ?? "/{name}";
    this.headers = Object.fromEntries(
      Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, interpolateEnv(v)]),
    );
    this.method = cfg.method ?? "GET";
    this.nameField = cfg.name_field ?? "name";
    this.contentField = cfg.content_field ?? "content";
    this.itemsField = cfg.items_field;
  }

  async list(query?: string): Promise<Item[]> {
    const url = this.base + this.listPath + (query ? `?q=${encodeURIComponent(query)}` : "");
    const res = await fetch(url, { method: this.method, headers: this.headers });
    if (!res.ok) throw new Error(`${this.id} list failed: ${res.status} ${res.statusText}`);
    const body = await this.parseBody(res);
    const rawItems = this.itemsField ? (body as Record<string, unknown>)[this.itemsField] : body;
    if (!Array.isArray(rawItems)) throw new Error(`${this.id} list did not return an array`);
    return rawItems.map((entry) => this.normalize(entry));
  }

  async get(name: string): Promise<Item> {
    const url = this.base + this.getPath.replace("{name}", encodeURIComponent(name));
    const res = await fetch(url, { method: this.method, headers: this.headers });
    if (!res.ok) throw new Error(`${this.id} get(${name}) failed: ${res.status} ${res.statusText}`);
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const obj = (await res.json()) as Record<string, unknown>;
      const item = this.normalize(obj);
      const content = obj[this.contentField] ?? obj["body"] ?? obj["data"];
      return { ...item, content: typeof content === "string" ? content : JSON.stringify(content, null, 2) };
    }
    const text = await res.text();
    return {
      name,
      source: this.id,
      content: text,
      content_type: ct || "text/plain",
      uri: url,
    };
  }

  private async parseBody(res: Response): Promise<unknown> {
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return res.json();
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text.split(/\r?\n/).filter(Boolean);
    }
  }

  private normalize(entry: unknown): Item {
    if (typeof entry === "string") {
      return { name: entry, source: this.id };
    }
    const obj = entry as Record<string, unknown>;
    const name = String(obj[this.nameField] ?? obj.id ?? obj.title ?? "");
    return {
      name,
      source: this.id,
      title: typeof obj.title === "string" ? obj.title : undefined,
      description: typeof obj.description === "string" ? obj.description : undefined,
      uri: typeof obj.uri === "string" ? obj.uri : typeof obj.url === "string" ? (obj.url as string) : undefined,
      content_type: typeof obj.content_type === "string" ? obj.content_type : undefined,
      metadata: obj,
    };
  }
}
