import { readFile } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import fg from "fast-glob";
import type { Item, Source } from "./types.js";

export interface FileSourceConfig {
  type: "file";
  path: string;
  patterns?: string[];
  name?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".rego": "application/rego",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".json": "application/json",
  ".hcl": "application/hcl",
  ".tf": "application/hcl",
};

export class FileSource implements Source {
  readonly id: string;
  private readonly root: string;
  private readonly patterns: string[];

  constructor(cfg: FileSourceConfig) {
    this.root = resolve(cfg.path);
    this.patterns = cfg.patterns?.length ? cfg.patterns : ["**/*.md", "**/*.rego", "**/*.yaml", "**/*.yml"];
    this.id = cfg.name ?? `file:${cfg.path}`;
  }

  async list(query?: string): Promise<Item[]> {
    const files = await fg(this.patterns, { cwd: this.root, absolute: true, dot: false });
    const items = files.map((abs) => this.toItem(abs));
    if (!query) return items;
    const q = query.toLowerCase();
    return items.filter((i) => i.name.toLowerCase().includes(q) || (i.title ?? "").toLowerCase().includes(q));
  }

  async get(name: string): Promise<Item> {
    const items = await this.list();
    const match = items.find((i) => i.name === name) ?? items.find((i) => i.name.endsWith(name));
    if (!match) throw new Error(`not found in ${this.id}: ${name}`);
    const abs = resolve(this.root, match.metadata?.path as string);
    const content = await readFile(abs, "utf8");
    return { ...match, content };
  }

  private toItem(abs: string): Item {
    const rel = relative(this.root, abs);
    const ext = extname(abs).toLowerCase();
    const stem = basename(rel, ext);
    return {
      name: rel.replace(/\\/g, "/"),
      source: this.id,
      title: stem,
      uri: `file://${abs}`,
      content_type: MIME_BY_EXT[ext] ?? "application/octet-stream",
      metadata: { path: rel },
    };
  }
}
