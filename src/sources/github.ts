import { execFile } from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";
import mm from "micromatch";
import type { Item, Source } from "./types.js";
import { interpolateEnv } from "../util/env.js";
import { abortableFetch } from "../util/timeout.js";
import { log } from "../log.js";

const exec = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10_000;

export interface GitHubSourceConfig {
  type: "github";
  name?: string;
  owner: string;
  repo: string;
  ref?: string;
  path?: string;
  patterns?: string[];
  token?: string;
  api_base_url?: string;
  timeout_ms?: number;
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

interface TreeEntry {
  path: string;
  type: "blob" | "tree" | string;
  sha: string;
  size?: number;
}

export class GitHubSource implements Source {
  readonly id: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly ref: string;
  private readonly subpath: string;
  private readonly patterns: string[];
  private readonly tokenFromConfig: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private resolvedToken?: string;
  private treeCache?: { ts: number; entries: TreeEntry[] };

  constructor(cfg: GitHubSourceConfig) {
    this.owner = cfg.owner;
    this.repo = cfg.repo;
    this.ref = cfg.ref ?? "main";
    this.subpath = (cfg.path ?? "").replace(/^\/+|\/+$/g, "");
    this.patterns = cfg.patterns?.length ? cfg.patterns : ["**/*"];
    this.tokenFromConfig = interpolateEnv(cfg.token ?? "");
    this.apiBase = (cfg.api_base_url ?? "https://api.github.com").replace(/\/$/, "");
    this.timeoutMs = cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this.id = cfg.name ?? `github:${this.owner}/${this.repo}/${this.subpath}@${this.ref}`;
    if (cfg.ref === undefined || cfg.ref === "main" || cfg.ref === "master") {
      // Pinning to a branch makes the source silently roll forward
      // when upstream changes — agents see different content for the
      // same query depending on when they call. Pin to a tag or sha
      // for reproducibility.
      log("warn", "github.unpinned_ref", { source_id: this.id, ref: this.ref });
    }
  }

  async list(query?: string): Promise<Item[]> {
    await this.resolveToken();
    const tree = await this.fetchTree();
    const prefix = this.subpath ? `${this.subpath}/` : "";
    const items: Item[] = [];
    for (const entry of tree) {
      if (entry.type !== "blob") continue;
      if (prefix && !entry.path.startsWith(prefix)) continue;
      const rel = prefix ? entry.path.slice(prefix.length) : entry.path;
      if (!mm.isMatch(rel, this.patterns)) continue;
      items.push(this.toItem(rel, entry));
    }
    if (!query) return items;
    const q = query.toLowerCase();
    return items.filter((i) => i.name.toLowerCase().includes(q) || (i.title ?? "").toLowerCase().includes(q));
  }

  async get(name: string): Promise<Item> {
    await this.resolveToken();
    const tree = await this.fetchTree();
    const prefix = this.subpath ? `${this.subpath}/` : "";

    const wanted = `${prefix}${name}`;
    let entry = tree.find((e) => e.type === "blob" && e.path === wanted);
    if (!entry) {
      // Allow callers to omit the prefix or pass a suffix.
      entry = tree.find((e) => e.type === "blob" && e.path.endsWith(`/${name}`));
    }
    if (!entry) throw new Error(`${this.id}: not found: ${name}`);

    const url = `${this.apiBase}/repos/${this.owner}/${this.repo}/contents/${encodeURI(entry.path)}?ref=${encodeURIComponent(this.ref)}`;
    const res = await abortableFetch(
      url,
      {
        headers: {
          ...this.authHeaders(),
          Accept: "application/vnd.github.raw",
        },
      },
      this.timeoutMs,
      this.id,
    );
    this.checkRateLimit(res);
    if (!res.ok) {
      throw new Error(`${this.id} get(${name}) failed: ${res.status} ${res.statusText}`);
    }
    const content = await res.text();
    const rel = prefix ? entry.path.slice(prefix.length) : entry.path;
    return { ...this.toItem(rel, entry), content };
  }

