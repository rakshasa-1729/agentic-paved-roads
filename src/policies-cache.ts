import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Source } from "./sources/types.js";
import { log } from "./log.js";

const REGO_PATTERN = /\.rego$/i;

/**
 * Walk every configured policy source, fetch any `.rego` files we find,
 * and materialise them under `targetDir` mirroring their source paths.
 *
 * Conftest needs policies on disk; the GitHub source (and HTTP / MCP
 * sources) only stream content. This is the bridge.
 *
 * Returns the count of files written. Errors from individual sources are
 * logged to stderr and otherwise swallowed — a missing source should not
 * stop the server from starting.
 */
export async function materializePolicies(sources: Source[], targetDir: string): Promise<number> {
  await mkdir(targetDir, { recursive: true });

  let total = 0;
  for (const src of sources) {
    let items;
    try {
      items = await src.list();
    } catch (err) {
      log("warn", "policies_cache.list_failed", { source_id: src.id, error: describe(err) });
      continue;
    }
    for (const item of items) {
      if (!REGO_PATTERN.test(item.name)) continue;
      try {
        const full = await src.get(item.name);
        if (!full.content) continue;
        const dest = join(targetDir, item.name);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, full.content, "utf8");
        total++;
      } catch (err) {
        log("warn", "policies_cache.get_failed", {
          source_id: src.id,
          item: item.name,
          error: describe(err),
        });
      }
    }
  }
  return total;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
