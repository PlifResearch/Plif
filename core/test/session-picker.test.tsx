import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import type { ModelEntry } from "../src/catalog.js";
import { parseConfig, setDefaultEffort } from "../src/config.js";
import { type SessionEntry, SessionStore } from "../src/session.js";
import { EffortMenu, type EffortLevel } from "../src/tui/effort-menu.js";
import { ModelPicker } from "../src/tui/model-picker.js";
import { SessionPicker, timeAgo } from "../src/tui/session-picker.js";

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const NOW = Date.parse("2026-11-15T12:00:00Z");

function entry(id: string, title: string, cwd: string, hoursAgo: number, branch?: string): SessionEntry {
  const at = new Date(NOW - hoursAgo * 3_600_000).toISOString();
  return { id, cwd, model: "m", createdAt: at, updatedAt: at, title, bytes: 2048, ...(branch ? { branch } : {}) };
}

const sessions = [
  entry("aaaa1111", "Personagem chibi detetive", "/home/brenno/Plif", 1, "main"),
  entry("bbbb2222", "Problema grande sem contexto", "/home/brenno/Plif", 2, "feature"),
  entry("cccc3333", "Rota v3 do mm2", "/home/brenno/outro", 30),
];

test("relative time in English", () => {
  assert.equal(timeAgo(new Date(NOW - 20_000).toISOString(), NOW), "just now");
  assert.equal(timeAgo(new Date(NOW - 3_600_000).toISOString(), NOW), "1 hour ago");
  assert.equal(timeAgo(new Date(NOW - 15 * 3_600_000).toISOString(), NOW), "15 hours ago");
  assert.equal(timeAgo(new Date(NOW - 26 * 3_600_000).toISOString(), NOW), "1 day ago");
});

test("mostra o projeto atual, com branch e tamanho; Ctrl+A abre os outros projetos", async () => {
  const { lastFrame, stdin, unmount } = render(<SessionPicker sessions={sessions} cwd="/home/brenno/Plif" branch="main" onPick={() => {}} now={NOW} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /plif {2}resume a session/);
  assert.match(frame, /1 of 2/);
  assert.match(frame, /Personagem chibi detetive/);
  assert.match(frame, /1 hour ago · main · 2 KB/);
  assert.doesNotMatch(frame, /Rota v3/);
  stdin.write("\u0001");
  await settle();
  assert.match(lastFrame() ?? "", /Rota v3 do mm2/);
  assert.match(lastFrame() ?? "", /outro/);
  unmount();
});

test("busca ignora acentos e caixa; Ctrl+B fica só na branch atual", async () => {
  const { lastFrame, stdin, unmount } = render(<SessionPicker sessions={sessions} cwd="/home/brenno/Plif" branch="main" onPick={() => {}} now={NOW} />);
  stdin.write("PROBLEMA");
  await settle();
  assert.match(lastFrame() ?? "", /1 of 1/);
  assert.match(lastFrame() ?? "", /Problema grande/);
  for (let i = 0; i < "PROBLEMA".length; i++) stdin.write("\u007F");
  await settle();
  stdin.write("\u0002");
  await settle();
  assert.match(lastFrame() ?? "", /1 of 1/);
  assert.match(lastFrame() ?? "", /ctrl\+b all branches/);
  unmount();
});

test("Enter devolve a sessão escolhida; Ctrl+E renomeia; Espaço abre a prévia", async () => {
  let picked: SessionEntry | null = null;
  const renamed: Array<[string, string]> = [];
  const { lastFrame, stdin, unmount } = render(
    <SessionPicker
      sessions={sessions}
      cwd="/home/brenno/Plif"
      branch="main"
      now={NOW}
      onPreview={async () => [
        { role: "user", text: "faça um personagem" },
        { role: "assistant", text: "feito" },
      ]}
      onRename={async (id, title) => {
        renamed.push([id, title]);
      }}
      onPick={(session) => {
        picked = session;
      }}
    />,
  );
  stdin.write(" ");
  await settle();
  assert.match(lastFrame() ?? "", /faça um personagem/);
  assert.match(lastFrame() ?? "", /feito/);
  stdin.write("\u0005");
  await settle();
  for (let i = 0; i < 30; i++) stdin.write("\u007F");
  stdin.write("Detetive");
  await settle();
  stdin.write("\r");
  await settle();
  assert.deepEqual(renamed, [["aaaa1111", "Detetive"]]);
  assert.match(lastFrame() ?? "", /Detetive/);
  stdin.write("\u001B[B");
  await settle();
  stdin.write("\r");
  await settle();
  assert.equal((picked as SessionEntry | null)?.id, "bbbb2222");
  unmount();
});

