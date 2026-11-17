import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import type { ModelClient } from "../src/model.js";
import { buildRuntime } from "../src/runtime.js";
import { App } from "../src/tui/App.js";
import { type Item, ItemView, TurnRail, turnsOf } from "../src/tui/transcript.js";
import { ToolActivityView, ToolCardView, ToolGroupView, type ToolItem, historyUnits, isMouseInput, mouseEvents } from "../src/tui/tool-cards.js";

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error("condição não atingida a tempo");
    await settle(20);
  }
}

function tool(id: number, name: string, input: unknown, output: string, ok = true): ToolItem {
  return { kind: "tool", id, name, summary: String((input as Record<string, unknown>)["command"] ?? (input as Record<string, unknown>)["file_path"] ?? (input as Record<string, unknown>)["pattern"] ?? ""), ok, output, input };
}

test("ferramentas de leitura seguidas formam um grupo; Bash e Write viram blocos próprios", () => {
  const items: Item[] = [
    { kind: "user", id: 1, text: "oi" },
    tool(2, "Read", { file_path: "/p/a.ts" }, "1\tx"),
    tool(3, "Grep", { pattern: "x" }, "a.ts:1"),
    tool(4, "Write", { file_path: "/p/b.ts", content: "x" }, "wrote"),
    tool(5, "Bash", { command: "pwd" }, "/p"),
    tool(6, "Glob", { pattern: "*.md" }, "README.md"),
  ];
  assert.deepEqual(
    historyUnits(items).map((unit) => [unit.kind, unit.id]),
    [["item", 1], ["group", 2], ["card", 4], ["card", 5], ["group", 6]],
  );
});

test("grupo fechado: verbo, dois objetos, +N more e tempo; aberto: cada chamada", () => {
  const tools = [
    tool(1, "Read", { file_path: "cart.ts" }, "a\nb"),
    tool(2, "Read", { file_path: "cart.test.ts" }, "c"),
    tool(3, "Read", { file_path: "package.json" }, "d"),
  ];
  const closed = render(<ToolGroupView tools={tools} expanded={false} hovered={false} />);
  assert.match(closed.lastFrame() ?? "", /◼ read {5}cart\.ts, cart\.test\.ts \+1 more/);
  assert.doesNotMatch(closed.lastFrame() ?? "", /package\.json/);
  closed.unmount();
  const open = render(<ToolGroupView tools={tools} expanded={true} hovered={false} />);
  assert.match(open.lastFrame() ?? "", /package\.json/);
  open.unmount();
});

test("grupo com falha abre sozinho e mostra 1 failed", () => {
  const tools = [tool(1, "Read", { file_path: "cart.ts" }, "a"), tool(2, "Read", { file_path: "config.ts" }, "not found", false)];
  const view = render(<ToolGroupView tools={tools} expanded={false} hovered={false} />);
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /✕ read {5}cart\.ts, config\.ts/);
  assert.match(frame, /1 failed/);
  assert.match(frame, /not found/);
  view.unmount();
});

test("Write mostra 6 linhas, o resto ao abrir; a linha do cabeçalho traz +N -0", () => {
  const content = Array.from({ length: 30 }, (_, index) => `linha ${index + 1}`).join("\n");
  const write = tool(1, "Write", { file_path: "/p/a.ts", content }, "wrote 200 bytes");
  const closed = render(<ToolCardView tool={write} expanded={false} hovered={false} />);
  const frame = closed.lastFrame() ?? "";
  assert.match(frame, /◼ write {4}\/p\/a\.ts {2}\+30 -0/);
  assert.match(frame, /linha 6/);
  assert.doesNotMatch(frame, /linha 7/);
  assert.match(frame, /\+24 more lines · ctrl\+o/);
  closed.unmount();
  const open = render(<ToolCardView tool={write} expanded={true} hovered={false} />);
  assert.match(open.lastFrame() ?? "", /linha 30/);
  open.unmount();
});

test("Edit mostra linhas - em vermelho e + em azul, com contagem no cabeçalho", () => {
  const edit = tool(1, "Edit", { file_path: "/p/a.ts", old_string: "a\nb", new_string: "c" }, "edited");
  const view = render(<ToolCardView tool={edit} expanded={false} hovered={false} />);
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /edit {5}\/p\/a\.ts {2}\+1 -2/);
  assert.match(frame, /- a/);
  assert.match(frame, /- b/);
  assert.match(frame, /\+ c/);
  view.unmount();
});

test("ferramenta rodando: losango, verbo, objeto e a palavra running, sem ponto", () => {
  const view = render(<ToolActivityView activity={{ name: "Bash", summary: "npm test -- cart", description: null, command: "npm test -- cart", startedAt: Date.now() }} />);
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /◆ run {6}npm test -- cart {2,}running/);
  assert.doesNotMatch(frame, /●/);
  view.unmount();
});

test("turnos começam na mensagem do usuário; o estado vem dos itens e o último aceita o estado ao vivo", () => {
  const items: Item[] = [
    { kind: "user", id: 1, text: "primeiro" },
    tool(2, "Write", { file_path: "/p/a.ts", content: "x" }, "ok"),
    { kind: "turnEnd", id: 3, seconds: 3, tokens: 1200, stopped: false },
    { kind: "user", id: 4, text: "segundo" },
    tool(5, "Bash", { command: "false" }, "exit 1", false),
    { kind: "notice", id: 6, text: "falhou", tone: "error" },
    { kind: "turnEnd", id: 7, seconds: 8, tokens: 2100, stopped: false },
  ];
  const turns = turnsOf(items, null);
  assert.deepEqual(turns.map((turn) => [turn.rail, turn.state, turn.gap]), [
    [true, "done", false],
    [true, "failed", true],
  ]);
  const closing = turns[0]?.items.at(-1);
  assert.deepEqual(closing?.kind === "turnEnd" ? [closing.files, closing.failed] : null, [1, false]);
  const live = turnsOf(items.slice(0, 2), "running");
  assert.equal(live.at(-1)?.state, "running");
});

