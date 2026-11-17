import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSystemPrompt } from "../src/prompts.js";
import { TOOLS } from "../src/tools/index.js";

test("documentação de ferramentas inclui só as ferramentas disponíveis", async () => {
  const prompt = await loadSystemPrompt(["Read"]);
  assert.match(prompt, /<tool name="Read">/);
  assert.doesNotMatch(prompt, /<tool name="Agent">/);
});

test("prompt de sistema traz o fluxo de trabalho para o agente e os subagentes", async () => {
  for (const tools of [["Read", "Grep", "Glob", "Bash", "Write", "Edit", "Plan"], ["Read", "Grep", "Glob"]]) {
    const prompt = await loadSystemPrompt(tools);
    for (const block of ["workflow", "scope", "tests_integrity", "when_stuck", "long_tasks"]) {
      assert.match(prompt, new RegExp(`<${block}>[\\s\\S]+</${block}>`), block);
    }
    assert.match(prompt, /Reproduce a bug before fixing it/);
  }
});

test("definições das ferramentas seguem as regras de strict tool use", () => {
  assert.equal(TOOLS.length, 15);
  for (const tool of TOOLS) {
    const schema = tool.definition.input_schema as { additionalProperties?: unknown; required?: unknown };
    assert.equal(schema.additionalProperties, false, tool.name);
    const json = JSON.stringify(tool.definition.input_schema);
    for (const keyword of ["minLength", "maxLength", "minimum", "maximum", "$schema"]) {
      assert.equal(json.includes(`"${keyword}"`), false, `${tool.name}: ${keyword}`);
    }
  }
});

// The API also caps the compiled grammar below these numbers, so the strict set keeps a wide margin.
test("ferramentas strict ficam bem abaixo dos limites da gramática", () => {
  const strict = TOOLS.filter((tool) => tool.definition.strict === true);
  assert.deepEqual(
    strict.map((tool) => tool.name),
    ["Read", "Write", "Edit", "Grep", "Bash", "Git", "WebSearch", "WebFetch"],
  );
  let optional = 0;
  for (const tool of strict) {
    const schema = tool.definition.input_schema as { properties?: Record<string, unknown>; required?: string[] };
    const required = new Set(schema.required ?? []);
    optional += Object.keys(schema.properties ?? {}).filter((key) => !required.has(key)).length;
  }
  assert.ok(optional <= 12, `parâmetros opcionais em ferramentas strict: ${optional}`);
});

test("limites removidos do schema continuam visíveis para o modelo na descrição", () => {
  const bash = TOOLS.find((tool) => tool.name === "Bash");
  const properties = (bash?.definition.input_schema as { properties: Record<string, { description?: string }> }).properties;
  assert.match(properties["timeout_ms"]?.description ?? "", /minimum 1000/);
});
