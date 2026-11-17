import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execute } from "../src/exec.js";
import { probeSandbox, sandboxPrefix } from "../src/sandbox.js";
import type { SandboxSettings } from "../src/types.js";

async function setup(): Promise<{ root: string; secrets: string; settings: SandboxSettings }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-sandbox-")));
  const root = path.join(base, "projeto");
  const secrets = path.join(base, "casa", ".ssh");
  await mkdir(root);
  await mkdir(secrets, { recursive: true });
  await writeFile(path.join(secrets, "id_teste"), "segredo");
  const settings: SandboxSettings = { readOnly: false, network: "allow", maskPaths: [secrets], writableRoots: [] };
  return { root, secrets, settings };
}

async function inSandbox(root: string, settings: SandboxSettings, command: string) {
  const [file, ...args] = [...sandboxPrefix(root, settings), "/bin/sh", "-c", command];
  return execute(file ?? "bwrap", args, { cwd: root, timeoutMs: 10_000, maxBytes: 4000 });
}

const available = await probeSandbox((await setup()).root, (await setup()).settings);

test("sandbox grava na raiz e bloqueia gravação fora dela", { skip: !available && "bwrap indisponível" }, async () => {
  const { root, settings } = await setup();
  assert.equal((await inSandbox(root, settings, "echo ok > dentro.txt")).code, 0);
  await stat(path.join(root, "dentro.txt"));

  const outside = await inSandbox(root, settings, "echo x > /opt/plif-sandbox-probe");
  assert.notEqual(outside.code, 0);
  await assert.rejects(stat("/opt/plif-sandbox-probe"));
});

test("sandbox esconde os caminhos mascarados", { skip: !available && "bwrap indisponível" }, async () => {
  const { root, secrets, settings } = await setup();
  const result = await inSandbox(root, settings, `ls "${secrets}"`);
  assert.equal(result.output.trim(), "");
});

test("modo somente leitura impede gravação até na raiz", { skip: !available && "bwrap indisponível" }, async () => {
  const { root, settings } = await setup();
  const result = await inSandbox(root, { ...settings, readOnly: true }, "echo x > nao.txt");
  assert.notEqual(result.code, 0);
});

test("rede negada deixa só a interface de loopback", { skip: !available && "bwrap indisponível" }, async () => {
  const { root, settings } = await setup();
  const result = await inSandbox(root, { ...settings, network: "deny" }, "wc -l < /proc/net/dev");
  assert.ok(Number(result.output.trim()) <= 3, result.output);
});

test("o prefixo do sandbox começa pelo bwrap e termina com --", async () => {
  const { root, settings } = await setup();
  const prefix = sandboxPrefix(root, { ...settings, network: "deny" });
  assert.equal(prefix[0], "bwrap");
  assert.ok(prefix.includes("--unshare-net"));
  assert.equal(prefix.at(-1), "--");
});

test("dica do sandbox aparece só quando a falha vem do sandbox", async () => {
  const { sandboxHint } = await import("../src/tools/bash.js");
  assert.match(sandboxHint("curl: (6) Could not resolve host: x", { readOnly: false, network: "deny" }), /sandbox.network/);
  assert.equal(sandboxHint("curl: (6) Could not resolve host: x", { readOnly: false, network: "allow" }), "");
  assert.match(sandboxHint("Permission denied", { readOnly: true, network: "allow" }), /read-only/);
  assert.equal(sandboxHint("Permission denied", null), "");
});
