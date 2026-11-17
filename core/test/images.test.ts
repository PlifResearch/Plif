import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionStore } from "../src/session.js";
import {
  Attachments,
  absorbDroppedImages,
  attachImage,
  displayText,
  messageContentFor,
  readClipboardImage,
  removeLast,
  storeAttachments,
  windowsClipboardCommand,
} from "../src/tui/images.js";
import { formatSize } from "../src/tui/session-picker.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

async function fileIn(name: string, bytes: Buffer): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "plif-images-")));
  const file = path.join(dir, name);
  await writeFile(file, bytes);
  return file;
}

async function stagingIn(): Promise<string> {
  return path.join(await realpath(await mkdtemp(path.join(tmpdir(), "plif-staging-"))), "staging");
}

test("arrastar uma imagem copia o arquivo para a área de preparação, e o prompt guarda só o marcador", async () => {
  const source = await fileIn("tela.png", PNG);
  const staging = await stagingIn();
  const attachments = new Attachments();
  const value = absorbDroppedImages(`${source}`, attachments, staging).value;
  assert.equal(attachments.size, 1);
  const [attachment] = [...attachments.values()];
  assert.ok(attachment !== undefined);
  assert.ok(attachment.path.startsWith(staging), "a imagem precisa estar na pasta temporária");
  assert.ok(existsSync(attachment.path));
  assert.equal(displayText(value), "[Image #1]");
});

test("a numeração segue a posição no prompt, não a ordem em que as imagens entraram", async () => {
  const first = await fileIn("primeira.png", PNG);
  const second = await fileIn("segunda.png", PNG);
  const staging = await stagingIn();
  const attachments = new Attachments();
  const typed = absorbDroppedImages(`veja ${second} `, attachments, staging).value;
  const value = absorbDroppedImages(`${typed}depois ${first}`, attachments, staging).value;
  assert.equal(displayText(value), "veja [Image #1] depois [Image #2]");
  assert.equal(attachments.size, 2);
});

test("apagar com backspace remove o marcador inteiro", async () => {
  const file = await fileIn("tela.png", PNG);
  const attachments = new Attachments();
  const value = absorbDroppedImages(`${file}`, attachments, await stagingIn()).value;
  assert.equal(displayText(removeLast(value)), "");
});

test("arquivo que não é imagem fica como texto e aparece como recusado", async () => {
  const file = await fileIn("nota.png", Buffer.from("isto não é uma imagem"));
  const attachments = new Attachments();
  const result = absorbDroppedImages(`${file}`, attachments, await stagingIn());
  assert.equal(result.value, file);
  assert.equal(attachments.size, 0);
  assert.match(result.rejected[0] ?? "", /unsupported format/);
});

test("ao enviar, a imagem sai da área de preparação para a pasta da sessão e vira bloco base64", async () => {
  const first = await fileIn("a.png", PNG);
  const second = await fileIn("b.png", PNG);
  const staging = await stagingIn();
  const attachments = new Attachments();
  const value = absorbDroppedImages(`antes ${first} e ${second} fim `, attachments, staging).value;
  const sessionImages = path.join(path.dirname(staging), "sessao-x", "scratchpad", "images");
  storeAttachments(value, attachments, sessionImages);
  for (const attachment of attachments.values()) assert.ok(attachment.path.startsWith(sessionImages));
  const content = messageContentFor(value, attachments);
  assert.ok(Array.isArray(content));
  const blocks = content as Array<{ type: string; text?: string; source?: { data: string; media_type: string } }>;
  assert.deepEqual(blocks.map((block) => block.type), ["text", "image", "text", "image", "text"]);
  assert.equal(blocks[0]?.text, "antes [Image #1]");
  assert.equal(blocks[2]?.text, " e [Image #2]");
  assert.equal(blocks[4]?.text, " fim ");
  assert.equal(blocks[1]?.source?.media_type, "image/png");
  assert.equal(blocks[1]?.source?.data, PNG.toString("base64"));
});

test("colar pela área de transferência grava a imagem na área de preparação", async () => {
  const staging = await stagingIn();
  const attachments = new Attachments();
  const value = attachImage("", attachments, { mediaType: "image/png", bytes: PNG }, staging);
  assert.equal(displayText(value), "[Image #1]");
  const [attachment] = [...attachments.values()];
  assert.ok(attachment !== undefined && readFileSync(attachment.path).equals(PNG));
});

test("prompt sem imagem continua sendo texto simples", () => {
  assert.equal(messageContentFor("  só texto  ", new Attachments()), "só texto");
});

test("tamanho da sessão: KB abaixo de 1 MB e MB acima", () => {
  assert.equal(formatSize(512), "1 KB");
  assert.equal(formatSize(4096), "4 KB");
  assert.equal(formatSize(2.5 * 1024 * 1024), "2.5 MB");
});