test("resumo do turno: segundos, tokens e arquivos; interrompido e com erro trocam a primeira palavra", () => {
  const done = render(<ItemView item={{ kind: "turnEnd", id: 1, seconds: 12, tokens: 6000, stopped: false, files: 1 }} />);
  assert.match(done.lastFrame() ?? "", /12s · 6\.0k tokens · 1 file changed/);
  done.unmount();
  const stopped = render(<ItemView item={{ kind: "turnEnd", id: 2, seconds: 9, tokens: 0, stopped: true, files: 0 }} />);
  assert.match(stopped.lastFrame() ?? "", /^Interrupted · 9s$/m);
  stopped.unmount();
  const failed = render(<ItemView item={{ kind: "turnEnd", id: 3, seconds: 8, tokens: 2100, stopped: false, failed: true }} />);
  assert.match(failed.lastFrame() ?? "", /failed · 8s · 2\.1k tokens/);
  failed.unmount();
});

test("o trilho cobre todas as linhas do turno, na coluna 0", () => {
  const view = render(
    <TurnRail rail={true} state="running" gap={false}>
      <Text>um</Text>
      <Text>dois</Text>
    </TurnRail>,
  );
  assert.deepEqual(
    (view.lastFrame() ?? "").split("\n").map((line) => line.slice(0, 2)),
    ["┃ ", "┃ "],
  );
  view.unmount();
});

test("relatórios de mouse SGR são reconhecidos e não viram texto", () => {
  assert.ok(isMouseInput("[<0;5;10M"));
  assert.ok(isMouseInput("\u001B[<35;5;10M[<35;6;10M"));
  assert.ok(!isMouseInput("texto"));
  assert.deepEqual(mouseEvents("[<0;5;10M[<0;5;10m"), [
    { button: 0, x: 5, y: 10, press: true },
    { button: 0, x: 5, y: 10, press: false },
  ]);
});

function reply(content: unknown[]): Anthropic.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "x",
    content,
    stop_reason: content.some((block) => (block as { type: string }).type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

test("clicar no grupo abre as chamadas, clicar de novo fecha", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-cards-")));
  const project = path.join(base, "projeto");
  await mkdir(project);
  let calls = 0;
  const model: ModelClient = {
    async create(params) {
      if (!Array.isArray(params.tools) || !params.tools.some((entry) => (entry as { name?: string }).name === "Glob")) return reply([{ type: "text", text: "x" }]);
      calls++;
      if (calls === 1) {
        return reply([
          { type: "tool_use", id: "a", name: "Glob", input: { pattern: "*.ts" } },
          { type: "tool_use", id: "b", name: "Glob", input: { pattern: "*.md" } },
        ]);
      }
      return reply([{ type: "text", text: "Pronto." }]);
    },
  };
  const runtime = await buildRuntime(project, path.join(base, ".plif"), model);
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  const rowOf = (pattern: RegExp) => (lastFrame() ?? "").split("\n").findIndex((line) => pattern.test(line)) + 1;
  // Inside the group's frame, each call sits under the object column.
  const childRow = /[│|] {2,}◼ list {5}\*\.md/;
  try {
    await settle();
    stdin.write("liste dois padrões");
    await settle();
    stdin.write("\r");
    await waitFor(() => /Pronto\./.test(lastFrame() ?? "") && /list\s+\*\.ts, \*\.md/.test(lastFrame() ?? ""));
    assert.doesNotMatch(lastFrame() ?? "", childRow);

    stdin.write(`\u001B[<0;3;${rowOf(/list\s+\*\.ts, \*\.md/)}M`);
    await waitFor(() => childRow.test(lastFrame() ?? ""));

    stdin.write(`\u001B[<0;3;${rowOf(/list\s+\*\.ts, \*\.md/)}M`);
    await waitFor(() => !childRow.test(lastFrame() ?? ""));
    assert.doesNotMatch(lastFrame() ?? "", /\[<0;/);
  } finally {
    unmount();
  }
});

test("comando ganha bloco próprio: descrição no cabeçalho, $ comando e o fim da saída", () => {
  const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
  const card = render(<ToolCardView tool={tool(9, "Bash", { command: "npm test -- cart", description: "Run the cart tests" }, output)} expanded={false} hovered={false} />);
  const frame = card.lastFrame() ?? "";
  card.unmount();
  const rows = frame.split("\n").filter((row) => row.trim() !== "");
  assert.match(rows[0] ?? "", /^[╭+]/, "the block has its own frame");
  assert.match(frame, /run\s+Run the cart tests/);
  assert.match(frame, /\$ npm test -- cart/);
  assert.match(frame, /6 earlier lines · ctrl\+o/);
  assert.match(frame, /line 10/);
  assert.doesNotMatch(frame, /line 6\b/);
});

test("mensagem do usuário fica num bloco separado dos blocos de execução", () => {
  const items: Item[] = [{ kind: "user", id: 1, text: "rode os testes" }];
  const view = render(<ItemView item={items[0] as Item} />);
  const frame = view.lastFrame() ?? "";
  view.unmount();
  assert.match(frame, /^[▌|] rode os testes/);
});
