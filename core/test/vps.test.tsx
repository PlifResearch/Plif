import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import { decideBash } from "../src/policy/decide.js";
import { hardDenyReason, sshRemoteCommand } from "../src/policy/hard-deny.js";
import { SessionStore } from "../src/session.js";
import { parseShell } from "../src/shell.js";
import { SessionPicker } from "../src/tui/session-picker.js";
import { VpsBrowser } from "../src/tui/vps-browser.js";
import { checkKey, commandTemplate, expandKeyPath, vpsBlock, vpsFromDraft, vpsPolicyLine, type Vps } from "../src/vps.js";

const home = "/home/tester";
const ctx = { root: "/home/tester/project", home, sandboxed: true, readOnly: false };
const prod: Vps = { name: "prod", host: "203.0.113.10", user: "root", port: 22, keyPath: "~/.ssh/id_ed25519" };

test("ssh com comando remoto destrutivo é recusado no nível 0", () => {
  assert.notEqual(hardDenyReason("ssh -i ~/.ssh/k root@203.0.113.10 'rm -rf /'", ctx), null);
  assert.equal(hardDenyReason("ssh -i ~/.ssh/k root@203.0.113.10 'uptime'", ctx), null);
  assert.deepEqual(sshRemoteCommand(["ssh", "-p", "2222", "-i", "k", "root@h", "df", "-h"]), ["df", "-h"].join(" "));
  assert.equal(sshRemoteCommand(["ssh", "root@h"]), null);
});

test("ssh comum vai para a revisão do classificador, não é liberado nem recusado de cara", async () => {
  const verdict = await decideBash("ssh -i ~/.ssh/k -p 22 root@203.0.113.10 'systemctl status nginx'", ctx);
  assert.equal(verdict.decision, "ask_user");
  assert.equal(verdict.level, 3);
});

test("formulário valida porta, host e nome antes de testar", () => {
  assert.equal(vpsFromDraft({ name: "prod", host: "203.0.113.10", user: "root", port: "22", keyPath: "~/.ssh/id" }).port, 22);
  assert.throws(() => vpsFromDraft({ name: "Bad Name", host: "h", user: "root", port: "22", keyPath: "k" }), /invalid name/);
  assert.throws(() => vpsFromDraft({ name: "a", host: "bad host!", user: "root", port: "22", keyPath: "k" }), /invalid host/);
  assert.throws(() => vpsFromDraft({ name: "a", host: "h", user: "root", port: "70000", keyPath: "k" }), /invalid port/);
});

// Windows has no Unix permission bits, so chmod 644 and 600 give the same mode there.
test("chave: ausente, com permissão aberta ou correta", { skip: process.platform === "win32" }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "plif-key-")));
  const key = path.join(dir, "id_ed25519");
  assert.match((await checkKey(key, home))[0] ?? "", /key not found/);
  await writeFile(key, "not-a-real-key");
  await chmod(key, 0o644);
  assert.match((await checkKey(key, home))[0] ?? "", /readable by others/);
  await chmod(key, 0o600);
  assert.deepEqual(await checkKey(key, home), []);
  assert.match((await checkKey("relative/key", home))[0] ?? "", /absolute/);
});

test("Windows: uma chave existente usa a verificação de ACL do SSH e não bits Unix", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "plif-win-key-")));
  const key = path.join(dir, "test-key");
  await writeFile(key, "not-a-real-key", { mode: 0o644 });
  assert.deepEqual(await checkKey(key, dir, "win32"), []);
  assert.match((await checkKey(path.join(dir, "missing"), dir, "win32"))[0] ?? "", /key not found/);
  assert.match((await checkKey(dir, dir, "win32"))[0] ?? "", /not a file/);
  assert.equal(expandKeyPath("~\\.ssh\\id_ed25519", "C:\\Users\\Ana", "win32"), "C:\\Users\\Ana\\.ssh\\id_ed25519");
});

test("o comando SSH preserva espaços, barras e aspas no caminho da chave", () => {
  const command = commandTemplate({ ...prod, keyPath: "C:\\Users\\O'Brien\\my key" }, home);
  const parsed = parseShell(command);
  assert.equal(parsed?.[0]?.argv[2], "C:\\Users\\O'Brien\\my key");
  const variable = commandTemplate({ ...prod, keyPath: "/keys/$KEY;name" }, home);
  assert.ok(variable.includes("'/keys/$KEY;name'"));
});

test("contexto para o modelo traz o comando, nunca o conteúdo da chave", () => {
  const block = vpsBlock(prod, home);
  assert.match(block, /ssh -i \/home\/tester\/.ssh\/id_ed25519 -p 22/);
  assert.match(block, /Never print the key/);
  assert.doesNotMatch(block, /PRIVATE KEY/);
  assert.match(vpsPolicyLine(prod), /root@203\.0\.113\.10:22/);
  assert.match(commandTemplate(prod, home), /'<command>'$/);
});

test("sessão guarda a VPS ligada e a devolve ao reabrir", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "plif-sess-")));
  const store = new SessionStore(path.join(dir, "sessions"));
  const meta = await store.create("/home/tester/project", "claude-haiku-5-5");
  await store.setVps(meta, { name: prod.name, host: prod.host, user: prod.user, port: prod.port, keyPath: prod.keyPath });
  const listed = await store.list("/home/tester/project");
  assert.equal(listed[0]?.vps?.name, "prod");
  assert.equal(listed[0]?.vps?.keyPath, "~/.ssh/id_ed25519");
  const off = await store.setVps(listed[0]!, null);
  assert.equal(off.vps, null);
});

test("seletor de sessões mostra a VPS de cada uma", () => {
  const sessions = [
    { id: "abcdef12-0000", cwd: "/p", model: "m", createdAt: "2026-11-06T10:00:00Z", updatedAt: "2026-11-06T10:05:00Z", title: "deploy nginx", bytes: 4096, vps: { name: "prod", host: "h", user: "root", port: 22, keyPath: "k" } },
  ];
  const { lastFrame, unmount } = render(<SessionPicker sessions={sessions} onPick={() => {}} />);
  assert.match(lastFrame() ?? "", /deploy nginx/);
  assert.match(lastFrame() ?? "", /vps prod/);
  unmount();
});

test("/vps: lista com a VPS ativa marcada e formulário de cadastro", async () => {
  const { lastFrame, stdin, unmount } = render(
    <VpsBrowser list={[prod]} active="prod" onToggle={() => {}} onAdd={async () => ""} onTest={async () => ""} onDelete={async () => ""} onClose={() => {}} />,
  );
  assert.match(lastFrame() ?? "", /prod root@203\.0\.113\.10:22/);
  assert.match(lastFrame() ?? "", /on in this session/);
  stdin.write("a");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(lastFrame() ?? "", /name \(short, e\.g\. prod\)/);
  unmount();
});
