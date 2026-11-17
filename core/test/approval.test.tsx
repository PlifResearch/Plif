import assert from "node:assert/strict";
import { mkdtemp, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { render } from "ink-testing-library";
import React from "react";
import type { ModelClient } from "../src/model.js";
import { buildRuntime, type Runtime } from "../src/runtime.js";
import { Approval, initialApprovalFocus } from "../src/tui/dialogs.js";
import { App } from "../src/tui/App.js";

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("tempo esgotado esperando a interface");
    await settle();
  }
}

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

async function runtimeFor(model: ModelClient): Promise<Runtime> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-approval-")));
  const project = path.join(base, "projeto");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(project);
  return buildRuntime(project, path.join(base, ".plif"), model);
}

const request = (reason: string, summary = "npm install") => ({ tool: "Bash", summary, reason });

test("foco inicial vai para Deny só quando o motivo fala em apagar, sobrescrever ou ação destrutiva", () => {
  assert.equal(initialApprovalFocus(request("comando que apaga arquivos", "rm -rf dist")), 0);
  assert.equal(initialApprovalFocus(request("ação destrutiva", "git reset --hard")), 0);
  assert.equal(initialApprovalFocus(request("caminho fora do projeto", "git push --force")), 0);
  assert.equal(initialApprovalFocus(request("comando fora da allowlist de leitura", "npm install")), 1);
});

test("caixa de aprovação mostra a pergunta, o motivo, as três opções e as teclas", () => {
  const { lastFrame, unmount } = render(<Approval request={request("comando fora da allowlist de leitura", "rm -rf dist")} selected={0} width={100} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /Run rm -rf dist\?/);
  assert.match(frame, /deletes files/);
  assert.match(frame, /Deny/);
  assert.match(frame, /Allow once/);
  assert.match(frame, /Allow this session/);
  assert.match(frame, /enter confirm · y once · s session · n or esc deny · ctrl\+c stop turn/);
  assert.doesNotMatch(frame, /Permission required|Yes|No\b/);
  unmount();
});

test("caixa de aprovação tem no máximo seis linhas", () => {
  const { lastFrame, unmount } = render(<Approval request={request("motivo", "npm install")} selected={1} width={100} />);
  assert.ok((lastFrame() ?? "").split("\n").length <= 6);
  unmount();
});

test("tecla y aprova uma vez e executa a ação", async () => {
  const runtime = await runtimeFor(
    scriptedModel([
      reply([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo x > a.txt", description: "gravar" } }], "tool_use"),
      reply([{ type: "text", text: JSON.stringify({ decision: "ask_user", rule: "unclear", reason: "doubt" }) }]),
      reply([{ type: "text", text: "arquivo gravado" }]),
    ]),
  );
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  stdin.write("crie o arquivo");
  stdin.write("\r");
  await waitFor(() => /Run echo x > a\.txt\?/.test(lastFrame() ?? ""));
  stdin.write("y");
  await waitFor(() => /arquivo gravado/.test(lastFrame() ?? ""));
  await stat(path.join(runtime.root, "a.txt"));
  unmount();
});

test("Ctrl+C durante a aprovação nega a ação e para o turno", async () => {
  const runtime = await runtimeFor(
    scriptedModel([
      reply([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo x > a.txt", description: "gravar" } }], "tool_use"),
      reply([{ type: "text", text: JSON.stringify({ decision: "ask_user", rule: "unclear", reason: "doubt" }) }]),
    ]),
  );
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  stdin.write("crie o arquivo");
  stdin.write("\r");
  await waitFor(() => /Run echo x > a\.txt\?/.test(lastFrame() ?? ""));
  stdin.write("\x03");
  await waitFor(() => !/Run echo x > a\.txt\?/.test(lastFrame() ?? ""));
  await settle(120);
  await assert.rejects(stat(path.join(runtime.root, "a.txt")));
  unmount();
});

test("Esc no histórico não sai do app", async () => {
  const runtime = await runtimeFor(scriptedModel([]));
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  stdin.write("\x1b");
  await settle(150);
  assert.match(lastFrame() ?? "", /Ask anything|»|>/);
  unmount();
});

test("Ctrl+C com a Plif parada pede a segunda confirmação antes de sair", async () => {
  const runtime = await runtimeFor(scriptedModel([]));
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  stdin.write("\x03");
  await waitFor(() => /press ctrl\+c again to exit/.test(lastFrame() ?? ""));
  unmount();
});

test("Ctrl+R troca o prompt pelo anterior que contém o texto digitado; Esc volta ao original", async () => {
  const runtime = await runtimeFor(scriptedModel([reply([{ type: "text", text: "resposta um" }]), reply([{ type: "text", text: "resposta dois" }])]));
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  stdin.write("primeiro pedido");
  stdin.write("\r");
  await waitFor(() => /resposta um/.test(lastFrame() ?? ""));
  stdin.write("pedido seguinte");
  stdin.write("\r");
  await waitFor(() => /resposta dois/.test(lastFrame() ?? ""));

  stdin.write("ped");
  await settle();
  stdin.write("\x12");
  await waitFor(() => /pedido seguinte[▌█]/.test(lastFrame() ?? ""));
  stdin.write("\x12");
  await waitFor(() => /primeiro pedido[▌█]/.test(lastFrame() ?? ""));
  stdin.write("\x1b");
  await waitFor(() => /ped[▌█]/.test(lastFrame() ?? ""));
  unmount();
});
