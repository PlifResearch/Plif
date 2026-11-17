import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { render } from "ink-testing-library";
import React from "react";
import type { ModelClient } from "../src/model.js";
import { buildRuntime } from "../src/runtime.js";
import { type Subagent, type SubagentRunner, Subagents, describeToolRun, subagentNotice, subagentTools } from "../src/subagents.js";
import { TOOLS } from "../src/tools/index.js";
import { AgentFooter, AgentTranscript } from "../src/tui/agents.js";
import { App } from "../src/tui/App.js";

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error("condição não atingida a tempo");
    await settle(20);
  }
}

function usage(input: number, output: number): Anthropic.Usage {
  return { input_tokens: input, output_tokens: output } as Anthropic.Usage;
}

test("o gerenciador registra ferramentas, texto e tokens e avisa ao terminar", async () => {
  const manager = new Subagents();
  const finished: Subagent[] = [];
  manager.subscribe((event) => {
    if (event.kind === "finished") finished.push(event.agent);
  });
  const runner: SubagentRunner = async (_agent, run) => {
    run.events.onToolStart?.({ id: "t1", name: "Read", input: { file_path: "/p/a.ts" } });
    run.events.onToolEnd?.({ id: "t1", name: "Read", ok: true, output: "..." });
    run.events.onUsage?.(usage(1200, 300));
    run.events.onText?.("relatório final");
    return "relatório final";
  };
  const agent = manager.start({ type: "explore", description: "Map the project", prompt: "Explore" }, runner);
  await waitFor(() => finished.length === 1);
  assert.equal(agent.status, "done");
  assert.equal(agent.tokens, 1500);
  assert.equal(agent.report, "relatório final");
  assert.deepEqual(
    agent.transcript.map((entry) => entry.kind),
    ["user", "tool", "text"],
  );
  assert.match(subagentNotice(agent), /<subagent id="1" type="explore" status="done"[^>]*>Map the project<\/subagent>/);
  assert.match(subagentNotice(agent), /<report>\nrelatório final\n<\/report>/);
});

test("mensagem durante a execução entra no próximo pedido; depois do fim, roda de novo", async () => {
  const manager = new Subagents();
  let release: () => void = () => {};
  const drained: string[][] = [];
  let runs = 0;
  const runner: SubagentRunner = async (agent, run) => {
    runs++;
    if (runs === 1) await new Promise<void>((resolve) => (release = resolve));
    drained.push([...run.drainNotices()]);
    return `fim ${runs} com ${agent.messages.length} mensagens`;
  };
  const agent = manager.start({ type: "general", description: "Tarefa", prompt: "faça" }, runner);
  assert.ok(manager.send(agent.id, "e também isto"));
  release();
  await waitFor(() => agent.status === "done");
  assert.deepEqual(drained[0], ["e também isto"]);

  manager.send(agent.id, "mais uma coisa");
  assert.equal(agent.status, "running");
  await waitFor(() => agent.status === "done");
  assert.equal(runs, 2);
  assert.equal(agent.messages.at(-1)?.content, "mais uma coisa");
  assert.equal(agent.transcript.filter((entry) => entry.kind === "user").length, 3);
});

test("parar um subagente termina com status stopped", async () => {
  const manager = new Subagents();
  const runner: SubagentRunner = (_agent, run) =>
    new Promise((_resolve, reject) => run.signal.addEventListener("abort", () => reject(new Error("interrompido"))));
  const agent = manager.start({ type: "explore", description: "Longa", prompt: "x" }, runner);
  assert.ok(manager.stop(agent.id));
  await waitFor(() => agent.endedAt !== null);
  assert.equal(agent.status, "stopped");
  assert.equal(manager.stop(agent.id), false);
});

test("explore só recebe ferramentas de leitura e nenhum subagente recebe Agent", () => {
  const explore = subagentTools(TOOLS, "explore").map((tool) => tool.name);
  const general = subagentTools(TOOLS, "general").map((tool) => tool.name);
  assert.ok(explore.includes("Read") && explore.includes("Grep"));
  for (const name of ["Write", "Edit", "Agent", "Memory"]) assert.ok(!explore.includes(name), name);
  for (const name of ["Agent", "Monitor", "Plan"]) assert.ok(!general.includes(name), name);
  assert.ok(general.includes("Edit"));
});

test("a linha de ferramentas agrupa por tipo, na ordem de uso", () => {
  const line = describeToolRun([
    { name: "Read", ok: true },
    { name: "Glob", ok: true },
    { name: "Read", ok: true },
    { name: "Bash", ok: false },
    { name: "Read", ok: true },
  ]);
  assert.equal(line, "Read 3 files, listed 1 file pattern and ran 1 command (1 failed)");
});

function fakeAgent(overrides: Partial<Subagent> = {}): Subagent {
  return {
    id: 1,
    type: "explore",
    description: "Explore Plif project",
    startedAt: Date.now() - 14_000,
    endedAt: null,
    status: "running",
    tokens: 34_700,
    current: null,
    report: "",
    error: null,
    transcript: [
      { kind: "user", text: "Explore the project", from: "main" },
      { kind: "tool", name: "Read", summary: "a", ok: true },
      { kind: "tool", name: "Read", summary: "b", ok: true },
      { kind: "tool", name: "Bash", summary: "ls", ok: true },
    ],
    messages: [],
    ...overrides,
  };
}

