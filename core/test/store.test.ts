import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CatalogSchema } from "../src/catalog.js";
import { isTrusted, loadConfig, parseConfig, setTrust } from "../src/config.js";
import {
  deleteTopic,
  INDEX_MAX_LINES,
  listTopics,
  loadInstructions,
  parseTopic,
  readIndex,
  slugify,
  writeTopic,
} from "../src/memory.js";
import { ensureHome, homeLayout } from "../src/home.js";
import { PROMPTS_DIR } from "../src/prompts.js";
import { SessionStore } from "../src/session.js";
import { CONFIG_TEMPLATE, MODEL_TEMPLATE } from "../src/templates.js";
import { matchingCommands, parseCommand } from "../src/tui/commands.js";

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

test("o template do config é válido e tem os padrões", () => {
  const config = parseConfig(CONFIG_TEMPLATE);
  assert.equal(config.model, "gpt-6-luna");
  assert.equal(config.sandbox.network, "allow");
  assert.deepEqual(config.sandbox.mask_paths, ["~/.ssh", "~/.aws", "~/.gnupg"]);
});

test("config vazio usa os padrões", () => {
  const config = parseConfig("");
  assert.equal(config.approval_policy, "on-request");
  assert.equal(config.sandbox_mode, "workspace-write");
  assert.equal(config.memory.enabled, true);
});

test("setTrust acrescenta e troca a confiança sem perder o resto do arquivo", async () => {
  const file = path.join(await tempDir("plif-config-"), "config.toml");
  await writeFile(file, CONFIG_TEMPLATE);
  await setTrust(file, "/x/projeto", "trusted");
  assert.equal(isTrusted(await loadConfig(file), "/x/projeto"), true);

  await setTrust(file, "/x/projeto", "untrusted");
  const config = await loadConfig(file);
  assert.equal(isTrusted(config, "/x/projeto"), false);
  assert.equal(config.model, "gpt-6-luna");
  assert.equal((await readFile(file, "utf8")).match(/^\[projects\./gm)?.length, 1);
});

test("o modelo do template é um catálogo válido", () => {
  const catalog = CatalogSchema.parse(JSON.parse(MODEL_TEMPLATE));
  assert.ok(catalog.models.some((model) => model.id === catalog.default));
});

test("catálogo rejeita um modelo padrão que não está na lista", () => {
  const broken = {
    default: "x",
    classifier: "y",
    models: [{ id: "a", name: "A", contextWindow: 1, efforts: ["low"], defaultEffort: "low" }],
  };
  assert.throws(() => CatalogSchema.parse(broken));
});

test("sessões: criar, anexar, listar e carregar por prefixo", async () => {
  const store = new SessionStore(await tempDir("plif-sessions-"));
  const meta = await store.create("/projeto", "claude-opus-5-5");
  const once = await store.append(meta, { role: "user", content: "olá   mundo" });
  await store.append(once, { role: "assistant", content: [{ type: "text", text: "oi" }] });

  const listed = await store.list("/projeto");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.title, "olá mundo");
  assert.equal((await store.load(meta.id.slice(0, 8))).messages.length, 2);
  assert.equal((await store.list("/outro")).length, 0);
});

test("sessão grava segredos mascarados", async () => {
  const store = new SessionStore(await tempDir("plif-sessions-"));
  const meta = await store.create("/projeto", "claude-opus-5-5");
  await store.append(meta, { role: "user", content: "use a chave sk-ant-abcdefghijklmnop" });
  const loaded = await store.load(meta.id);
  assert.match(String(loaded.messages[0]?.content), /\[secret\]/);
  assert.doesNotMatch(String(loaded.messages[0]?.content), /sk-ant-abcdefghijklmnop/);
});

test("memória: gravar atualiza o índice e apagar remove a linha", async () => {
  const dir = await tempDir("plif-memory-");
  await writeTopic(dir, { name: "Preferências de testes", description: "usar node:test", type: "feedback", body: "Sempre rode npm test." });
  const index = await readIndex(dir);
  assert.match(index.text, /\[Preferências de testes\]\(preferencias_de_testes\.md\): usar node:test/);
  assert.equal((await listTopics(dir))[0]?.type, "feedback");

  await deleteTopic(dir, "preferencias_de_testes.md");
  assert.equal((await readIndex(dir)).text, "");
  assert.equal((await listTopics(dir)).length, 0);
});

