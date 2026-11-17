import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { test } from "node:test";
import { type ClassifierInput, createClassifier } from "../src/classifier.js";
import type { ModelClient } from "../src/model.js";

const input: ClassifierInput = {
  user_messages: ["roda os testes"],
  recent_actions: [],
  pending_action: { tool: "Bash", input: { command: "npm test" } },
  model_reason: "rodar os testes",
  project_policy: "",
};

function modelReplying(text: string, stopReason = "end_turn"): ModelClient {
  return {
    async create() {
      return { content: [{ type: "text", text }], stop_reason: stopReason } as unknown as Anthropic.Message;
    },
  };
}

test("devolve a decisão do JSON estruturado", async () => {
  const reply = JSON.stringify({ decision: "allow", rule: "clearly_safe", reason: "teste pedido" });
  const classify = createClassifier(modelReplying(reply), "prompt");
  assert.deepEqual(await classify(input), { decision: "allow", rule: "clearly_safe", reason: "teste pedido" });
});

test("resposta fora do formato, recusa e corte viram ask_user", async () => {
  const allow = JSON.stringify({ decision: "allow", rule: "clearly_safe", reason: "x" });
  const cases: Array<[string, string]> = [
    ["não é json", "end_turn"],
    [JSON.stringify({ decision: "yes", rule: "clearly_safe", reason: "x" }), "end_turn"],
    ["", "refusal"],
    [allow, "max_tokens"],
  ];
  for (const [text, stop] of cases) {
    const result = await createClassifier(modelReplying(text, stop), "prompt")(input);
    assert.equal(result.decision, "ask_user", text);
  }
});

test("pede o Haiku 5.5 com saída estruturada, sem raciocínio visível e sem temperature", async () => {
  let sent: Anthropic.MessageCreateParamsNonStreaming | undefined;
  const model: ModelClient = {
    async create(params) {
      sent = params;
      const text = JSON.stringify({ decision: "allow", rule: "clearly_safe", reason: "ok" });
      return { content: [{ type: "text", text }], stop_reason: "end_turn" } as unknown as Anthropic.Message;
    },
  };
  await createClassifier(model, "prompt")(input);
  assert.equal(sent?.model, "claude-haiku-5-5");
  assert.deepEqual(sent?.thinking, { type: "disabled" });
  assert.equal((sent?.output_config as { format?: { type?: string } } | undefined)?.format?.type, "json_schema");
  assert.equal("temperature" in (sent ?? {}), false);
});
