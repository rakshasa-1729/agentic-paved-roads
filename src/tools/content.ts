import { z } from "zod";
import { createHash } from "node:crypto";
import type { LoadedCollection } from "../config.js";
import type { Item, Source } from "../sources/types.js";

/**
 * Fields an agent can ask `list` to keep. Defaults to every non-content
 * field; passing `fields` lets the agent shrink list responses for
 * context-budget-sensitive hosts.
 */
const LIST_FIELDS = ["name", "source", "title", "description", "uri", "content_type", "metadata", "sources"] as const;

export const ContentInputSchema = z.object({
  action: z.enum(["list", "get"]).describe("list available items or get one by name"),
  name: z.string().optional().describe("item name (required for action=get); may be prefixed by source id e.g. 'file:./policies::tagging.md'"),
  source: z.string().optional().describe("limit to a specific source id"),
  query: z.string().optional().describe("filter substring for action=list"),
  limit: z.number().int().positive().max(10_000).optional().describe("(list) cap the number of items returned; useful for large collections to stay within the model's context budget"),
  fields: z.array(z.enum(LIST_FIELDS)).optional().describe("(list) keep only these fields on each item (e.g. ['name','source'] for a compact index); `name` is recommended so the agent can later `get`"),
  dedup: z.boolean().optional().describe("(list) collapse items that share a name across sources into one entry with a `sources[]` array; default true"),
  refresh: z.boolean().optional().describe("(list) bypass source caches and re-fetch fresh data; use after a merge/deploy to see live content"),
  section: z.string().optional().describe("(get) for markdown/text, return only the body under the heading whose text matches this substring (case-insensitive); the heading line is included"),
  max_bytes: z.number().int().positive().optional().describe("(get) truncate the returned content to at most this many characters and append a [truncated] marker; pair with section to page through a large doc"),
  etag: z.string().optional().describe("(get) sha256 the agent already has; if it matches the current content the server returns {unchanged:true} instead of the full body — saves context budget when re-fetching known content"),
});

export type ContentInput = z.infer<typeof ContentInputSchema>;

export const contentJsonSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "get"], description: "list available items or get one by name" },
    name: { type: "string", description: "item name (required for action=get)" },
    source: { type: "string", description: "limit to a specific source id" },
    query: { type: "string", description: "filter substring for action=list" },
    limit: { type: "integer", minimum: 1, description: "(list) cap items returned" },
    fields: {
      type: "array",
      items: { type: "string", enum: LIST_FIELDS },
      description: "(list) keep only these fields on each item",
    },
    dedup: { type: "boolean", description: "(list) collapse same-named items across sources; default true" },
    refresh: { type: "boolean", description: "(list) bypass source caches; use after a merge to see live content" },
    section: { type: "string", description: "(get) return only a markdown/text section by heading" },
    max_bytes: { type: "integer", minimum: 1, description: "(get) truncate content to at most N chars" },
    etag: { type: "string", description: "(get) sha256 the agent already has; if it matches, returns {unchanged:true}" },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

function resolveSource(
  collection: LoadedCollection,
  sourceId?: string,
  name?: string,
): { sources: Source[]; name?: string } {
  if (name && name.includes("::")) {
    const [src, rest] = name.split("::", 2);
    const found = collection.sources.find((s) => s.id === src);
    if (!found) throw new Error(`unknown source: ${src}`);
    return { sources: [found], name: rest };
  }
  if (sourceId) {
    const found = collection.sources.find((s) => s.id === sourceId);
    if (!found) throw new Error(`unknown source: ${sourceId}`);
    return { sources: [found], name };
  }
  return { sources: collection.sources, name };
}

