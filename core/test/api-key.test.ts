import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { type KeyStore, ensureApiKey, keyProblem, platformKeyStore } from "../src/api-key.js";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz_0123";

function memoryStore(initial: Record<string, string> = {}, failWrite = false) {
  const values = new Map(Object.entries(initial));
  const store: KeyStore = {
    label: "cofre de teste",
    async read(account) {
      return values.get(account) ?? null;
    },
    async write(account, secret) {
      if (failWrite) throw new Error("cofre indisponível");
      values.set(account, secret);
    },
    async remove(account) {
      values.delete(account);
    },
  };
  return { store, values };
}

function asker(answers: Array<string | null>) {
  const problems: Array<string | null> = [];
  const ask = async (problem: string | null) => {
    problems.push(problem);
    return answers.shift() ?? null;
  };
  return { ask, problems };
}

test("validação: chave vazia, com caracteres estranhos, curta ou com prefixo errado", () => {
  assert.match(keyProblem("", true) ?? "", /empty/);
  assert.match(keyProblem("sk-ant-com espaço", true) ?? "", /characters/);
  assert.match(keyProblem("sk-ant-curta", true) ?? "", /too short/);
  assert.match(keyProblem("sk-abcdefghijklmnopqrstuvwxyz", true) ?? "", /sk-ant-/);
  assert.equal(keyProblem(KEY, true), null);
  assert.equal(keyProblem("sk-abcdefghijklmnopqrstuvwxyz", false), null);
});

test("variável de ambiente tem prioridade e não pergunta nada", async () => {
  const { store, values } = memoryStore({ ANTHROPIC_API_KEY: "guardada" });
  const { ask, problems } = asker([]);
  const env = { ANTHROPIC_API_KEY: KEY } as NodeJS.ProcessEnv;
  const result = await ensureApiKey({ envName: "ANTHROPIC_API_KEY", anthropic: true, env, store, ask });
  assert.deepEqual(result, { source: "env", persisted: true });
  assert.equal(problems.length, 0);
  assert.equal(values.get("ANTHROPIC_API_KEY"), "guardada");
});

test("sem variável, usa a chave guardada no cofre sem perguntar", async () => {
  const { store } = memoryStore({ ANTHROPIC_API_KEY: KEY });
  const { ask, problems } = asker([]);
  const env = {} as NodeJS.ProcessEnv;
  const result = await ensureApiKey({ envName: "ANTHROPIC_API_KEY", anthropic: true, env, store, ask });
  assert.deepEqual(result, { source: "keychain", persisted: true });
  assert.equal(env["ANTHROPIC_API_KEY"], KEY);
  assert.equal(problems.length, 0);
});

test("sem chave em lugar nenhum, pergunta, repete a pergunta com o motivo e guarda a chave válida", async () => {
  const { store, values } = memoryStore();
  const { ask, problems } = asker(["sk-abcdefghijklmnopqrstuvwxyz0123", KEY]);
  const env = {} as NodeJS.ProcessEnv;
  const result = await ensureApiKey({ envName: "ANTHROPIC_API_KEY", anthropic: true, env, store, ask });
  assert.deepEqual(result, { source: "typed", persisted: true });
  assert.deepEqual(problems, [null, "the key should start with sk-ant-"]);
  assert.equal(values.get("ANTHROPIC_API_KEY"), KEY);
  assert.equal(env["ANTHROPIC_API_KEY"], KEY);
});

test("sem cofre, a chave digitada vale só para o processo atual", async () => {
  const { ask } = asker([KEY]);
  const env = {} as NodeJS.ProcessEnv;
  const result = await ensureApiKey({ envName: "ANTHROPIC_API_KEY", anthropic: true, env, store: null, ask });
  assert.deepEqual(result, { source: "typed", persisted: false });
  assert.equal(env["ANTHROPIC_API_KEY"], KEY);
});

test("cofre que recusa a gravação não derruba a sessão", async () => {
  const { store } = memoryStore({}, true);
  const { ask } = asker([KEY]);
  const env = {} as NodeJS.ProcessEnv;
  const result = await ensureApiKey({ envName: "ANTHROPIC_API_KEY", anthropic: true, env, store, ask });
  assert.deepEqual(result, { source: "typed", persisted: false });
  assert.equal(env["ANTHROPIC_API_KEY"], KEY);
});

test("cancelar a pergunta devolve null e não grava nada", async () => {
  const { store, values } = memoryStore();
  const { ask } = asker([null]);
  const result = await ensureApiKey({ envName: "ANTHROPIC_API_KEY", anthropic: true, env: {} as NodeJS.ProcessEnv, store, ask });
  assert.equal(result, null);
  assert.equal(values.size, 0);
});

// Uses the real keychain of this machine, so it runs only when asked for, under a throwaway service name.
const liveKeychain = process.env["PLIF_TEST_KEYRING"] === "1" ? test : test.skip;
liveKeychain("cofre do sistema: grava, lê de volta e remove o teste", async () => {
  const store = platformKeyStore(`plif-test-${randomUUID().slice(0, 8)}`);
  assert.ok(store !== null);
  const account = "ANTHROPIC_API_KEY";
  try {
    await store.write(account, KEY);
    assert.equal(await store.read(account), KEY);
    await store.write(account, `${KEY}x`);
    assert.equal(await store.read(account), `${KEY}x`);
  } finally {
    await store.remove(account);
  }
  assert.equal(await store.read(account), null);
});

test("cofre que não responde mostra o motivo na pergunta, em vez de fingir que a chave não existe", async () => {
  const broken: KeyStore = {
    label: "cofre quebrado",
    async read() {
      throw new Error("Cannot autolaunch D-Bus");
    },
    async write() {},
    async remove() {},
  };
  const problems: Array<string | null> = [];
  const result = await ensureApiKey({
    envName: "ANTHROPIC_API_KEY",
    anthropic: true,
    env: {} as NodeJS.ProcessEnv,
    store: broken,
    ask: async (problem) => {
      problems.push(problem);
      return null;
    },
  });
  assert.equal(result, null);
  assert.match(problems[0] ?? "", /could not read the system keychain.*D-Bus/);
});

test("Windows: o cofre da plataforma é o Gerenciador de Credenciais, e plataformas sem cofre ficam sem", () => {
  assert.equal(platformKeyStore("plif", "win32")?.label, "Windows Credential Manager");
  assert.equal(platformKeyStore("plif", "aix"), null);
});

test("Windows: Gerenciador de Credenciais que falha na leitura cai na pergunta e a chave vale para a sessão", async () => {
  const failing: KeyStore = {
    label: "Windows Credential Manager",
    async read() {
      throw new Error("the Credential Manager did not return the key (exit 1)");
    },
    async write() {
      throw new Error("the Credential Manager did not store the key");
    },
    async remove() {},
  };
  const env = {} as NodeJS.ProcessEnv;
  const problems: Array<string | null> = [];
  const result = await ensureApiKey({
    envName: "ANTHROPIC_API_KEY",
    anthropic: true,
    env,
    store: failing,
    ask: async (problem) => {
      problems.push(problem);
      return KEY;
    },
  });
  assert.deepEqual(result, { source: "typed", persisted: false });
  assert.equal(env["ANTHROPIC_API_KEY"], KEY);
  assert.match(problems[0] ?? "", /Credential Manager/);
});
