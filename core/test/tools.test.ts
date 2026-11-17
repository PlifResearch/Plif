import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { editTool } from "../src/tools/edit.js";
import { readTool } from "../src/tools/read.js";
import { writeTool } from "../src/tools/write.js";
import type { ToolContext } from "../src/types.js";

async function context(): Promise<{ root: string; ctx: ToolContext }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-tools-")));
  const root = path.join(base, "projeto");
  await mkdir(root);
  const ctx: ToolContext = {
    root,
    home: path.join(base, "casa"),
    session: "teste",
    sandbox: null,
    mode: { approval: "on-request", readOnly: false },
    readFiles: new Set(),
    approver: { ask: async () => "deny" as const },
    log: { record: async () => {} },
  };
  return { root, ctx };
}

test("Read numera as linhas e respeita offset e limit", async () => {
  const { root, ctx } = await context();
  const file = path.join(root, "a.txt");
  await writeFile(file, "a\nb\nc\n");
  assert.equal(await readTool.run({ file_path: file, offset: 2, limit: 1 }, ctx), "2\tb");
  assert.equal(ctx.readFiles.has(file), true);
});

test("Edit exige leitura prévia e trecho único", async () => {
  const { root, ctx } = await context();
  const file = path.join(root, "b.txt");
  await writeFile(file, "x x\n");
  await assert.rejects(editTool.run({ file_path: file, old_string: "x", new_string: "y" }, ctx), /Read/);

  await readTool.run({ file_path: file }, ctx);
  await assert.rejects(editTool.run({ file_path: file, old_string: "x", new_string: "y" }, ctx), /2 times/);

  assert.equal(
    await editTool.run({ file_path: file, old_string: "x x", new_string: "z" }, ctx),
    "replacements: 1",
  );
  assert.equal(await readFile(file, "utf8"), "z\n");
});

test("Write cria diretórios intermediários e exige Read antes de sobrescrever arquivo alheio", async () => {
  const { root, ctx } = await context();
  const file = path.join(root, "novo", "sub", "arquivo.txt");
  await writeTool.run({ file_path: file, content: "oi" }, ctx);
  assert.equal(await readFile(file, "utf8"), "oi");
  await writeTool.run({ file_path: file, content: "de novo" }, ctx);

  const existing = path.join(root, "existente.txt");
  await writeFile(existing, "já estava aqui");
  await assert.rejects(writeTool.run({ file_path: existing, content: "x" }, ctx), /Read/);
});