export async function handleContent(collection: LoadedCollection, input: ContentInput): Promise<unknown> {
  if (collection.sources.length === 0) {
    return withUsage(collection, { items: [], note: `no sources configured for collection '${collection.name}'` });
  }
  const { sources, name } = resolveSource(collection, input.source, input.name);

  if (input.action === "list") {
    const sourceErrors: { source: string; error: string }[] = [];
    const all = await Promise.all(
      sources.map(async (s) => {
        try {
          return await s.list(input.query, input.refresh ? { refresh: true } : undefined);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sourceErrors.push({ source: s.id, error: msg });
          return [
            {
              name: `__error__:${s.id}`,
              source: s.id,
              description: msg,
            } as Item,
          ];
        }
      }),
    );
    let items: Item[] = all.flat().map(stripContent);
    if (input.dedup !== false) items = dedupByName(items);
    let view: Item[] | Record<string, unknown>[] = items;
    if (input.fields) view = items.map((i) => pickFields(i, input.fields as readonly string[]));
    if (typeof input.limit === "number" && input.limit > 0) view = view.slice(0, input.limit);
    const response: Record<string, unknown> = { items: view, count: view.length };
    if (sourceErrors.length > 0) response.source_errors = sourceErrors;
    return withUsage(collection, response);
  }

  if (!name) throw new Error("action=get requires 'name'");
  const wantSection = typeof input.section === "string" && input.section.trim().length > 0 ? input.section.trim() : undefined;
  const maxBytes = typeof input.max_bytes === "number" && input.max_bytes > 0 ? input.max_bytes : undefined;

  for (const s of sources) {
    // Fetch is best-effort across sources: if one source doesn't have
    // the item (or is temporarily unreachable), try the next. Once an
    // item is in hand, though, processing errors — like an unknown
    // section — must propagate so the agent gets a precise message
    // rather than a misleading "not found in any configured source".
    let item: Item;
    try {
      item = await s.get(name);
    } catch {
      continue;
    }
    const original = item.content ?? "";
    let content = original;
    const extra: Record<string, unknown> = {};
    if (wantSection) {
      if (!isMarkdownish(item.content_type)) {
        extra.note = `section requested but content_type '${item.content_type ?? "unknown"}' is not sectionable; returned full content`;
      } else {
        const slice = extractSection(original, wantSection);
        if (slice === undefined) {
          throw new Error(`section not found in '${item.name}': ${wantSection}`);
        }
        content = slice;
        extra.section = wantSection;
      }
    }
    if (maxBytes !== undefined && content.length > maxBytes) {
      const dropped = content.length - maxBytes;
      content = content.slice(0, maxBytes) + `\n… [truncated ${dropped} chars; call get with a larger max_bytes or a more specific section]`;
      extra.truncated = true;
      extra.content_chars = original.length;
    }
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    extra.sha256 = sha256;
    if (input.etag === sha256) {
      return withUsage(collection, { name: item.name, source: item.source, sha256, unchanged: true, note: "content unchanged since previous get" });
    }
    const payload: Record<string, unknown> = { ...item, content };
    for (const [k, v] of Object.entries(extra)) payload[k] = v;
    return withUsage(collection, payload);
  }
  throw new Error(`not found in any configured source: ${name}`);
}

/**
 * Attach the collection's usage directive (if configured) to every
 * response, unless the collection opted out via `usage_on: never`.
 * Use `usage` on the collection to make follow-up actions — like
 * "always run conftest before opening a PR" — inescapable: the model
 * sees the directive on every list/get call.
 *
 * `usage_on: never` is the opt-out for context-budget-sensitive hosts
 * where the directive has already been seen once at tools/list time and
 * repeating it per call is pure overhead. (A `first`-only mode would
 * need per-session state, which the stateless HTTP transport doesn't
 * keep — so we only offer `every` / `never`.)
 */
function withUsage<T extends Record<string, unknown>>(collection: LoadedCollection, payload: T): T & { usage?: string } {
  if (!collection.usage) return payload;
  if (collection.usageOn === "never") return payload;
  return { ...payload, usage: collection.usage };
}

function stripContent(i: Item): Item {
  const { content, ...rest } = i;
  return rest;
}

/**
 * Collapse items that share a `name` across sources into a single entry.
 * The first source's item is kept verbatim; a `sources` array holds the
 * ids of every source that exposed the name. Error markers
 * (`__error__:<id>`) and unique names pass through untouched.
 */
function dedupByName(items: Item[]): Item[] {
  const order: string[] = [];
  const byName = new Map<string, { item: Item; sources: string[] }>();
  for (const it of items) {
    let slot = byName.get(it.name);
    if (!slot) {
      slot = { item: it, sources: [] };
      byName.set(it.name, slot);
      order.push(it.name);
    }
    if (!slot.sources.includes(it.source)) slot.sources.push(it.source);
  }
  return order.map((name) => {
    const { item, sources } = byName.get(name)!;
    return sources.length > 1 ? { ...item, sources } : item;
  });
}

function pickFields(item: Item, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const src = item as unknown as Record<string, unknown>;
  for (const f of fields) {
    if (f in src && src[f] !== undefined) out[f] = src[f];
  }
  return out;
}

function isMarkdownish(contentType?: string): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.includes("markdown") || ct === "text/plain";
}

/**
 * Extract the body of a markdown section by heading text. `section` is
 * matched as a case-insensitive substring against heading text at any
 * level. The returned slice includes the matched heading line and runs
 * up to the next heading of the same or higher level (or end of file).
 * Returns `undefined` if no heading matches, so the caller can surface
 * a precise "section not found" error rather than a silent full dump.
 */
function extractSection(content: string, section: string): string | undefined {
  const target = section.toLowerCase();
  const lines = content.split("\n");
  let captureLevel: number | null = null;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (!m) continue;
    const level = m[1].length;
    const text = m[2].trim().toLowerCase();
    if (captureLevel === null) {
      if (text.includes(target)) {
        captureLevel = level;
        start = i;
      }
    } else if (level <= captureLevel) {
      end = i;
      break;
    }
  }
  if (captureLevel === null) return undefined;
  return lines.slice(start, end).join("\n");
}
