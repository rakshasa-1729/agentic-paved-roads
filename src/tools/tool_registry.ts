import { z } from "zod";
import type { LoadedToolsCategory } from "../config.js";
import type { ToolEntry, ToolSource } from "../sources/types.js";

export const ToolRegistryInputSchema = z.object({
  action: z.enum(["list", "describe", "invoke"]).describe("list registered tools, describe one, or invoke one"),
  name: z.string().optional().describe("tool name (required for describe/invoke)"),
  input: z.unknown().optional().describe("arguments passed to the tool when invoking"),
  query: z.string().optional().describe("filter substring for action=list"),
  verbose: z.boolean().optional().describe("(list) include input_schema + metadata on each tool; default false keeps list responses compact (name/source/description only), use describe for the full input_schema"),
});

export type ToolRegistryInput = z.infer<typeof ToolRegistryInputSchema>;

export const toolRegistryJsonSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "describe", "invoke"], description: "list, describe, or invoke" },
    name: { type: "string", description: "tool name" },
    input: { description: "arguments passed when invoking" },
    query: { type: "string", description: "filter substring for action=list" },
    verbose: { type: "boolean", description: "(list) include input_schema + metadata per tool; default false" },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

function allSources(cat: LoadedToolsCategory): ToolSource[] {
  return [cat.registry, ...cat.mcpSources];
}

export async function handleToolRegistry(cat: LoadedToolsCategory, input: ToolRegistryInput): Promise<unknown> {
  const sources = allSources(cat);

  if (input.action === "list") {
    const all = await Promise.all(
      sources.map(async (s) => {
        try {
          return await s.list(input.query);
        } catch (err) {
          return [
            { name: `__error__:${s.id}`, source: s.id, description: err instanceof Error ? err.message : String(err) } as ToolEntry,
          ];
        }
      }),
    );
    const tools = input.verbose ? all.flat() : all.flat().map(compactTool);
    return { tools, count: tools.length };
  }

  if (!input.name) throw new Error(`action=${input.action} requires 'name'`);

  if (input.action === "describe") {
    for (const s of sources) {
      try {
        return await s.describe(input.name);
      } catch {
        // try next
      }
    }
    throw new Error(`tool not found: ${input.name}`);
  }

  // invoke
  let lastErr: string | undefined;
  for (const s of sources) {
    try {
      const known = (await s.list()).some((t) => t.name === input.name);
      if (!known) continue;
      return await s.invoke(input.name, input.input);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(lastErr ?? `tool not found: ${input.name}`);
}

/**
 * Default tool shape for `list`. Drops the (potentially large) JSON
 * `input_schema` and free-form `metadata` so the agent can hold the
 * whole registry in a few hundred tokens. `describe` returns the full
 * shape including `input_schema` — the agent should call that for the
 * one tool it's about to invoke.
 */
function compactTool(t: ToolEntry): ToolEntry {
  const { input_schema, metadata, ...rest } = t;
  return rest;
}
