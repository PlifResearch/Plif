import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runAgent } from "../src/agent.js";
import type { ModelClient } from "../src/model.js";
import { TOOLS } from "../src/tools/index.js";
import type { ApprovalAnswer, ApprovalRequest, ToolContext } from "../src/types.js";

type StopReason = "tool_use" | "end_turn" | "max_tokens" | "refusal";

function scripted(replies: unknown[]): { model: ModelClient; requests: Anthropic.MessageCreateParamsNonStreaming[] } {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const queue = [...replies];
  const model: ModelClient = {
    async create(params) {
      requests.push(structuredClone(params));
      const next = queue.shift();
      if (next === undefined) throw new Error("sem resposta roteirizada");
      return next as Anthropic.Message;
    },
  };
  return { model, requests };
}

function reply(content: unknown[], stopReason: StopReason = "tool_use") {
  return {
    id: "msg_teste",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const text = (value: string) => ({ type: "text", text: value });

async function setup(choice: ApprovalAnswer): Promise<{ root: string; ctx: ToolContext; asked: ApprovalRequest[] }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-agente-")));
  const root = path.join(base, "projeto");
  await mkdir(root);
  const asked: ApprovalRequest[] = [];
  const ctx: ToolContext = {
    root,
    home: path.join(base, "casa"),
    session: "teste",
    sandbox: null,
    mode: { approval: "on-request", readOnly: false },
    readFiles: new Set(),
    approver: {
      async ask(request) {
        asked.push(request);
        return choice;
      },
    },
    log: { record: async () => {} },
  };
  return { root, ctx, asked };
}

function resultsOf(request: Anthropic.MessageCreateParamsNonStreaming): Array<Record<string, unknown>> {
  const last = request.messages.at(-1);
  return Array.isArray(last?.content) ? (last.content as unknown as Array<Record<string, unknown>>) : [];
}

async function run(model: ModelClient, ctx: ToolContext, task = "faça a tarefa"): Promise<string> {
  return runAgent({
    model,
    system: "sistema de teste",
    tools: TOOLS,
    messages: [{ role: "user", content: task }],
    ctx,
    maxTurns: 4,
  });
}

test("resposta sem ferramenta encerra o turno", async () => {
  const { ctx } = await setup("deny");
  const { model } = scripted([reply([text("pronto")], "end_turn")]);
  assert.equal(await run(model, ctx), "pronto");
});

test("Read devolve tool_result com o mesmo id e a conversa continua", async () => {
  const { root, ctx } = await setup("deny");
  await writeFile(path.join(root, "a.txt"), "olá\n");
  const { model, requests } = scripted([
    reply([toolUse("toolu_1", "Read", { file_path: path.join(root, "a.txt") })]),
    reply([text("lido")], "end_turn"),
  ]);
  assert.equal(await run(model, ctx), "lido");
  assert.deepEqual(resultsOf(requests[1]!), [{ type: "tool_result", tool_use_id: "toolu_1", content: "1\tolá" }]);
});

test("chamadas paralelas voltam juntas em uma única mensagem do usuário", async () => {
  const { root, ctx } = await setup("deny");
  await writeFile(path.join(root, "a.txt"), "a\n");
  await writeFile(path.join(root, "b.txt"), "b\n");
  const { model, requests } = scripted([
    reply([
      toolUse("toolu_a", "Read", { file_path: path.join(root, "a.txt") }),
      toolUse("toolu_b", "Read", { file_path: path.join(root, "b.txt") }),
    ]),
    reply([text("feito")], "end_turn"),
  ]);
  await run(model, ctx);
  assert.deepEqual(
    resultsOf(requests[1]!).map((result) => result["tool_use_id"]),
    ["toolu_a", "toolu_b"],
  );
});

test("resposta cortada pelo max_tokens não executa ferramenta", async () => {
  const { root, ctx } = await setup("once");
  const target = path.join(root, "nao-criado.txt");
  const { model, requests } = scripted([
    reply([toolUse("toolu_w", "Write", { file_path: target, content: "x" })], "max_tokens"),
    reply([text("ok")], "end_turn"),
  ]);
  await run(model, ctx);
  await assert.rejects(stat(target));
  const [result] = resultsOf(requests[1]!);
  assert.equal(result?.["is_error"], true);
  assert.match(String(result?.["content"]), /max_tokens/);
});

test("bloqueio do level 0 não pede aprovação", async () => {
  const { ctx, asked } = await setup("once");
  const { model, requests } = scripted([
    reply([toolUse("toolu_b", "Bash", { command: "sudo rm -rf /*", description: "limpar" })]),
    reply([text("ok")], "end_turn"),
  ]);
  await run(model, ctx);
  assert.deepEqual(asked, []);
  const [result] = resultsOf(requests[1]!);
  assert.equal(result?.["is_error"], true);
  assert.match(String(result?.["content"]), /level 0/);
});

test("ação de nível 3 recusada pelo usuário não é executada", async () => {
  const { root, ctx } = await setup("deny");
  const { model, requests } = scripted([
    reply([toolUse("toolu_r", "Bash", { command: "echo x > marcador.txt", description: "gravar marcador" })]),
    reply([text("ok")], "end_turn"),
  ]);
  await run(model, ctx);
  await assert.rejects(stat(path.join(root, "marcador.txt")));
  assert.match(String(resultsOf(requests[1]!)[0]?.["content"]), /did not approve/);
});

test("ação de nível 3 aprovada roda na raiz do projeto", async () => {
  const { root, ctx, asked } = await setup("once");
  const { model, requests } = scripted([
    reply([toolUse("toolu_ok", "Bash", { command: "echo ola > marcador.txt", description: "gravar marcador" })]),
    reply([text("feito")], "end_turn"),
  ]);
  await run(model, ctx);
  assert.equal(asked.length, 1);
  assert.equal(await readFile(path.join(root, "marcador.txt"), "utf8"), "ola\n");
  assert.match(String(resultsOf(requests[1]!)[0]?.["content"]), /exit code 0/);
});

test("invalid input e unknown tool viram erro para o modelo", async () => {
  const { ctx } = await setup("deny");
  const { model, requests } = scripted([
    reply([toolUse("toolu_x", "Read", {}), toolUse("toolu_y", "Apagar", {})]),
    reply([text("ok")], "end_turn"),
  ]);
  await run(model, ctx);
  const [invalid, unknown] = resultsOf(requests[1]!);
  assert.match(String(invalid?.["content"]), /invalid input/);
  assert.match(String(unknown?.["content"]), /unknown tool/);
});