test("bloco lista main com o turno e o subagente com tipo, descrição e tempo", () => {
  const { lastFrame, unmount } = render(<AgentFooter agents={[fakeAgent()]} cursor={null} mainStartedAt={Date.now() - 5_000} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /main {2,}working {2}5s/);
  assert.match(frame, /◆ explore {2}Explore Plif project {2}waiting for the model/);
  assert.match(frame, /14s/);
  unmount();
});

test("bloco mostra no máximo 4 linhas e o excedente como +N more", () => {
  const many = [1, 2, 3, 4, 5].map((id) => fakeAgent({ id, description: `task ${id}`, status: "done", endedAt: Date.now() }));
  const { lastFrame, unmount } = render(<AgentFooter agents={many} cursor={null} mainStartedAt={null} />);
  const lines = (lastFrame() ?? "").split("\n").filter((line) => line.trim() !== "");
  assert.equal(lines.length, 4);
  assert.match(lines[3] ?? "", /\+3 more · ↓/);
  unmount();
});

test("visão do subagente tem cabeçalho, origem, pedido e ferramentas no formato do turno", () => {
  const { lastFrame, unmount } = render(<AgentTranscript agent={fakeAgent({ status: "done", endedAt: Date.now() })} place="~/Plif · main" model="Haiku 5.5 · low" />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /plif {2}~\/Plif · main \/ explore · Explore Plif project/);
  assert.match(frame, /Haiku 5\.5 · low · .*34\.7k tokens/);
  assert.match(frame, /from main/);
  assert.match(frame, /Explore the project/);
  assert.match(frame, /Read 2 files and ran 1 command/);
  assert.match(frame, /◼ read {5}a/);
  unmount();
});

function reply(content: unknown[]): Anthropic.Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content,
    stop_reason: content.some((block) => (block as { type: string }).type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as Anthropic.Message;
}

test("o main delega, o rodapé mostra o subagente e ↓ enter abre a visão dele", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-subagents-")));
  const project = path.join(base, "projeto");
  await mkdir(project);
  let releaseSub: () => void = () => {};
  const subStarted = new Promise<void>((resolve) => (releaseSub = resolve));
  let subCanFinish: () => void = () => {};
  const subGate = new Promise<void>((resolve) => (subCanFinish = resolve));
  let mainCalls = 0;
  let reportSeen = false;
  const model: ModelClient = {
    async create(params) {
      const system = String(params.system);
      if (system.includes("You are a Plif subagent")) {
        releaseSub();
        await subGate;
        return reply([{ type: "text", text: "O projeto tem três pastas." }]);
      }
      mainCalls++;
      if (JSON.stringify(params.messages).includes("O projeto tem três pastas.")) {
        reportSeen = true;
        return reply([{ type: "text", text: "Recebi o relatório." }]);
      }
      if (mainCalls === 1) {
        return reply([
          {
            type: "tool_use",
            id: "u1",
            name: "Agent",
            input: { description: "Explore Plif project", prompt: "Explore o projeto e resuma.", subagent_type: "explore" },
          },
        ]);
      }
      return reply([{ type: "text", text: "Deleguei a exploração." }]);
    },
  };
  const runtime = await buildRuntime(project, path.join(base, ".plif"), model);
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  try {
    await settle();
    stdin.write("explore o projeto");
    await settle();
    stdin.write("\r");
    await subStarted;
    await waitFor(() => /explore {2}Explore Plif project/.test(lastFrame() ?? ""));

    stdin.write("\u001B[B");
    await settle();
    stdin.write("\u001B[B");
    await settle();
    stdin.write("\r");
    await settle();
    const view = lastFrame() ?? "";
    assert.match(view, /from main/);
    assert.match(view, /Explore o projeto e resuma\./);
    assert.match(view, /message explore #1 · esc back to main/);

    subCanFinish();
    // The report reaches main in its next request, whether that request was already due or the notice starts one.
    await waitFor(() => reportSeen);
    await waitFor(() => /O projeto tem três pastas\./.test(lastFrame() ?? ""));

    stdin.write("\u001B");
    await waitFor(() => /Recebi o relatório\./.test(lastFrame() ?? ""));
  } finally {
    runtime.subagents.stopAll();
    unmount();
  }
});

test("os papéis subagent e explore do config.toml escolhem o modelo do subagente", async () => {
  const { subagentModel } = await import("../src/subagents.js");
  const catalog = {
    default: "m-main",
    classifier: "m-cheap",
    models: [
      { id: "m-main", name: "Main", contextWindow: 1000, efforts: ["low", "medium"] as ("low" | "medium")[], defaultEffort: "medium" as const },
      { id: "m-cheap", name: "Cheap", contextWindow: 1000, efforts: ["low", "medium"] as ("low" | "medium")[], defaultEffort: "medium" as const },
    ],
  };
  assert.equal(subagentModel(catalog, "explore", "m-main").id, "m-cheap");
  assert.equal(subagentModel(catalog, "explore", "m-main", { explore: "local-qwen" }).id, "local-qwen");
  assert.equal(subagentModel(catalog, "general", "m-main", { subagent: "local-big" }).id, "local-big");
  assert.equal(subagentModel(catalog, "general", "m-main", {}).id, "m-main");
});
