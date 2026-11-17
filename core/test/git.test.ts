import { outputText } from "../src/tools/registry.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commitArgs, gitSnapshot } from "../src/git.js";
import { TOOLS } from "../src/tools/index.js";
import type { ToolContext } from "../src/types.js";

const IDENTITY = { GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@example.com" };
const COAUTHOR = "PlifResearch <github.com/PlifResearch>";

async function repo(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "plif-git-")));
  const env = { ...process.env, ...IDENTITY };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env });
  await writeFile(path.join(root, "a.txt"), "one\n");
  execFileSync("git", ["add", "--", "a.txt"], { cwd: root, env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root, env });
  return root;
}

function ctxFor(root: string, coauthor: string | null | undefined): ToolContext {
  return {
    root,
    home: path.join(root, "..", "home"),
    session: "git",
    sandbox: null,
    mode: { approval: "on-request", readOnly: false },
    readFiles: new Set(),
    approver: { ask: async () => "deny" as const },
    log: { record: async () => {} },
    coauthor,
  };
}

const gitTool = TOOLS.find((tool) => tool.name === "Git");
if (gitTool === undefined) throw new Error("Git tool not registered");

function input(overrides: Record<string, unknown>) {
  return { action: "status", path: "", staged: false, count: 10, message: "", paths: [], ...overrides };
}

test("snapshot mostra a branch e os arquivos alterados", async () => {
  const root = await repo();
  await writeFile(path.join(root, "b.txt"), "new\n");
  const snapshot = await gitSnapshot(root);
  assert.equal(snapshot?.branch, "main");
  assert.deepEqual(snapshot?.changes, ["?? b.txt"]);
});

test("fora de um repositório o snapshot é nulo", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "plif-nogit-")));
  assert.equal(await gitSnapshot(root), null);
});

test("leitura é permitida e commit pede aprovação", async () => {
  const root = await repo();
  const ctx = ctxFor(root, COAUTHOR);
  assert.equal((await gitTool.policy(input({ action: "status" }), ctx)).decision, "allow");
  const verdict = await gitTool.policy(input({ action: "commit", message: "x", paths: ["a.txt"] }), ctx);
  assert.equal(verdict.decision, "ask_user");
});

test("commit sem mensagem, com várias linhas ou sem arquivos é recusado", async () => {
  const root = await repo();
  const ctx = ctxFor(root, COAUTHOR);
  assert.equal((await gitTool.policy(input({ action: "commit", message: "", paths: ["a.txt"] }), ctx)).decision, "deny");
  assert.equal((await gitTool.policy(input({ action: "commit", message: "x\ny", paths: ["a.txt"] }), ctx)).decision, "deny");
  assert.equal((await gitTool.policy(input({ action: "commit", message: "x", paths: [] }), ctx)).decision, "deny");
});

test("arquivo fora do projeto não entra no commit", async () => {
  const root = await repo();
  const ctx = ctxFor(root, COAUTHOR);
  const verdict = await gitTool.policy(input({ action: "commit", message: "x", paths: ["../escape.txt"] }), ctx);
  assert.equal(verdict.decision, "deny");
});

test("commit com a linha de coautoria da organização", async () => {
  const root = await repo();
  await writeFile(path.join(root, "b.txt"), "new\n");
  const ctx = ctxFor(root, COAUTHOR);
  const args = input({ action: "commit", message: "adiciona b", paths: ["b.txt"] });
  const parsed = gitTool.parse(args);
  assert.equal(parsed.ok, true);
  const result = await gitTool.run(parsed.ok ? parsed.data : args, ctx);
  assert.match(outputText(result), /^committed [0-9a-f]+ adiciona b$/);
  const body = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: root, encoding: "utf8" });
  assert.match(body, /Co-authored-by: PlifResearch <github\.com\/PlifResearch>/);
});

test("sem coautoria configurada o commit sai sem a linha", async () => {
  const root = await repo();
  await writeFile(path.join(root, "c.txt"), "x\n");
  const ctx = ctxFor(root, null);
  const parsed = gitTool.parse(input({ action: "commit", message: "adiciona c", paths: ["c.txt"] }));
  if (!parsed.ok) throw new Error(parsed.message);
  await gitTool.run(parsed.data, ctx);
  const body = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: root, encoding: "utf8" });
  assert.doesNotMatch(body, /Co-authored-by/);
});

test("commitArgs usa --only e separa a coautoria em outro parágrafo", () => {
  assert.deepEqual(commitArgs("msg", ["a.ts"], COAUTHOR), ["commit", "--only", "-m", "msg", "-m", `Co-authored-by: ${COAUTHOR}`, "--", "a.ts"]);
  assert.deepEqual(commitArgs("msg", ["a.ts"], null), ["commit", "--only", "-m", "msg", "--", "a.ts"]);
});
