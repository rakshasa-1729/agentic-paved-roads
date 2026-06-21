// SPDX-License-Identifier: Apache-2.0
import { extname } from "node:path";
import mm from "micromatch";
import type { Item, Source } from "./types.js";
import { interpolateEnv } from "../util/env.js";
import { abortableFetch } from "../util/timeout.js";
import { log } from "../log.js";

const DEFAULT_TIMEOUT_MS = 10_000;

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

export interface GitLabSourceConfig {
  type: "gitlab";
  name?: string;
  /** Numeric project ID (`123`) or URL-encoded `group/subgroup/repo`. */
  project: string;
  ref?: string;
  path?: string;
  patterns?: string[];
  /** PAT with `read_repository` scope. Falls back to GITLAB_TOKEN env. */
  token?: string;
  /** Default https://gitlab.com. Override for self-hosted. */
  api_base_url?: string;
  timeout_ms?: number;
  cache_ttl_ms?: number;
}

interface RepoTreeEntry {
  id: string;
  name: string;
  type: "blob" | "tree";
  path: string;
  mode: string;
}

/**
 * Source backed by the GitLab Repositories API. Mirrors the github
 * source's shape: list the repository tree once (60s in-memory cache),
 * filter blobs by patterns, and fetch raw bytes lazily on get().
 *
 * Self-hosted GitLab is supported by setting `api_base_url` to the
 * instance's https endpoint (e.g. https://gitlab.example.com). The
 * URL-encoded project path also works for groups + subgroups.
 *
 * Out of scope for v1: keyset pagination beyond the GitLab default
 * (10k entries). The github source has the same constraint and the
 * docs flag this.
 */
export class GitLabSource implements Source {
  readonly id: string;
  private readonly project: string;
  private readonly ref: string;
  private readonly subpath: string;
  private readonly patterns: string[];
  private readonly tokenFromConfig: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private treeCache?: { ts: number; entries: RepoTreeEntry[] };

  constructor(cfg: GitLabSourceConfig) {
    this.project = encodeURIComponent(cfg.project);
    this.ref = cfg.ref ?? "main";
    this.subpath = (cfg.path ?? "").replace(/^\/+|\/+$/g, "");
    this.patterns = cfg.patterns?.length ? cfg.patterns : ["**/*"];
    this.tokenFromConfig = interpolateEnv(cfg.token ?? "");
    this.apiBase = (cfg.api_base_url ?? "https://gitlab.com").replace(/\/$/, "");
    this.timeoutMs = cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this.cacheTtlMs = cfg.cache_ttl_ms ?? 60_000;
    this.id = cfg.name ?? `gitlab:${cfg.project}/${this.subpath}@${this.ref}`;
    if (cfg.ref === undefined || cfg.ref === "main" || cfg.ref === "master") {
      log("warn", "gitlab.unpinned_ref", { source_id: this.id, ref: this.ref });
    }
  }

  async list(query?: string, opts?: { refresh?: boolean }): Promise<Item[]> {
    const tree = await this.fetchTree(opts?.refresh);
    const items: Item[] = [];
    for (const e of tree) {
      if (e.type !== "blob") continue;
      const rel = this.subpath ? e.path.slice(this.subpath.length + 1) : e.path;
      if (this.subpath && !e.path.startsWith(`${this.subpath}/`)) continue;
      if (!mm.isMatch(rel, this.patterns)) continue;
      items.push(this.toItem(rel, e));
    }
    if (!query) return items;
    const q = query.toLowerCase();
    return items.filter((i) => i.name.toLowerCase().includes(q) || (i.title ?? "").toLowerCase().includes(q));
  }

  async get(name: string): Promise<Item> {
    const tree = await this.fetchTree();
    const wanted = this.subpath ? `${this.subpath}/${name}` : name;
    let entry = tree.find((e) => e.type === "blob" && e.path === wanted);
    if (!entry) entry = tree.find((e) => e.type === "blob" && e.path.endsWith(`/${name}`));
    if (!entry) throw new Error(`${this.id}: not found: ${name}`);

    // GitLab serves raw blobs at /repository/files/:path/raw?ref=:ref.
    const url = `${this.apiBase}/api/v4/projects/${this.project}/repository/files/${encodeURIComponent(entry.path)}/raw?ref=${encodeURIComponent(this.ref)}`;
    const res = await abortableFetch(url, { headers: this.authHeaders() }, this.timeoutMs, this.id);
    if (!res.ok) {
      throw new Error(`${this.id} get(${name}) failed: ${res.status} ${res.statusText}`);
    }
    const content = await res.text();
    const rel = this.subpath ? entry.path.slice(this.subpath.length + 1) : entry.path;
    return { ...this.toItem(rel, entry), content };
  }

  private async fetchTree(refresh?: boolean): Promise<RepoTreeEntry[]> {
    if (!refresh && this.treeCache && Date.now() - this.treeCache.ts < this.cacheTtlMs) {
      return this.treeCache.entries;
    }
    const pathParam = this.subpath ? `&path=${encodeURIComponent(this.subpath)}` : "";
    const url = `${this.apiBase}/api/v4/projects/${this.project}/repository/tree?recursive=true&ref=${encodeURIComponent(this.ref)}${pathParam}&per_page=100`;
    const entries: RepoTreeEntry[] = [];
    let next = url;
    while (next) {
      const res = await abortableFetch(next, { headers: this.authHeaders() }, this.timeoutMs, this.id);
      if (!res.ok) {
        throw new Error(`${this.id} list failed: ${res.status} ${res.statusText} (${next})`);
      }
      const page = (await res.json()) as RepoTreeEntry[];
      entries.push(...page);
      next = nextLink(res.headers.get("link"));
    }
    this.treeCache = { ts: Date.now(), entries };
    return entries;
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", "User-Agent": "security-mcp" };
    const token = this.tokenFromConfig || process.env.GITLAB_TOKEN || "";
    if (token) h["PRIVATE-TOKEN"] = token;
    return h;
  }

  private toItem(rel: string, entry: RepoTreeEntry): Item {
    const ext = extname(rel).toLowerCase();
    const stem = rel.split("/").pop()!.replace(ext, "");
    return {
      name: rel,
      source: this.id,
      title: stem,
      uri: `${this.apiBase}/${decodeURIComponent(this.project)}/-/blob/${this.ref}/${entry.path}`,
      content_type: MIME_BY_EXT[ext] ?? "application/octet-stream",
      metadata: { sha: entry.id, path: entry.path },
    };
  }
}

/** Parse the `<url>; rel="next"` link header GitLab uses for pagination. */
function nextLink(header: string | null): string {
  if (!header) return "";
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return "";
}
