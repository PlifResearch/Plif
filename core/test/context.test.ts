import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { test } from "node:test";
import { clearOldToolResults, compactHistory } from "../src/context.js";

function resultMessage(id: string, chars: number): Anthropic.MessageParam {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(chars) }],
  };
}

test("limpeza de resultados antigos preserva os últimos e só age em lote", () => {
  const messages: Anthropic.MessageParam[] = [];
  for (let index = 0; index < 5; index++) messages.push(resultMessage(`t${index}`, 1000));

  assert.equal(clearOldToolResults(messages, 3, 10_000), 0, "below the batch size nothing is cleared");
  assert.equal(clearOldToolResults(messages, 3, 1000), 2);

  const contents = messages.map((message) => (message.content as Anthropic.ToolResultBlockParam[])[0]?.content);
  assert.match(String(contents[0]), /tool output cleared/);
  assert.match(String(contents[1]), /tool output cleared/);
  assert.equal(String(contents[4]).length, 1000);
});

test("compactação resume o começo e mantém o trecho recente a partir de uma mensagem real do usuário", async () => {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "task" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    resultMessage("t1", 10),
    { role: "assistant", content: "found it" },
    { role: "user", content: "next" },
    { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] },
    resultMessage("t2", 10),
    { role: "assistant", content: "ok" },
    { role: "user", content: "now" },
    { role: "assistant", content: "working" },
  ];
  let summarized = 0;
  const result = await compactHistory(messages, async (old) => {
    summarized = old.length;
    return "SUMMARY";
  }, 4);

  assert.equal(summarized, 8);
  assert.ok(result !== null);
  assert.equal(result?.length, 2);
  assert.match(String(result?.[0]?.content), /<conversation_summary>[\s\S]*SUMMARY[\s\S]*now/);
});

test("compactação recusa cortar quando não há mensagem real do usuário no trecho recente", async () => {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "task" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    resultMessage("t1", 10),
  ];
  const result = await compactHistory(messages, async () => "unused", 2);
  assert.equal(result, null);
});