test("o armazenamento guarda a branch, renomeia sem mudar a ordem e gera a prévia", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "plif-store-")));
  const store = new SessionStore(dir);
  const meta = await store.create("/p", "m", "main");
  const after = await store.append(meta, { role: "user", content: "primeira pergunta" });
  await store.append(after, { role: "assistant", content: [{ type: "text", text: "resposta" }] });
  const before = (await store.list())[0];
  const renamed = await store.rename(meta.id, "  nome   novo ");
  assert.equal(renamed.title, "nome novo");
  assert.equal(renamed.branch, "main");
  assert.equal((await store.list())[0]?.updatedAt, before?.updatedAt);
  assert.deepEqual(await store.preview(meta.id), [
    { role: "user", text: "primeira pergunta" },
    { role: "assistant", text: "resposta" },
  ]);
});

test("menu de effort: setas ajustam, Enter salva como padrão, s vale só na sessão", async () => {
  const levels: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
  const confirmed: Array<[EffortLevel, boolean]> = [];
  const { lastFrame, stdin, unmount } = render(
    <EffortMenu levels={levels} current="medium" modelDefault="medium" onCancel={() => {}} onConfirm={(level, persist) => confirmed.push([level, persist])} />,
  );
  assert.match(lastFrame() ?? "", /reasoning depth/);
  assert.match(lastFrame() ?? "", /quick .*thorough/);
  assert.match(lastFrame() ?? "", /the model default is medium/);
  stdin.write("\u001B[C");
  await settle();
  const lines = (lastFrame() ?? "").split("\n");
  const rule = lines.find((line) => line.includes("◆")) ?? "";
  const labels = lines.find((line) => line.includes("xhigh")) ?? "";
  assert.equal(rule.indexOf("◆"), labels.indexOf("high") + 2);
  stdin.write("\r");
  stdin.write("s");
  await settle();
  assert.deepEqual(confirmed, [
    ["high", true],
    ["high", false],
  ]);
  unmount();
});

test("o padrão de effort é gravado no config.toml sem mexer no resto", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "plif-config-")));
  const file = path.join(dir, "config.toml");
  await writeFile(file, 'model = "m"\nmodel_reasoning_effort = "medium"  # comentário\n\n[provider]\nkind = "anthropic"\n');
  await setDefaultEffort(file, "high");
  const text = await readFile(file, "utf8");
  assert.equal(parseConfig(text).model_reasoning_effort, "high");
  assert.match(text, /\[provider\]\nkind = "anthropic"/);
  await writeFile(file, 'model = "m"\n\n[provider]\nkind = "anthropic"\n');
  await setDefaultEffort(file, "low");
  assert.equal(parseConfig(await readFile(file, "utf8")).model_reasoning_effort, "low");
});

test("/effort abre a régua e /resume abre o seletor dentro da Plif", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { buildRuntime } = await import("../src/runtime.js");
  const { App } = await import("../src/tui/App.js");
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-menus-")));
  const project = path.join(base, "projeto");
  await mkdir(project);
  const runtime = await buildRuntime(project, path.join(base, ".plif"), {
    async create() {
      throw new Error("não deve ser chamado");
    },
  });
  await runtime.sessions.append(await runtime.sessions.create(project, "m", "main"), { role: "user", content: "sessão antiga" });
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  const waitFrame = async (pattern: RegExp) => {
    const deadline = Date.now() + 5_000;
    while (!pattern.test(lastFrame() ?? "") && Date.now() < deadline) await settle(20);
    assert.match(lastFrame() ?? "", pattern);
    await settle();
  };
  try {
    await settle(300);
    stdin.write("/effort");
    await settle();
    stdin.write("\r");
    await waitFrame(/reasoning depth/);
    stdin.write("\u001B");
    await settle(150);
    assert.doesNotMatch(lastFrame() ?? "", /reasoning depth/);
    stdin.write("/resume");
    await settle();
    stdin.write("\r");
    await waitFrame(/resume a session/);
    await waitFrame(/sessão antiga/);
    stdin.write("\r");
    await waitFrame(/resumed/);
  } finally {
    unmount();
    await runtime.dispose();
  }
});

test("/model: lista o catálogo, Enter escolhe, Esc fecha", async () => {
  const models: ModelEntry[] = [
    { id: "claude-haiku-5-5", name: "Haiku 5.5", contextWindow: 200_000, efforts: ["low", "medium"], defaultEffort: "medium" },
    { id: "claude-opus-5-5", name: "Opus 5.5", contextWindow: 200_000, efforts: ["low", "medium", "high"], defaultEffort: "high" },
  ];
  const picked: string[] = [];
  let cancelled = false;
  const { lastFrame, stdin, unmount } = render(
    <ModelPicker models={models} current="claude-haiku-5-5" onPick={(model) => picked.push(model.id)} onCancel={() => (cancelled = true)} />,
  );
  await settle();
  assert.match(lastFrame() ?? "", /choose the model/);
  assert.match(lastFrame() ?? "", /1 of 2/);
  assert.match(lastFrame() ?? "", /default effort high/);
  stdin.write("\u001B[B");
  await settle();
  stdin.write("\r");
  await settle();
  assert.deepEqual(picked, ["claude-opus-5-5"]);
  stdin.write("\u001B");
  await settle(60);
  assert.equal(cancelled, true);
  unmount();
});
