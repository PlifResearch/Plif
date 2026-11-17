import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import { buildRuntime } from "../src/runtime.js";
import { App } from "../src/tui/App.js";
import { TaskChips, TaskPanel } from "../src/tui/tasks.js";
import { BackgroundTasks, type Task } from "../src/tasks.js";
import { currentHost } from "../src/platform.js";
import { shellFor } from "../src/shell.js";
import type { ModelClient } from "../src/model.js";

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeTask(overrides: Partial<Task> = {}): Task {
  return { id: 1, command: "npm test", description: "suíte", startedAt: Date.now() - 125_000, endedAt: null, status: "running", exitCode: null, tail: "linha final\n", ...overrides };
}

test("chip mostra a tarefa rodando com o tempo decorrido", () => {
  const { lastFrame, unmount } = render(<TaskChips running={[fakeTask()]} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /1 task running · ctrl\+t/);
  unmount();
});

test("painel lista o comando, o estado e a última linha da saída", () => {
  const done = fakeTask({ id: 2, command: "npm run build", status: "done", exitCode: 0, endedAt: Date.now() });
  const { lastFrame, unmount } = render(<TaskPanel tasks={[fakeTask(), done]} onStop={() => {}} onClose={() => {}} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /#1 {2}npm test {2}running/);
  assert.match(frame, /#2 {2}npm run build/);
  assert.match(frame, /2m 5s/);
  assert.match(frame, /linha final/);
  unmount();
});

test("com uma tarefa rodando, a tela mostra o chip abaixo do prompt", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-tasks-tui-")));
  const project = path.join(base, "projeto");
  await mkdir(project);
  const model: ModelClient = {
    async create() {
      throw new Error("não deve ser chamado");
    },
  };
  const runtime = await buildRuntime(project, path.join(base, ".plif"), model);
  const started = runtime.tasks.start({ command: "sleep 30", description: "espera", file: shellFor(currentHost()), args: ["-c", "sleep 30"], cwd: project, env: process.env });
  const { lastFrame, unmount } = render(<App runtime={runtime} trusted={true} />);
  try {
    await settle(120);
    const frame = lastFrame() ?? "";
    assert.match(frame, /1 task running · ctrl\+t/);
    assert.ok(frame.indexOf("»") < frame.indexOf("1 task running"));
    assert.ok(started.status === "running");
  } finally {
    runtime.tasks.stopAll();
    unmount();
  }
});

test("/tasks sem tarefas avisa, e com tarefas abre o painel", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-tasks-cmd-")));
  const project = path.join(base, "projeto");
  await mkdir(project);
  const runtime = await buildRuntime(project, path.join(base, ".plif"), {
    async create() {
      throw new Error("não deve ser chamado");
    },
  });
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  try {
    await settle();
    stdin.write("/tasks");
    stdin.write("\r");
    await settle();
    assert.match(lastFrame() ?? "", /no background tasks/);
    runtime.tasks.start({ command: "sleep 30", description: "espera", file: shellFor(currentHost()), args: ["-c", "sleep 30"], cwd: project, env: process.env });
    await settle();
    stdin.write("/tasks");
    stdin.write("\r");
    await settle(120);
    assert.match(lastFrame() ?? "", /background tasks {2,}1 of 1/);
  } finally {
    runtime.tasks.stopAll();
    unmount();
  }
});
