// SPDX-License-Identifier: Apache-2.0
import { extname } from "node:path";
import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import mm from "micromatch";
import type { Item, Source } from "./types.js";
import { interpolateEnv } from "../util/env.js";
import { abortableFetch } from "../util/timeout.js";
import { log } from "../log.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_REFRESH_TTL_MS = 5 * 60_000;

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".rego": "application/rego",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".json": "application/json",
};

export interface OpaBundleSourceConfig {
  type: "opa-bundle";
  name?: string;
  /** HTTPS URL to a `.tar.gz` OPA bundle. */
  url: string;
  /** Optional auth headers (e.g. `Authorization: Bearer …` for GHCR). */
  headers?: Record<string, string>;
  /** Glob patterns applied to bundle entry paths. Default: all files. */
  patterns?: string[];
  /** Per-fetch timeout. Default 30s. */
  timeout_ms?: number;
  /** Cache TTL for the materialized bundle. Default 5 min. */
  refresh_ttl_ms?: number;
}

interface BundleEntry {
  path: string;
  body: Buffer;
}

/**
 * Source that fetches an OPA bundle (`.tar.gz`) from HTTPS, extracts
 * it into memory, and exposes the contained `.rego` / `.md` / `.json`
 * files through the standard list/get interface.
 *
 * The bundle is cached in-process for `refresh_ttl_ms` (default 5
 * min). A failed refresh keeps the prior cache live so a transient
 * registry blip doesn't take the source offline.
 *
 * Out of scope for v1 (tracked separately):
 *   - OCI (oras) pulls. Use HTTPS from a registry that exposes
 *     bundles directly (GitHub releases, S3, GCS, GHCR via the
 *     "raw blob" REST endpoint).
 *   - cosign verification. Bundles are trusted by URL ownership for
 *     now; pre-verify them in CI when integrity matters.
 */
export class OpaBundleSource implements Source {
  readonly id: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly patterns: string[];
  private readonly timeoutMs: number;
  private readonly refreshTtlMs: number;
  private cache?: { ts: number; entries: BundleEntry[] };
  private inflight?: Promise<BundleEntry[]>;

  constructor(cfg: OpaBundleSourceConfig) {
    this.url = cfg.url;
    this.headers = Object.fromEntries(
      Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, interpolateEnv(v)]),
    );
    this.patterns = cfg.patterns?.length ? cfg.patterns : ["**/*"];
    this.timeoutMs = cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this.refreshTtlMs = cfg.refresh_ttl_ms ?? DEFAULT_REFRESH_TTL_MS;
    this.id = cfg.name ?? `opa-bundle:${cfg.url}`;
  }

  async list(query?: string): Promise<Item[]> {
    const entries = await this.entries();
    // dot: true so OPA's `.manifest` and other dotfiles are surfaced.
    // Bundles intentionally use them; defaulting to skip would hide
    // real content.
    const items = entries
      .filter((e) => mm.isMatch(e.path, this.patterns, { dot: true }))
      .map((e) => this.toItem(e));
    if (!query) return items;
    const q = query.toLowerCase();
    return items.filter((i) => i.name.toLowerCase().includes(q));
  }

  async get(name: string): Promise<Item> {
    const entries = await this.entries();
    const match = entries.find((e) => e.path === name) ?? entries.find((e) => e.path.endsWith(`/${name}`));
    if (!match) throw new Error(`${this.id}: not found: ${name}`);
    return { ...this.toItem(match), content: match.body.toString("utf8") };
  }

  private async entries(): Promise<BundleEntry[]> {
    if (this.cache && Date.now() - this.cache.ts < this.refreshTtlMs) {
      return this.cache.entries;
    }
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const fresh = await this.download();
        this.cache = { ts: Date.now(), entries: fresh };
        log("info", "opa_bundle.refreshed", { source_id: this.id, entries: fresh.length });
        return fresh;
      } catch (err) {
        if (this.cache) {
          // Serve stale rather than crashing the source on a transient
          // registry blip. Operators see the warn and can act.
          log("warn", "opa_bundle.refresh_failed_using_cache", {
            source_id: this.id,
            error: err instanceof Error ? err.message : String(err),
            cache_age_ms: Date.now() - this.cache.ts,
          });
          return this.cache.entries;
        }
        throw err;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  private async download(): Promise<BundleEntry[]> {
    const res = await abortableFetch(this.url, { headers: this.headers }, this.timeoutMs, this.id);
    if (!res.ok || !res.body) {
      throw new Error(`${this.id}: download failed: ${res.status} ${res.statusText}`);
    }
    return extractTarball(res.body as ReadableStream<Uint8Array>);
  }

  private toItem(entry: BundleEntry): Item {
    const ext = extname(entry.path).toLowerCase();
    const stem = entry.path.split("/").pop()!.replace(ext, "");
    return {
      name: entry.path,
      source: this.id,
      title: stem,
      uri: `${this.url}#${entry.path}`,
      content_type: MIME_BY_EXT[ext] ?? "application/octet-stream",
      metadata: { size: entry.body.length },
    };
  }
}

/**
 * Stream-extract a gzipped tar archive into memory. Skips directories
 * and symlinks; collects every regular-file entry as { path, body }.
 *
 * Caps total extracted size at 32 MiB so a malicious or malformed
 * bundle can't OOM the process.
 */
async function extractTarball(stream: ReadableStream<Uint8Array>): Promise<BundleEntry[]> {
  const entries: BundleEntry[] = [];
  let totalBytes = 0;
  const MAX_TOTAL = 32 * 1024 * 1024;

  const parser = new tar.Parser();
  parser.on("entry", (entry) => {
    if (entry.type !== "File") {
      entry.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let entryBytes = 0;
    entry.on("data", (chunk: Buffer) => {
      entryBytes += chunk.length;
      totalBytes += chunk.length;
      if (totalBytes > MAX_TOTAL) {
        entry.destroy(new Error(`bundle exceeds ${MAX_TOTAL} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    entry.on("end", () => {
      entries.push({ path: entry.path.replace(/^\.\//, ""), body: Buffer.concat(chunks, entryBytes) });
    });
  });

  await pipeline(Readable.fromWeb(stream), createGunzip(), parser);
  return entries;
}
