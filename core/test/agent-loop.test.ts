import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runAgent } from "../src/agent.js";
import type { ModelClient } from "../src/model.js";
import { TOOLS } from "../src/tools/index.js";
import type { ToolContext } from "../src/types.js";

const usage = { input_tokens: 10, output_tokens: 5 };

function reply(content: unknown[], stopReason = "end_turn", tokens = usage) {
  return { id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: stopReason, stop_sequence: null, usage: tokens };
}

function scripted(replies: unknown[]): { model: ModelClient; requests: Anthropic.MessageCreateParamsNonStreaming[] } {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const queue = [...replies];
  return {
    requests,
    model: {
      async create(params) {
        requests.push(structuredClone(params));
        const next = queue.shift();
        if (next === undefined) throw new Error("no scripted reply left");
        return next as Anthropic.Message;
      },
    },
  };
}

async function context(): Promise<ToolContext> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-loop-")));
  const root = path.join(base, "project");
  await writeFile(path.join(base, "placeholder"), "");
  return {
    root,
    home: path.join(base, "home"),
    session: "loop",
    sandbox: null,
    mode: { approval: "on-request", readOnly: false },
    readFiles: new Set(),
    approver: { ask: async () => "deny" },
    log: { record: async () => {} },
  };
}

const user = (text: string): Anthropic.MessageParam => ({ role: "user", content: text });

test("max_tokens sem ferramenta devolve o texto com aviso de corte", async () => {
  const { model } = scripted([reply([{ type: "text", text: "partial answer" }], "max_tokens")]);
  const answer = await runAgent({ model, system: "s", tools: TOOLS, messages: [user("go")], ctx: await context(), maxTurns: 3 });
  assert.match(answer, /partial answer/);
  assert.match(answer, /max_tokens limit was reached/);
});

test("estouro de janela aciona compactação e tenta de novo", async () => {
  const history: Anthropic.MessageParam[] = [user("a"), { role: "assistant", content: "b" }, user("c"), { role: "assistant", content: "d" }, user("e"), { role: "assistant", content: "f" }, user("g")];
  const { model } = scripted([reply([], "model_context_window_exceeded"), reply([{ type: "text", text: "done" }])]);
  let summaries = 0;
  const answer = await runAgent({
    model,
    system: "s",
    tools: TOOLS,
    messages: history,
    ctx: await context(),
    maxTurns: 5,
    summarize: async () => {
      summaries++;
      return "summary of a to d";
    },
  });
  assert.equal(answer, "done");
  assert.equal(summaries, 1);
  assert.match(String(history[0]?.content), /conversation_summary/);
});

test("chamada idêntica repetida três vezes seguidas é bloqueada", async () => {
  const path_ = path.join(await realpath(await mkdtemp(path.join(tmpdir(), "plif-rep-"))), "a.txt");
  await writeFile(path_, "x\n");
  const call = { type: "tool_use", name: "Read", input: { file_path: path_ } };
  const { model, requests } = scripted([
    reply([{ ...call, id: "t1" }], "tool_use"),
    reply([{ ...call, id: "t2" }], "tool_use"),
    reply([{ ...call, id: "t3" }], "tool_use"),
    reply([{ type: "text", text: "stopped" }]),
  ]);
  await runAgent({ model, system: "s", tools: TOOLS, messages: [user("read it")], ctx: await context(), maxTurns: 6 });
  const last = requests[3]?.messages.at(-1)?.content as Array<{ content: string; is_error?: boolean }>;
  assert.equal(last[0]?.is_error, true);
  assert.match(last[0]?.content ?? "", /3 times in a row/);
});

test("orçamento de tokens interrompe o pedido quando estoura", async () => {
  const heavy = reply([{ type: "text", text: "x" }], "end_turn", { input_tokens: 9000, output_tokens: 2000 });
  const { model } = scripted([heavy, heavy]);
  await assert.rejects(
    runAgent({ model, system: "s", tools: TOOLS, messages: [user("go")], ctx: await context(), maxTurns: 3, maxTotalTokens: 10_000 }),
    /token budget exceeded/,
  );
});

test("cache de escrita custa mais e leitura custa menos no orçamento", async () => {
  const cached = reply([{ type: "text", text: "ok" }], "end_turn", {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 4000,
    cache_read_input_tokens: 40_000,
  } as Anthropic.Usage);
  const { model } = scripted([cached]);
  const answer = await runAgent({ model, system: "s", tools: TOOLS, messages: [user("go")], ctx: await context(), maxTurns: 2, maxTotalTokens: 9000 });
  assert.equal(answer, "ok");
});

test("cancelamento antes da chamada interrompe o turno", async () => {
  const { model } = scripted([reply([{ type: "text", text: "never" }])]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runAgent({ model, system: "s", tools: TOOLS, messages: [user("go")], ctx: await context(), maxTurns: 2, signal: controller.signal }),
    /interrupted/,
  );
});
