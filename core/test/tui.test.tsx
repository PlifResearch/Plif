import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { render } from "ink-testing-library";
import type Anthropic from "@anthropic-ai/sdk";
import { stat, writeFile } from "node:fs/promises";
import React from "react";
import { buildRuntime, type Runtime } from "../src/runtime.js";
import { App } from "../src/tui/App.js";
import type { ModelClient } from "../src/model.js";

const unusedModel: ModelClient = {
  async create() {
    throw new Error("o modelo não deve ser chamado nestes testes");
  },
};

async function runtimeFor(model: ModelClient = unusedModel): Promise<Runtime> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-tui-")));
  const project = path.join(base, "projeto");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(project);
  return buildRuntime(project, path.join(base, ".plif"), model);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

function scriptedModel(replies: unknown[]): ModelClient {
  const queue = [...replies];
  return {
    async create() {
      const next = queue.shift();
      if (next === undefined) throw new Error("sem resposta roteirizada");
      return next as Anthropic.Message;
    },
  };
}

function reply(content: unknown[], stopReason = "end_turn") {
  return { id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("tempo esgotado esperando a interface");
    await settle();
  }
}

test("sessão vazia mostra o mascote, a frase de boas-vindas e o cabeçalho de uma linha", async () => {
  const runtime = await runtimeFor();
  const { lastFrame, unmount } = render(<App runtime={runtime} trusted={true} />);
  await settle();
  const frame = lastFrame() ?? "";
  assert.match(frame, /plif/);
  assert.match(frame, /[▀▄█]/);
  assert.match(frame, /Ready in .+\. Ask for a change, or type \/ for commands\./);
  assert.match(frame, /sandbox (on|off)/);
  assert.match(frame, /\[auto\]/);
  unmount();
});

test("o cabeçalho não tem régua de linhas cinza", async () => {
  const runtime = await runtimeFor();
  const { lastFrame, unmount } = render(<App runtime={runtime} trusted={true} />);
  await settle();
  const rules = (lastFrame() ?? "").split("\n").filter((line) => /^─+$/.test(line.trim()));
  assert.deepEqual(rules, []);
  unmount();
});

test("seletor de sessões mostra há quanto tempo a sessão mudou e quanto ela pesa", async () => {
  const { SessionPicker } = await import("../src/tui/session-picker.js");
  const sessions = [
    { id: "abcdef12-0000", cwd: "/p", model: "m", createdAt: "2026-11-06T10:00:00Z", updatedAt: "2026-11-06T10:05:00Z", title: "logo nova", bytes: 3_145_728 },
  ];
  const now = Date.parse("2026-11-06T13:05:00Z");
  const { lastFrame, unmount } = render(<SessionPicker sessions={sessions} onPick={() => {}} now={now} />);
  assert.match(lastFrame() ?? "", /logo nova/);
  assert.match(lastFrame() ?? "", /3 hours ago · 3\.0 MB/);
  unmount();
});

test("pasta não confiável mostra o diálogo de confiança primeiro", async () => {
  const runtime = await runtimeFor();
  const { lastFrame, unmount } = render(<App runtime={runtime} trusted={false} />);
  await settle();
  assert.match(lastFrame() ?? "", /First time in/);
  assert.match(lastFrame() ?? "", /Trust this folder/);
  assert.match(lastFrame() ?? "", /esc exits without trusting/);
  unmount();
});

test("digitar barra abre o menu de comandos", async () => {
  const runtime = await runtimeFor();
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  try {
    stdin.write("/");
    await settle();
    const frame = lastFrame() ?? "";
    assert.match(frame, /commands/);
    assert.match(frame, /1 of 11/);
    assert.match(frame, /help\s+list the commands/);
    assert.match(frame, /model \[id\]\s+show or change the model/);
    assert.match(frame, /enter run · tab complete · esc close/);
  } finally {
    unmount();
  }
});