test("memória: índice acima do limite de linhas é recusado", async () => {
  const dir = await tempDir("plif-memory-");
  const lines = Array.from({ length: INDEX_MAX_LINES }, (_, index) => `- [t${index}](t${index}.md): x`);
  await writeFile(path.join(dir, "MEMORY.md"), `${lines.join("\n")}\n`);
  await assert.rejects(
    writeTopic(dir, { name: "novo", description: "mais uma", type: "project", body: "corpo" }),
    /200 lines/,
  );
  const index = await readIndex(dir);
  assert.equal(index.truncated, false);
});

test("memória: leitura do índice respeita o corte e avisa", async () => {
  const dir = await tempDir("plif-memory-");
  const lines = Array.from({ length: INDEX_MAX_LINES + 5 }, (_, index) => `linha ${index}`);
  await writeFile(path.join(dir, "MEMORY.md"), lines.join("\n"));
  const index = await readIndex(dir);
  assert.equal(index.truncated, true);
  assert.equal(index.text.split("\n").length, INDEX_MAX_LINES);
});

test("memória: tipo desconhecido não é aceito como tópico", () => {
  assert.equal(parseTopic("---\nname: x\ndescription: y\ntype: qualquer\n---\n\ncorpo"), null);
  assert.equal(slugify("Preferências de Testes!"), "preferencias_de_testes");
});

test("primeira execução cria ~/.plif/PLIF.md com as instruções padrão e preserva o arquivo do usuário", async () => {
  const base = await tempDir("plif-home-");
  const home = homeLayout(path.join(base, ".plif"));
  await ensureHome(home);
  const created = await readFile(path.join(home.root, "PLIF.md"), "utf8");
  assert.equal(created, await readFile(path.join(PROMPTS_DIR, "PLIF.md"), "utf8"));
  await writeFile(path.join(home.root, "PLIF.md"), "minhas regras\n");
  await ensureHome(home);
  assert.equal(await readFile(path.join(home.root, "PLIF.md"), "utf8"), "minhas regras\n");
});

test("instruções: lê PLIF.md e AGENTS.md do projeto e ignora arquivos ausentes", async () => {
  const base = await tempDir("plif-instructions-");
  const root = path.join(base, "projeto");
  const home = homeLayout(path.join(base, ".plif"));
  await mkdir(root);
  await writeFile(path.join(root, "AGENTS.md"), "use pnpm\n");
  const found = await loadInstructions(home, root);
  assert.deepEqual(found, [{ source: "project (AGENTS.md)", text: "use pnpm" }]);
});

test("instruções: preserva o prompt pessoal acima de 64 KiB, incluindo UTF-8 e encerramento", async () => {
  const base = await tempDir("plif-large-instructions-");
  const root = path.join(base, "projeto");
  const home = homeLayout(path.join(base, ".plif"));
  await mkdir(root);
  await mkdir(home.root);
  const text = `<plif_instructions>\n${"Confira a saída e preserve as alterações do usuário.\n".repeat(2500)}</plif_instructions>`;
  await writeFile(home.instructions, text);

  const found = await loadInstructions(home, root);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.text.length, text.length, "o prompt precisa chegar inteiro ao modelo");
  assert.equal(found[0]?.text, text);
});

test("instruções: recusa arquivo acima de 256 KiB em vez de enviar regras parciais", async () => {
  const base = await tempDir("plif-oversized-instructions-");
  const home = homeLayout(path.join(base, ".plif"));
  await mkdir(home.root);
  await writeFile(home.instructions, "a".repeat(256 * 1024 + 1));

  await assert.rejects(loadInstructions(home, base), /256 KiB/);
});

test("comandos: filtram por prefixo e separam o argumento", () => {
  assert.deepEqual(matchingCommands("/mo").map((command) => command.name), ["model"]);
  assert.deepEqual(matchingCommands("/model claude"), []);
  assert.deepEqual(matchingCommands("texto"), []);
  assert.deepEqual(parseCommand("/effort high"), { name: "effort", arg: "high" });
});
