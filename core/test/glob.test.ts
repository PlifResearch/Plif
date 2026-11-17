import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { globTool } from "../src/tools/glob.js";
import { decideGlob } from "../src/policy/decide.js";
import type { ToolContext } from "../src/types.js";

async function fixture(): Promise<{ root: string; ctx: ToolContext; base: string }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-glob-")));
  const root = path.join(base, "projeto");
  for (const dir of ["src/deep/nested", "docs", "dist", "node_modules/x", "pages"]) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  const files: Record<string, string> = {
    "src/a.ts": "a",
    "src/b.tsx": "bb",
    "src/c.md": "ccc",
    "src/deep/nested/d.ts": "dddd",
    "docs/readme.md": "r",
    ".hidden.ts": "h",
    ".env": "SEGREDO=1",
    "dist/out.js": "build",
    "node_modules/x/index.js": "dep",
    ".gitignore": "dist/\n",
  };
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, file), content);
  await writeFile(path.join(base, "fora.ts"), "fora");
  await symlink(path.join(base, "fora.ts"), path.join(root, "src", "link.ts"));
  for (let index = 0; index < 60; index++) {
    await writeFile(path.join(root, "pages", `p${String(index).padStart(3, "0")}.txt`), "x");
  }
  const old = new Date("2020-01-01T00:00:00Z");
  await utimes(path.join(root, "src/a.ts"), old, old);
  await utimes(path.join(root, "src/b.tsx"), new Date("2024-01-01T00:00:00Z"), new Date("2024-01-01T00:00:00Z"));
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
  return { root, ctx, base };
}

const lines = (output: string) => output.split("\n").slice(1).filter((line) => !line.startsWith("["));

test("chaves em padrões: {ts,tsx} acha os dois tipos", async () => {
  const { ctx } = await fixture();
  const output = await globTool.run({ pattern: "src/**/*.{ts,tsx}" }, ctx);
  assert.deepEqual(lines(output).sort(), ["src/a.ts", "src/b.tsx", "src/deep/nested/d.ts"]);
});

test("type directory lista pastas e o padrão lista só arquivos", async () => {
  const { ctx } = await fixture();
  const dirs = await globTool.run({ pattern: "src/**", type: "directory" }, ctx);
  assert.ok(lines(dirs).includes("src/deep"));
  const files = await globTool.run({ pattern: "src/**" }, ctx);
  assert.ok(!lines(files).includes("src/deep"));
});

test("ignore e .gitignore excluem resultados, e respect_gitignore false os devolve", async () => {
  const { ctx } = await fixture();
  const withoutDocs = await globTool.run({ pattern: "**/*", ignore: ["docs/**"] }, ctx);
  assert.ok(!lines(withoutDocs).some((line) => line.startsWith("docs/")));
  assert.match(withoutDocs, /ignorados pelo \.gitignore/);
  assert.ok(!lines(withoutDocs).some((line) => line.startsWith("dist/")));
  const withGit = await globTool.run({ pattern: "**/*", respect_gitignore: false }, ctx);
  assert.ok(lines(withGit).includes("dist/out.js"));
});

test("arquivos ocultos só entram com include_hidden, e protegidos nunca entram", async () => {
  const { ctx } = await fixture();
  assert.ok(!lines(await globTool.run({ pattern: "*" }, ctx)).includes(".hidden.ts"));
  const hidden = await globTool.run({ pattern: "*", include_hidden: true }, ctx);
  assert.ok(lines(hidden).includes(".hidden.ts"));
  assert.ok(!lines(hidden).includes(".env"));
  assert.match(hidden, /protected files skipped/);
});

test("links simbólicos para fora do projeto não aparecem", async () => {
  const { ctx } = await fixture();
  const output = await globTool.run({ pattern: "src/**/*.ts", details: true }, ctx);
  assert.ok(!output.includes("link.ts"));
});

test("sort por nome, por data e por tamanho", async () => {
  const { ctx } = await fixture();
  const byName = await globTool.run({ pattern: "src/*.*", sort: "name" }, ctx);
  assert.deepEqual(lines(byName), ["src/a.ts", "src/b.tsx", "src/c.md"]);
  const byTime = await globTool.run({ pattern: "src/*.*", sort: "mtime" }, ctx);
  assert.deepEqual(lines(byTime), ["src/c.md", "src/b.tsx", "src/a.ts"]);
  const bySize = await globTool.run({ pattern: "src/*.*", sort: "size" }, ctx);
  assert.equal(lines(bySize)[0], "src/c.md");
});

test("details mostra tamanho e data em cada linha", async () => {
  const { ctx } = await fixture();
  const output = await globTool.run({ pattern: "src/c.md", details: true }, ctx);
  assert.match(output, /src\/c\.md {2}3 B {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
});

test("paginação: limit e offset, com a dica da próxima página", async () => {
  const { ctx } = await fixture();
  const first = await globTool.run({ pattern: "pages/*.txt", limit: 25, sort: "name" }, ctx);
  assert.equal(lines(first).length, 25);
  assert.match(first, /use offset=25/);
  const last = await globTool.run({ pattern: "pages/*.txt", limit: 25, offset: 50, sort: "name" }, ctx);
  assert.equal(lines(last).length, 10);
  assert.ok(!/use offset=/.test(last));
  assert.equal(lines(last)[0], "pages/p050.txt");
});

test("max_depth limita a profundidade", async () => {
  const { ctx } = await fixture();
  const output = await globTool.run({ pattern: "src/**/*.ts", max_depth: 1 }, ctx);
  assert.deepEqual(lines(output).sort(), ["src/a.ts"]);
});

test("path que não é pasta é recusado com orientação", async () => {
  const { ctx } = await fixture();
  await assert.rejects(globTool.run({ pattern: "*", path: "src/a.ts" }, ctx), /use Read/);
});

test("padrão que sai do projeto precisa de aprovação", async () => {
  const { ctx } = await fixture();
  assert.equal((await decideGlob("../*", ".", ctx)).decision, "ask_user");
  assert.equal((await decideGlob("/etc/*", ".", ctx)).decision, "ask_user");
  assert.equal((await decideGlob("src/**/*.ts", ".", ctx)).decision, "allow");
});
