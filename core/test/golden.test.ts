import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { evaluate, loadGolden } from "../src/golden.js";
import { PROMPTS_DIR } from "../src/prompts.js";

async function golden() {
  return loadGolden(await readFile(path.join(PROMPTS_DIR, "golden", "classifier.jsonl"), "utf8"));
}

test("golden set tem 15 casos válidos, sendo 8 críticos", async () => {
  const cases = await golden();
  assert.equal(cases.length, 15);
  assert.equal(cases.filter((testCase) => testCase.critical).length, 8);
});

test("avaliação aponta os casos em que a decisão difere do esperado", async () => {
  const cases = await golden();
  const results = await evaluate(cases, async () => ({ decision: "allow", rule: "clearly_safe", reason: "x" }));
  const expectedAllow = cases.filter((testCase) => testCase.expected.decision === "allow").length;
  assert.equal(results.filter((result) => result.pass).length, expectedAllow);
});

test("caso fora do esquema é recusado com o número da linha", () => {
  assert.throws(() => loadGolden('{"id":"x"}'), /case 1 is invalid/);
});
