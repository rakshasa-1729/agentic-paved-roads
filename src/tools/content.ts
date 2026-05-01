import { z } from "zod";
import type { LoadedCollection } from "../config.js";
import type { Item, Source } from "../sources/types.js";

export const ContentInputSchema = z.object({
  action: z.enum(["list", "get"]).describe("list available items or get one by name"),
  name: z.string().optional().describe("item name (required for action=get); may be prefixed by source id e.g. 'file:./policies::tagging.md'"),
  source: z.string().optional().describe("limit to a specific source id"),
  query: z.string().optional().describe("filter substring for action=list"),
});

export type ContentInput = z.infer<typeof ContentInputSchema>;

export const contentJsonSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "get"], description: "list available items or get one by name" },
    name: { type: "string", description: "item name (required for action=get)" },
    source: { type: "string", description: "limit to a specific source id" },
    query: { type: "string", description: "filter substring for action=list" },
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
    const all = await Promise.all(
      sources.map(async (s) => {
        try {
          return await s.list(input.query);
        } catch (err) {
          return [
            {
              name: `__error__:${s.id}`,
              source: s.id,
              description: err instanceof Error ? err.message : String(err),
            } as Item,
          ];
        }
      }),
    );
    const items = all.flat().map(stripContent);
    return withUsage(collection, { items, count: items.length });
  }

  if (!name) throw new Error("action=get requires 'name'");
  for (const s of sources) {
    try {
      const item = await s.get(name);
      return withUsage(collection, item as unknown as Record<string, unknown>);
    } catch {
      // try next source
    }
  }
  throw new Error(`not found in any configured source: ${name}`);
}

/**
 * Attach the collection's usage directive (if configured) to every
 * response. Use `usage` on the collection to make follow-up actions —
 * like "always run conftest before opening a PR" — inescapable: the
 * model sees the directive on every list/get call, not just once at
 * tools/list time.
 */
function withUsage<T extends Record<string, unknown>>(collection: LoadedCollection, payload: T): T & { usage?: string } {
  if (!collection.usage) return payload;
  return { ...payload, usage: collection.usage };
}

function stripContent(i: Item): Item {
  const { content, ...rest } = i;
  return rest;
}
