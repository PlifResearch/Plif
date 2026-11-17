import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decideFileAccess } from "../src/policy/decide.js";
import { cleanOldScratch, scratchBase, sessionFolders, sessionRoots, sessionScratch } from "../src/scratch.js";
import { loadInstructions } from "../src/memory.js";
import { homeLayout } from "../src/home.js";
import type { PolicyContext } from "../src/types.js";

test("pastas temporárias ficam sob o nome do usuário, separadas por projeto e por sessão", () => {
  const a = scratchBase("/home/x/projeto-a");
  const b = scratchBase("/home/x/projeto-b");
  assert.notEqual(a, b);
  assert.match(a, /plif-/);
  const scratch = sessionScratch("/home/x/projeto-a", "sessao-1");
  assert.equal(scratch.scratchpad, path.join(a, "sessao-1", "scratchpad"));
  assert.equal(scratch.images, path.join(scratch.scratchpad, "images"));
});

test("raízes da sessão: scratchpad, artifacts e Plif.md entram na política; a pasta da sessão não", () => {
  const roots = sessionRoots("/home/x/projeto", "/home/x/.plif/sessions", "abc");
  assert.ok(roots.policy.some((root) => root.endsWith(path.join("abc", "scratchpad"))));
  assert.ok(roots.policy.includes("/home/x/.plif/sessions/abc/artifacts"));
  assert.ok(roots.policy.includes("/home/x/.plif/sessions/abc/Plif.md"));
  assert.ok(!roots.policy.includes("/home/x/.plif/sessions/abc"));
  assert.ok(!roots.sandbox.some((root) => root.endsWith("abc")), "o sandbox não escreve na pasta da sessão");
  assert.equal(sessionFolders("/x/sessions", "abc").memory, "/x/sessions/abc/Plif.md");
});

test("escrever no rascunho da sessão não pede aprovação; fora dele, pede", async () => {
  const project = await realpath(await mkdtemp(path.join(tmpdir(), "plif-policy-")));
  const scratch = sessionScratch(project, "s1").scratchpad;
  const ctx: PolicyContext = { root: project, home: project, scratchRoots: [scratch] };
  const inside = await decideFileAccess(path.join(scratch, "rascunho.md"), "write", ctx);
  assert.equal(inside.decision, "allow");
  assert.equal(inside.level, 2);
  const outside = await decideFileAccess(path.join(project, "..", "fora.md"), "write", ctx);
  assert.equal(outside.decision, "ask_user");
});

test("limpeza remove só pastas paradas há mais de 30 dias", async () => {
  const userDir = await realpath(await mkdtemp(path.join(tmpdir(), "plif-clean-")));
  const old = path.join(userDir, "antigo");
  const fresh = path.join(userDir, "recente");
  await mkdir(old);
  await mkdir(fresh);
  await writeFile(path.join(old, "x"), "x");
  const past = new Date(Date.now() - 40 * 86_400_000);
  await utimes(old, past, past);
  const removed = await cleanOldScratch(userDir);
  assert.equal(removed, 1);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
});

test("Instructions.md é a memória do usuário; PLIF.md continua valendo enquanto ele não existe", async () => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "plif-instr-")));
  const project = await realpath(await mkdtemp(path.join(tmpdir(), "plif-instr-proj-")));
  await writeFile(path.join(home, "PLIF.md"), "antigo");
  const fallback = await loadInstructions(homeLayout(home), project);
  assert.ok(fallback.some((item) => item.text === "antigo" && item.source.includes("PLIF.md")));
  await writeFile(path.join(home, "Instructions.md"), "preferencias");
  const current = await loadInstructions(homeLayout(home), project);
  assert.ok(current.some((item) => item.text === "preferencias" && item.source.includes("Instructions.md")));
  assert.ok(!current.some((item) => item.text === "antigo"));
});