test("sessão: segredo em texto é mascarado, mas dados de imagem não são alterados", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "plif-sess-img-")));
  const store = new SessionStore(path.join(dir, "sessions"));
  const meta = await store.create("/home/tester/project", "claude-haiku-5-5");
  const looksLikeKey = "AKIAABCDEFGHIJKLMNOP";
  await store.append(meta, {
    role: "user",
    content: [
      { type: "text", text: "chave sk-ant-abcdefghijklmnop" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: looksLikeKey } },
    ],
  });
  const [entry] = await store.list("/home/tester/project");
  assert.ok((entry?.bytes ?? 0) > 0);
  const transcript = await readFile(path.join(dir, "sessions", meta.id, "transcript.jsonl"), "utf8");
  assert.match(transcript, /AKIAABCDEFGHIJKLMNOP/);
  assert.doesNotMatch(transcript, /sk-ant-abcdefghijklmnop/);
});

test("Windows: caminho C:\\ arrastado, com ou sem aspas, é reconhecido e as barras invertidas ficam", async () => {
  const attachments = new Attachments();
  const staging = await stagingIn();
  const plain = absorbDroppedImages("veja C:\\Users\\ana\\foto.png", attachments, staging, "win32");
  assert.deepEqual(plain.rejected, ["C:\\Users\\ana\\foto.png: file not found"]);
  const quoted = absorbDroppedImages('"C:\\Users\\ana\\Minhas fotos\\tela 1.png"', attachments, staging, "win32");
  assert.deepEqual(quoted.rejected, ["C:\\Users\\ana\\Minhas fotos\\tela 1.png: file not found"]);
  const unc = absorbDroppedImages("\\\\servidor\\pasta\\o'brien.jpg", attachments, staging, "win32");
  assert.deepEqual(unc.rejected, ["\\\\servidor\\pasta\\o'brien.jpg: file not found"]);
  const forward = absorbDroppedImages("D:/imagens/a.webp", attachments, staging, "win32");
  assert.deepEqual(forward.rejected, ["D:/imagens/a.webp: file not found"]);
});

test("Windows: palavra relativa continua texto, e file:/// vira caminho de unidade", async () => {
  const attachments = new Attachments();
  const staging = await stagingIn();
  assert.deepEqual(absorbDroppedImages("use logo.png e pasta\\logo.png", attachments, staging, "win32").rejected, []);
  const link = absorbDroppedImages("file:///C:/Users/ana/foto%201.png", attachments, staging, "win32");
  assert.deepEqual(link.rejected, ["C:\\Users\\ana\\foto 1.png: file not found"]);
});

test("Windows: arquivo real entre aspas duplas é anexado", async () => {
  const source = await fileIn("com espaço.png", PNG);
  const attachments = new Attachments();
  const value = absorbDroppedImages(`"${source}"`, attachments, await stagingIn(), "win32").value;
  assert.equal(displayText(value), "[Image #1]");
  assert.equal(attachments.size, 1);
});

test("fora do Windows, a barra invertida segue como escape do shell e C:\\ não é caminho", { skip: process.platform === "win32" }, async () => {
  const source = await fileIn("com espaço.png", PNG);
  const attachments = new Attachments();
  const staging = await stagingIn();
  const value = absorbDroppedImages(source.replace(" ", "\\ "), attachments, staging, "linux").value;
  assert.equal(displayText(value), "[Image #1]");
  assert.deepEqual(absorbDroppedImages("C:\\Users\\foto.png", attachments, staging, "linux").rejected, []);
});

test("Windows: Ctrl+V lê a imagem pelo PowerShell, escondido, com tempo limite e sem o caminho no script", async () => {
  const calls: Array<{ command: string; args: string[]; options: { env?: NodeJS.ProcessEnv; timeout?: number; windowsHide?: boolean } }> = [];
  const image = await readClipboardImage("win32", async (command, args, options) => {
    calls.push({ command, args, options });
    await writeFile(options.env?.["PLIF_CLIPBOARD_FILE"] ?? "", PNG);
    return Buffer.alloc(0);
  });
  assert.equal(image?.mediaType, "image/png");
  assert.ok(image?.bytes.equals(PNG));
  const [call] = calls;
  assert.ok(call !== undefined);
  assert.match(call.command, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.ok(call.args.includes("-NoProfile") && call.args.includes("-NonInteractive"));
  assert.equal(call.options.windowsHide, true);
  assert.ok((call.options.timeout ?? 0) > 0);
  const encoded = call.args[call.args.indexOf("-EncodedCommand") + 1] ?? "";
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /Get-Clipboard -Format Image/);
  assert.match(script, /\$env:PLIF_CLIPBOARD_FILE/);
  assert.ok(!existsSync(path.dirname(call.options.env?.["PLIF_CLIPBOARD_FILE"] ?? "/")), "a pasta temporária é apagada");
});

test("Windows: área de transferência sem imagem, ou PowerShell que falha, devolve null", async () => {
  assert.equal(await readClipboardImage("win32", async () => Buffer.alloc(0)), null);
  assert.equal(
    await readClipboardImage("win32", async () => {
      throw new Error("timeout");
    }),
    null,
  );
  const { options } = windowsClipboardCommand("C:\\Temp\\clip.png");
  assert.equal(options.env?.["PLIF_CLIPBOARD_FILE"], "C:\\Temp\\clip.png");
});
