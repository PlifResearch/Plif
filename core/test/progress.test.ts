import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { test } from "node:test";
import { runAgent } from "../src/agent.js";
import type { ModelClient, ModelProgress } from "../src/model.js";
import type { ToolContext } from "../src/types.js";

const usage = { input_tokens: 10, output_tokens: 5 };

function reply(content: unknown[]): Anthropic.Message {
  return { id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: "end_turn", stop_sequence: null, usage } as unknown as Anthropic.Message;
}

test("o stream informa as fases na ordem em que o modelo as produz e pede o resumo do raciocínio", async () => {
  const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const model: ModelClient = {
    async create() {
      throw new Error("com stream, create não deveria ser usado");
    },
    async stream(params, _options, onProgress) {
      sent.push(params);
      onProgress({ kind: "block", block: "thinking" });
      onProgress({ kind: "thinking", chars: 120 });
      onProgress({ kind: "thinking", chars: 80 });
      onProgress({ kind: "block", block: "text" });
      return reply([{ type: "text", text: "pronto" }]);
    },
  };
  const seen: ModelProgress[] = [];
  const answer = await runAgent({
    model,
    system: "sistema",
    tools: [],
    messages: [{ role: "user", content: "oi" }],
    ctx: {} as ToolContext,
    maxTurns: 3,
    events: { onProgress: (progress) => seen.push(progress) },
  });
  assert.equal(answer, "pronto");
  assert.deepEqual(seen, [
    { kind: "block", block: "thinking" },
    { kind: "thinking", chars: 120 },
    { kind: "thinking", chars: 80 },
    { kind: "block", block: "text" },
  ]);
  assert.deepEqual(sent[0]?.thinking, { type: "adaptive", display: "summarized" });
});

test("cliente sem stream recebe uma requisição comum e não gera progresso", async () => {
  let calls = 0;
  const model: ModelClient = {
    async create() {
      calls++;
      return reply([{ type: "text", text: "sem stream" }]);
    },
  };
  const seen: ModelProgress[] = [];
  const answer = await runAgent({
    model,
    system: "sistema",
    tools: [],
    messages: [{ role: "user", content: "oi" }],
    ctx: {} as ToolContext,
    maxTurns: 3,
    events: { onProgress: (progress) => seen.push(progress) },
  });
  assert.equal(answer, "sem stream");
  assert.equal(calls, 1);
  assert.equal(seen.length, 0);
});
