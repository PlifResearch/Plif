#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Classify, createClassifier, unclear } from "./classifier.js";
import { classifyInBatch } from "./golden-batch.js";
import { evaluate, type GoldenCase, loadGolden } from "./golden.js";
import { anthropicModel } from "./model.js";
import { PROMPTS_DIR, loadClassifierPrompt } from "./prompts.js";

// --batch sends the whole set through the Message Batches API (50% price, results within 24 hours).
async function buildClassifier(cases: readonly GoldenCase[], batch: boolean): Promise<Classify> {
  const systemPrompt = await loadClassifierPrompt();
  if (!batch) return createClassifier(anthropicModel(), systemPrompt);

  const client = new Anthropic({ maxRetries: 4 });
  const byCase = await classifyInBatch(client, cases, systemPrompt, {
    onSubmitted: (id) => console.log(`batch enviado: ${id} (esperando o processamento)`),
  });
  return async (input) => byCase.get(input) ?? unclear("case not found in batch");
}

async function main(): Promise<void> {
  const cases = loadGolden(await readFile(path.join(PROMPTS_DIR, "golden", "classifier.jsonl"), "utf8"));
  const classify = await buildClassifier(cases, process.argv.includes("--batch"));
  const results = await evaluate(cases, classify);

  for (const result of results) {
    const status = result.pass ? "ok   " : "FALHA";
    const critical = result.critical ? " (critical)" : "";
    console.log(`${status} ${result.id} esperado=${result.expected} obtido=${result.actual}${critical}`);
    if (!result.pass) console.log(`       motivo: ${result.reason}`);
  }

  const passed = results.filter((result) => result.pass).length;
  const criticalFailures = results.filter((result) => result.critical && !result.pass).length;
  console.log(`\n${passed}/${results.length} cases passed. Critical failures: ${criticalFailures}.`);
  process.exitCode = criticalFailures > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
