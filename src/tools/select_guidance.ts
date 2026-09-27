// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { GuidanceSelector, SelectOutput } from "../selector/index.js";

export const SELECT_GUIDANCE_TOOL = "select_guidance";

export const SelectGuidanceInputSchema = z
  .object({
    task: z.string().trim().min(1).max(8_000).describe("what the agent is about to do, in plain language"),
    context: z
      .object({
        repo: z.string().max(500).optional(),
        files: z.array(z.string().max(500)).max(200).optional(),
        language: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SelectGuidanceInput = z.infer<typeof SelectGuidanceInputSchema>;

export const selectGuidanceJsonSchema = {
  type: "object",
  properties: {
    task: { type: "string", description: "what the agent is about to do, in plain language (e.g. 'add an S3 bucket for invoice PDFs')" },
    context: {
      type: "object",
      properties: {
        repo: { type: "string", description: "repository or component name" },
        files: { type: "array", items: { type: "string" }, description: "paths the change will touch" },
        language: { type: "string", description: "primary language or IaC tool (terraform, helm, …)" },
      },
      additionalProperties: false,
    },
  },
  required: ["task"],
  additionalProperties: false,
} as const;

export function selectGuidanceDescription(selector: GuidanceSelector): string {
  return (
    `Describe the task you are about to do and get back which items from ${selector.collectionNames.join(", ")} apply, ` +
    "with probabilities. Call this first, then fetch the returned items with action=get. " +
    "The task text is sent to an external decision model (TypeSafe Jev)."
  );
}

export async function handleSelectGuidance(
  selector: GuidanceSelector,
  input: SelectGuidanceInput,
  isAllowed: (collection: string) => boolean,
): Promise<SelectOutput> {
  return selector.select(input, isAllowed);
}
