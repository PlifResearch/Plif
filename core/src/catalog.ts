import { readFile } from "node:fs/promises";
import { z } from "zod";

const EFFORT = z.enum(["low", "medium", "high", "xhigh", "max"]);

const MODEL = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  efforts: z.array(EFFORT).min(1),
  defaultEffort: EFFORT,
  note: z.string().optional(),
  // OpenAI format only. Unset: the official API gets max_completion_tokens and reasoning_effort, other servers get
  // max_tokens and no reasoning_effort.
  maxTokensField: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
  reasoningEffort: z.boolean().optional(),
});

export const CatalogSchema = z
  .object({
    default: z.string().min(1),
    classifier: z.string().min(1),
    models: z.array(MODEL).min(1),
  })
  .refine((catalog) => catalog.models.some((model) => model.id === catalog.default), {
    message: "the default model is not in models",
  });

export type Catalog = z.infer<typeof CatalogSchema>;
export type ModelEntry = z.infer<typeof MODEL>;

export async function loadCatalog(file: string): Promise<Catalog> {
  return CatalogSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

export function findModel(catalog: Catalog, id: string): ModelEntry | undefined {
  return catalog.models.find((model) => model.id === id);
}
