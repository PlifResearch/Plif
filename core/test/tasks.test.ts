import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { test } from "node:test";
import { runAgent } from "../src/agent.js";
import type { ModelClient } from "../src/model.js";
import { currentHost } from "../src/platform.js";
import { shellFor } from "../src/shell.js";
import { BackgroundTasks, type Task, completionNotice } from "../src/tasks.js";
import { monitorTool } from "../src/tools/monitor.js";
import type { ToolContext } from "../src/types.js";

function waitFinished(tasks: BackgroundTasks, id: number, timeoutMs = 5000): Promise<Task> {
  return new Promise((resolve, reject) => {
    const existing = tasks.get(id);
    if (existing?.status !== "running" && existing !== undefined) return resolve(existing);
    const timer = setTimeout(() => reject(new Error(`task ${id} did not finish`)), timeoutMs);
    const off = tasks.subscribe((event) => {
      if (event.kind === "finished" && event.task.id === id) {
        clearTimeout(timer);
        off();
        resolve(event.task);
      }
    });
  });
}

function shell(command: string) {
  return { file: shellFor(currentHost()), args: ["-c", command], command, description: "teste", cwd: process.cwd(), env: process.env };
}

test("tarefa roda em segundo plano, guarda o fim da saída e registra o código de saída", async () => {
  const tasks = new BackgroundTasks();
  const started = tasks.start(shell("echo começo; echo fim"));
  assert.equal(started.status, "running");
  const done = await waitFinished(tasks, started.id);
  assert.equal(done.status, "done");
  assert.equal(done.exitCode, 0);
  assert.match(done.tail, /fim/);
});

test("código de saída diferente de zero termina como failed", async () => {
  const tasks = new BackgroundTasks();
  const started = tasks.start(shell("exit 3"));
  const done = await waitFinished(tasks, started.id);
  assert.equal(done.status, "failed");
  assert.equal(done.exitCode, 3);
});

test("parar uma tarefa encerra o processo e marca como stopped", async () => {
  const tasks = new BackgroundTasks();
  const started = tasks.start(shell("sleep 30"));
  assert.equal(tasks.stop(started.id), true);
  const done = await waitFinished(tasks, started.id);
  assert.equal(done.status, "stopped");
  assert.equal(tasks.stop(started.id), false);
});

test("o aviso de conclusão traz o estado e o comando, e não a saída", async () => {
  const tasks = new BackgroundTasks();
  // The command text has no "42", so a match could only come from the output.
  const started = tasks.start(shell("echo $(( 6 * 7 ))"));
  const done = await waitFinished(tasks, started.id);
  assert.match(done.tail, /42/);
  const notice = completionNotice(done);
  assert.match(notice, /<task id="1" status="done" code="0"/);
  assert.doesNotMatch(notice, /42/);
});

test("no máximo oito tarefas rodando ao mesmo tempo", () => {
  const tasks = new BackgroundTasks();
  const started: number[] = [];
  for (let i = 0; i < 8; i++) started.push(tasks.start(shell("sleep 30")).id);
  assert.throws(() => tasks.start(shell("sleep 30")), /there are already 8/);
  tasks.stopAll();
  assert.equal(started.length, 8);
});

test("Monitor: start devolve o número, list e read mostram o estado", async () => {
  const tasks = new BackgroundTasks();
  const ctx = { root: process.cwd(), home: "/tmp", session: "s", sandbox: null, mode: { approval: "on-request", readOnly: false }, tasks } as unknown as ToolContext;
  const input = { action: "start" as const, command: "echo pronto", description: "teste", task: 0 };
  const startText = await monitorTool.run({ ...input, command: "echo pronto" }, ctx);
  assert.match(startText, /task #1 started in the background/);
  await waitFinished(tasks, 1);
  const read = await monitorTool.run({ action: "read", command: "", description: "", task: 1 }, ctx);
  assert.match(read, /#1 done/);
  assert.match(read, /pronto/);
  const list = await monitorTool.run({ action: "list", command: "", description: "", task: 0 }, ctx);
  assert.match(list, /#1 done/);
});

test("Monitor: start passa pela mesma política do Bash; comando destrutivo é recusado", async () => {
  const verdict = await monitorTool.policy({ action: "start", command: "rm -rf /", description: "x", task: 0 }, {
    root: process.cwd(),
    home: "/home/x",
    sandboxed: true,
  });
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.level, 0);
});

test("aviso de tarefa concluída entra na mensagem do usuário da próxima requisição", async () => {
  const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const model: ModelClient = {
    async create(params) {
      sent.push(structuredClone(params));
      return { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Message;
    },
  };
  let delivered = false;
  await runAgent({
    model,
    system: "s",
    tools: [],
    messages: [{ role: "user", content: "espera a tarefa" }],
    ctx: {} as ToolContext,
    maxTurns: 2,
    drainNotices: () => {
      if (delivered) return [];
      delivered = true;
      return ['<task id="1" status="done" code="0" duration="3s">npm test</task>'];
    },
  });
  const last = sent[0]?.messages.at(-1);
  assert.equal(last?.role, "user");
  assert.ok(JSON.stringify(last?.content).includes('<task id=\\"1\\" status=\\"done\\"'));
});