test("shift+tab alterna o modo de permissões", async () => {
  const runtime = await runtimeFor();
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  stdin.write("\x1b[Z");
  await settle();
  assert.match(lastFrame() ?? "", /\[ask\]/);
  stdin.write("\x1b[Z");
  await settle();
  assert.match(lastFrame() ?? "", /\[never ask\]/);
  unmount();
});

test("o prompt continua na tela enquanto o modelo responde, com a linha de execução acima dele", async () => {
  let release: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: ModelClient = {
    async create() {
      await finished;
      return reply([{ type: "text", text: "terminei" }]) as Anthropic.Message;
    },
  };
  const runtime = await runtimeFor(slow);
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  try {
    stdin.write("faça algo");
    stdin.write("\r");
    // A client without streaming reports no phase, so the status says it is waiting for the model.
    await waitFor(() => /waiting for the model/.test(lastFrame() ?? ""));
    const frame = lastFrame() ?? "";
    assert.match(frame, /»[^\n]*waiting for the model/);
    assert.match(frame, /\[auto\]/);
    release();
    await waitFor(() => /terminei/.test(lastFrame() ?? ""));
  } finally {
    release();
    unmount();
  }
});

test("arrastar uma imagem para o prompt vira [Image #1] e segue para o modelo como bloco de imagem", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-img-")));
  const file = path.join(base, "tela.png");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  await writeFile(file, png);
  const sent: Anthropic.MessageParam[][] = [];
  const model: ModelClient = {
    async create(params) {
      sent.push(params.messages as Anthropic.MessageParam[]);
      return reply([{ type: "text", text: "vi a imagem" }]) as Anthropic.Message;
    },
  };
  const runtime = await runtimeFor(model);
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  stdin.write(`olhe '${file}' `);
  await settle();
  assert.match(lastFrame() ?? "", /olhe \[Image #1\]/);
  stdin.write("\r");
  await waitFor(() => /vi a imagem/.test(lastFrame() ?? ""));
  const user = sent[0]?.find((message) => message.role === "user");
  const blocks = (user?.content ?? []) as Anthropic.ContentBlockParam[];
  assert.deepEqual(blocks[0], { type: "text", text: "olhe [Image #1]" });
  assert.deepEqual(blocks[1], { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } });
  unmount();
});

test("comando com argumento inválido mostra o erro na conversa", async () => {
  const runtime = await runtimeFor();
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  stdin.write("/effort xyz");
  stdin.write("\r");
  await settle();
  assert.match(lastFrame() ?? "", /invalid effort/);
  unmount();
});

test("conversa: a resposta do modelo aparece no histórico", async () => {
  const runtime = await runtimeFor(scriptedModel([reply([{ type: "text", text: "Olá, Brenno!" }])]));
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  stdin.write("oi");
  stdin.write("\r");
  await waitFor(() => /Olá, Brenno!/.test(lastFrame() ?? ""));
  unmount();
});

test("level 3 action opens the approval box and refusal does not run", async () => {
  const runtime = await runtimeFor(
    scriptedModel([
      reply([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo x > a.txt", description: "gravar" } }], "tool_use"),
      reply([{ type: "text", text: JSON.stringify({ decision: "ask_user", rule: "unclear", reason: "dúvida" }) }]),
      reply([{ type: "text", text: "entendi a recusa" }]),
    ]),
  );
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  stdin.write("crie o arquivo");
  stdin.write("\r");
  await waitFor(() => /Run echo x > a\.txt\?/.test(lastFrame() ?? ""));
  stdin.write("n");
  await waitFor(() => /entendi a recusa/.test(lastFrame() ?? ""));
  await assert.rejects(stat(path.join(runtime.root, "a.txt")));
  unmount();
});

test("texto colado com quebra de linha é enviado de uma vez", async () => {
  const runtime = await runtimeFor(scriptedModel([reply([{ type: "text", text: "colado recebido" }])]));
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  stdin.write("pergunta colada\n");
  await waitFor(() => /colado recebido/.test(lastFrame() ?? ""));
  unmount();
});
