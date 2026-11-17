import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { mkdir, mkdtemp, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runAgent } from "../src/agent.js";
import type { Classification } from "../src/classifier.js";
import { ClassifierGate } from "../src/gate.js";
import type { ModelClient } from "../src/model.js";
import { TOOLS } from "../src/tools/index.js";
import type { ApprovalAnswer, ApprovalRequest, ToolContext } from "../src/types.js";

function scripted(replies: unknown[]): ModelClient {
  const queue = [...replies];
  return {
    async create() {
      const next = queue.shift();
      if (next === undefined) throw new Error("sem resposta roteirizada");
      return next as Anthropic.Message;
    },
  };
}

const reply = (content: unknown[], stopReason = "tool_use") => ({
  id: "msg_teste",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

async function run(verdict: Classification, choice: ApprovalAnswer) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-gate-")));
  const root = path.join(base, "projeto");
  await mkdir(root);
  const asked: ApprovalRequest[] = [];
  const logged: Record<string, unknown>[] = [];
  const ctx: ToolContext = {
    root,
    home: path.join(base, "casa"),
    session: "teste",
    sandbox: null,
    mode: { approval: "on-request", readOnly: false },
    readFiles: new Set(),
    sessionApprovals: new Set(),
    approver: {
      async ask(request) {
        asked.push(request);
        return choice;
      },
    },
    log: {
      record: async (entry) => {
        logged.push(entry);
      },
    },
  };
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "gera o marcador" }];
  const model = scripted([
    reply([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo x > marcador.txt", description: "gravar marcador" } }]),
    reply([{ type: "text", text: "pronto" }], "end_turn"),
  ]);
  const answer = await runAgent({
    model,
    system: "teste",
    tools: TOOLS,
    messages,
    ctx,
    maxTurns: 4,
    gate: new ClassifierGate(async () => verdict),
    projectPolicy: "",
  });
  const toolResult = messages.find((message) => Array.isArray(message.content) && message.role === "user");
  const content = (toolResult?.content as unknown as Array<{ content: string }> | undefined)?.[0]?.content ?? "";
  return { root, asked, answer, content, logged };
}

test("classificador que libera executa sem pedir ao usuário", async () => {
  const { root, asked } = await run({ decision: "allow", rule: "authorized_scope", reason: "pedido" }, "deny");
  assert.equal(asked.length, 0);
  await stat(path.join(root, "marcador.txt"));
});

test("classificador que recusa bloqueia sem pedir ao usuário", async () => {
  const { root, asked, content } = await run({ decision: "deny", rule: "outside_scope", reason: "fora" }, "once");
  assert.equal(asked.length, 0);
  assert.match(content, /blocked by the classifier/);
  await assert.rejects(stat(path.join(root, "marcador.txt")));
});

test("classificador que pede revisão envia a dúvida ao usuário", async () => {
  const { root, asked } = await run({ decision: "ask_user", rule: "unclear", reason: "doubt" }, "deny");
  assert.equal(asked.length, 1);
  assert.match(asked[0]?.reason ?? "", /Classifier: doubt/);
  await assert.rejects(stat(path.join(root, "marcador.txt")));
});

test("resposta do usuário negada não executa e registra a recusa", async () => {
  const { root, asked, content } = await run({ decision: "ask_user", rule: "unclear", reason: "doubt" }, "deny");
  assert.equal(asked.length, 1);
  assert.match(content, /the user did not approve/);
  await assert.rejects(stat(path.join(root, "marcador.txt")));
});

test("aprovação só desta vez executa e não guarda a assinatura", async () => {
  const { root, asked, logged } = await run({ decision: "ask_user", rule: "unclear", reason: "doubt" }, "once");
  assert.equal(asked.length, 1);
  await stat(path.join(root, "marcador.txt"));
  assert.equal(logged.at(-1)?.approvedBy, "user");
});

test("aprovação da sessão cobre a mesma ação sem perguntar de novo", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-gate-")));
  const root = path.join(base, "projeto");
  await mkdir(root);
  const asked: ApprovalRequest[] = [];
  const logged: Record<string, unknown>[] = [];
  const ctx: ToolContext = {
    root,
    home: path.join(base, "casa"),
    session: "teste",
    sandbox: null,
    mode: { approval: "on-request", readOnly: false },
    readFiles: new Set(),
    sessionApprovals: new Set(),
    approver: {
      async ask(request) {
        asked.push(request);
        return "session";
      },
    },
    log: {
      record: async (entry) => {
        logged.push(entry);
      },
    },
  };
  const command = "echo x > marcador.txt";
  const model = scripted([
    reply([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command, description: "gravar" } }]),
    reply([{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command, description: "gravar de novo" } }]),
    reply([{ type: "text", text: "pronto" }], "end_turn"),
  ]);
  await runAgent({
    model,
    system: "teste",
    tools: TOOLS,
    messages: [{ role: "user", content: "gera o marcador duas vezes" }],
    ctx,
    maxTurns: 4,
    gate: new ClassifierGate(async () => ({ decision: "ask_user", rule: "unclear", reason: "doubt" })),
    projectPolicy: "",
  });
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.summary, command);
  assert.deepEqual(logged.map((entry) => entry.approvedBy), ["user", "session"]);
  assert.ok(ctx.sessionApprovals?.has(`Bash ${command}`));
});