  private async fetchTree(): Promise<TreeEntry[]> {
    const ttlMs = 60_000;
    if (this.treeCache && Date.now() - this.treeCache.ts < ttlMs) {
      return this.treeCache.entries;
    }
    const url = `${this.apiBase}/repos/${this.owner}/${this.repo}/git/trees/${encodeURIComponent(this.ref)}?recursive=1`;
    const res = await abortableFetch(url, { headers: this.authHeaders() }, this.timeoutMs, this.id);
    this.checkRateLimit(res);
    if (!res.ok) {
      throw new Error(`${this.id} list failed: ${res.status} ${res.statusText} (${url})`);
    }
    const body = (await res.json()) as { tree?: TreeEntry[]; truncated?: boolean };
    if (body.truncated) {
      // Repos with > 100k entries truncate. Out of scope for our small repos.
      throw new Error(`${this.id}: tree truncated; refine path or split sources`);
    }
    this.treeCache = { ts: Date.now(), entries: body.tree ?? [] };
    return this.treeCache.entries;
  }

  private rateLimitWarned = false;

  /**
   * Inspect the GitHub rate-limit headers and warn once when remaining
   * drops below 100. The unauthenticated quota is 60/hr; the
   * authenticated quota is 5000/hr — running below 100 means the
   * source is one busy day from a 403.
   */
  private checkRateLimit(res: Response): void {
    if (this.rateLimitWarned) return;
    const raw = res.headers.get("x-ratelimit-remaining");
    if (raw == null) return; // header absent (test stubs, non-GitHub mirrors)
    const remaining = Number(raw);
    if (!Number.isFinite(remaining) || remaining > 100) return;
    log("warn", "github.rate_limit_low", {
      source_id: this.id,
      remaining,
      limit: Number(res.headers.get("x-ratelimit-limit")) || undefined,
      reset: res.headers.get("x-ratelimit-reset") ?? undefined,
    });
    this.rateLimitWarned = true;
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "security-mcp",
    };
    if (this.resolvedToken) h.Authorization = `Bearer ${this.resolvedToken}`;
    return h;
  }

  /**
   * Resolve the GitHub token in priority order:
   *   1. Token literal from config (with ${ENV} interpolated).
   *   2. SECURITY_REPO_TOKEN env var.
   *   3. GITHUB_TOKEN env var.
   *   4. `gh auth token --hostname github.com` (dev's logged-in CLI).
   *
   * Resolved once per source instance, then memoized.
   */
  private async resolveToken(): Promise<void> {
    if (this.resolvedToken !== undefined) return;
    if (this.tokenFromConfig) {
      this.resolvedToken = this.tokenFromConfig;
      return;
    }
    const fromEnv = process.env.SECURITY_REPO_TOKEN || process.env.GITHUB_TOKEN || "";
    if (fromEnv) {
      this.resolvedToken = fromEnv;
      return;
    }
    this.resolvedToken = await this.ghAuthToken();
    if (this.resolvedToken) {
      log("info", "github.token_resolved", { source_id: this.id, source: "gh-cli" });
    }
  }

  private async ghAuthToken(): Promise<string> {
    try {
      const { stdout } = await exec("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 2000 });
      return stdout.trim();
    } catch {
      return "";
    }
  }

  private toItem(rel: string, entry: TreeEntry): Item {
    const ext = extname(rel).toLowerCase();
    const stem = rel.split("/").pop()!.replace(ext, "");
    return {
      name: rel,
      source: this.id,
      title: stem,
      uri: `https://github.com/${this.owner}/${this.repo}/blob/${this.ref}/${entry.path}`,
      content_type: MIME_BY_EXT[ext] ?? "application/octet-stream",
      metadata: { sha: entry.sha, path: entry.path, size: entry.size },
    };
  }
}
