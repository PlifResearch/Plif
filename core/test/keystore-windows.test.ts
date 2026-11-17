import assert from "node:assert/strict";
import { test } from "node:test";
import { type CredentialRun, type CredentialRunner, windowsCredentialManager, windowsPowerShell } from "../src/keystore-windows.js";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz_0123";

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly input: string;
  readonly env: NodeJS.ProcessEnv;
}

// Imitates the PowerShell script: the action and target come by environment, the key by stdin.
function fakeVault(failWith?: number) {
  const vault = new Map<string, string>();
  const calls: Call[] = [];
  const runner: CredentialRunner = async (command, args, input, env) => {
    calls.push({ command, args, input, env });
    const ok = (stdout = ""): CredentialRun => ({ code: 0, stdout, stderr: "" });
    if (failWith !== undefined) return { code: failWith, stdout: "", stderr: "#< CLIXML" };
    const target = env["PLIF_CREDENTIAL_TARGET"] ?? "";
    switch (env["PLIF_CREDENTIAL_ACTION"]) {
      case "read": {
        const value = vault.get(target);
        return value === undefined ? { code: 3, stdout: "", stderr: "" } : ok(value);
      }
      case "write":
        vault.set(target, input.replace(/\n$/, ""));
        return ok();
      case "delete":
        vault.delete(target);
        return ok();
      default:
        return { code: 1, stdout: "", stderr: "" };
    }
  };
  return { vault, calls, runner };
}

test("Gerenciador de Credenciais: grava, lê, troca e remove só a chave da Plif", async () => {
  const { vault, calls, runner } = fakeVault();
  const store = windowsCredentialManager("plif", runner);
  assert.equal(store.label, "Windows Credential Manager");
  assert.equal(await store.read("ANTHROPIC_API_KEY"), null);
  await store.write("ANTHROPIC_API_KEY", KEY);
  assert.deepEqual([...vault.keys()], ["plif:ANTHROPIC_API_KEY"]);
  assert.equal(await store.read("ANTHROPIC_API_KEY"), KEY);
  await store.write("ANTHROPIC_API_KEY", `${KEY}x`);
  assert.equal(await store.read("ANTHROPIC_API_KEY"), `${KEY}x`);
  await store.remove("ANTHROPIC_API_KEY");
  assert.equal(await store.read("ANTHROPIC_API_KEY"), null);
  for (const call of calls) {
    assert.equal(call.command, windowsPowerShell());
    assert.ok(call.args.includes("-NonInteractive") && call.args.includes("-EncodedCommand"));
  }
});

test("Gerenciador de Credenciais: a chave vai pelo stdin, nunca nos argumentos nem no ambiente", async () => {
  const { calls, runner } = fakeVault();
  await windowsCredentialManager("plif", runner).write("OPENAI_API_KEY", KEY);
  const [call] = calls;
  assert.ok(call !== undefined);
  assert.equal(call.input, `${KEY}\n`);
  assert.ok(!call.args.some((arg) => arg.includes(KEY)));
  assert.ok(!Object.values(call.env).some((value) => value?.includes(KEY)));
  const script = Buffer.from(call.args.at(-1) ?? "", "base64").toString("utf16le");
  assert.match(script, /CredReadW/);
  assert.match(script, /CredWriteW/);
  assert.doesNotMatch(script, /OPENAI_API_KEY/);
});

test("Gerenciador de Credenciais: nomes e chaves fora do formato são recusados antes do PowerShell", async () => {
  const { calls, runner } = fakeVault();
  const store = windowsCredentialManager("plif", runner);
  await assert.rejects(store.read("A;B"), /invalid keychain name/);
  await assert.rejects(store.write("ANTHROPIC_API_KEY", "sk-ant-'; whoami"), /invalid key characters/);
  await assert.rejects(windowsCredentialManager("plif $(x)", runner).read("ANTHROPIC_API_KEY"), /invalid keychain name/);
  assert.equal(calls.length, 0);
});

test("Gerenciador de Credenciais: falha do PowerShell vira erro com o código de saída, sem repassar o CLIXML", async () => {
  const { runner } = fakeVault(1);
  const store = windowsCredentialManager("plif", runner);
  await assert.rejects(store.read("ANTHROPIC_API_KEY"), (error: Error) => {
    assert.match(error.message, /did not return the key \(exit 1\)/);
    assert.doesNotMatch(error.message, /CLIXML/);
    return true;
  });
  await assert.rejects(store.write("ANTHROPIC_API_KEY", KEY), /did not store the key/);
});

test("PowerShell vem da pasta do sistema, nunca pelo nome solto que o Windows também busca na pasta do projeto", () => {
  assert.equal(windowsPowerShell({ SystemRoot: "D:\\Win" }), "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(windowsPowerShell({}), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});
