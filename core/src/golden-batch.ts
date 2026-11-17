import type Anthropic from "@anthropic-ai/sdk";
import { type Classification, type ClassifierInput, classificationFrom, classifierRequest, unclear } from "./classifier.js";
import type { GoldenCase } from "./golden.js";

const CUSTOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface BatchOptions {
  readonly modelId?: string;
  readonly pollMs?: number;
  readonly wait?: (ms: number) => Promise<void>;
  readonly onSubmitted?: (batchId: string) => void;
}

// Message Batches API: 50% of the standard price, results within 24 hours.
// https://platform.claude.com/docs/en/build-with-claude/batch-processing
export async function classifyInBatch(
  client: Anthropic,
  cases: readonly GoldenCase[],
  systemPrompt: string,
  options: BatchOptions = {},
): Promise<Map<ClassifierInput, Classification>> {
  for (const testCase of cases) {
    if (!CUSTOM_ID.test(testCase.id)) throw new Error(`custom_id invalid for batch: ${testCase.id}`);
  }
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const batch = await client.messages.batches.create({
    requests: cases.map((testCase) => ({
      custom_id: testCase.id,
      params: classifierRequest(testCase.input, systemPrompt, options.modelId),
    })),
  });
  options.onSubmitted?.(batch.id);

  let current = batch;
  while (current.processing_status !== "ended") {
    await wait(options.pollMs ?? 30_000);
    current = await client.messages.batches.retrieve(batch.id);
  }

  const byId = new Map<string, Classification>();
  for await (const entry of await client.messages.batches.results(batch.id)) {
    const result = entry.result;
    byId.set(
      entry.custom_id,
      result.type === "succeeded" ? classificationFrom(result.message) : unclear(`batch request ${result.type}`),
    );
  }

  const byCase = new Map<ClassifierInput, Classification>();
  for (const testCase of cases) {
    byCase.set(testCase.input, byId.get(testCase.id) ?? unclear("missing from batch results"));
  }
  return byCase;
}
