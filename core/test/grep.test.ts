import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { grepTool } from "../src/tools/grep.js";
import type { ToolContext } from "../src/types.js";

async function fixture(files: number): Promise<{ root: string; ctx: ToolContext }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-grep-")));
  const root = path.join(base, "projeto");
  await mkdir(path.join(root, "src"), { recursive: true });
  for (let index = 0; index < files; index++) {
    await writeFile(path.join(root, "src", `a${String(index).padStart(3, "0")}.txt`), "linha com alvo\n");
  }
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

const resultLines = (output: string) => output.split("\n").filter((line) => !line.startsWith("["));

test("files_with_matches devolve no máximo 50 arquivos por padrão e avisa o corte", async () => {
  const { ctx } = await fixture(120);
  const output = await grepTool.run({ pattern: "alvo" }, ctx);
  assert.equal(resultLines(output).length, 50);
  assert.match(output, /results cut at 50/);
});

test("head_limit define o número de linhas em content", async () => {
  const { ctx } = await fixture(10);
  const output = await grepTool.run({ pattern: "alvo", output_mode: "content", head_limit: 3 }, ctx);
  assert.equal(resultLines(output).length, 3);
  assert.match(resultLines(output)[0] ?? "", /^src\/a000\.txt:1:linha com alvo$/);
});

test("count devolve a contagem por arquivo", async () => {
  const { root, ctx } = await fixture(2);
  await writeFile(path.join(root, "src", "a000.txt"), "alvo\nalvo\n");
  const output = await grepTool.run({ pattern: "alvo", output_mode: "count" }, ctx);
  assert.match(output, /src\/a000\.txt:2/);
});

test("arquivos protegidos e links simbólicos para fora não entram nos resultados", async () => {
  const { root, ctx } = await fixture(1);
  await writeFile(path.join(root, ".env"), "alvo secreto\n");
  const outside = path.join(path.dirname(root), "fora.txt");
  await writeFile(outside, "alvo fora\n");
  await symlink(outside, path.join(root, "src", "link.txt"));
  const output = await grepTool.run({ pattern: "alvo", head_limit: 200 }, ctx);
  assert.doesNotMatch(output, /\.env/);
  assert.doesNotMatch(output, /link\.txt/);

  const direct = await grepTool.run({ pattern: "alvo", path: ".env" }, ctx);
  assert.match(direct, /no results/);
  assert.match(direct, /protected files skipped/);
});

test("arquivos binários são ignorados", async () => {
  const { root, ctx } = await fixture(1);
  await writeFile(path.join(root, "src", "bin.dat"), Buffer.from([0, 1, 2, ...Buffer.from("alvo")]));
  const output = await grepTool.run({ pattern: "alvo", head_limit: 200 }, ctx);
  assert.doesNotMatch(output, /bin\.dat/);
});

test("linha longa é cortada e a saída total tem teto", async () => {
  const { root, ctx } = await fixture(0);
  await writeFile(path.join(root, "src", "longo.txt"), `alvo${"x".repeat(5000)}\n`);
  const single = await grepTool.run({ pattern: "alvo", output_mode: "content" }, ctx);
  const line = resultLines(single)[0] ?? "";
  assert.ok(line.endsWith("[...]"), line);
  assert.ok(line.length <= 340, `linha com ${line.length} caracteres`);

  const many = await fixture(0);
  for (let index = 0; index < 200; index++) {
    await writeFile(path.join(many.root, "src", `b${String(index).padStart(3, "0")}.txt`), `alvo ${"y".repeat(280)}\n`);
  }
  const big = await grepTool.run({ pattern: "alvo", output_mode: "content", head_limit: 200 }, many.ctx);
  assert.ok(big.length <= 20_400, `saída com ${big.length} caracteres`);
  assert.match(big, /output cut/);
});

test("expressão regular inválida é recusada com mensagem clara", async () => {
  const { ctx } = await fixture(1);
  await assert.rejects(grepTool.run({ pattern: "(aberto" }, ctx), /invalid regular expression/);
});
