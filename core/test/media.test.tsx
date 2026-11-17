import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { render } from "ink-testing-library";
import React from "react";
import { estimateMessagesTokens } from "../src/context.js";
import { checkImage, imageSize } from "../src/media.js";
import type { ModelClient } from "../src/model.js";
import { buildRuntime } from "../src/runtime.js";
import { readTool } from "../src/tools/read.js";
import { outputText } from "../src/tools/registry.js";
import type { ToolContext } from "../src/types.js";
import { App } from "../src/tui/App.js";
import { Attachments, absorbDroppedImages, displayText, imageNumbers, messageContentFor } from "../src/tui/images.js";

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error("condição não atingida a tempo");
    await settle(20);
  }
}

// Signature plus the IHDR chunk, which is where the size lives.
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x00, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

async function dirIn(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

test("dimensões vêm do cabeçalho de PNG e JPEG", () => {
  assert.deepEqual(imageSize(png(640, 480), "image/png"), { width: 640, height: 480 });
  assert.deepEqual(imageSize(jpeg(1920, 1080), "image/jpeg"), { width: 1920, height: 1080 });
});

test("imagem acima de 8000 px por lado é recusada com o motivo", () => {
  assert.match(String(checkImage(png(9000, 100))), /9000x100 px exceeds the limit of 8000/);
  assert.equal(typeof checkImage(png(800, 600)), "object");
  assert.match(String(checkImage(Buffer.from("texto"))), /unsupported format/);
});

test("Read devolve a imagem como bloco de imagem, com uma linha de descrição antes", async () => {
  const root = await dirIn("plif-read-img-");
  const file = path.join(root, "tela.png");
  await writeFile(file, png(320, 200));
  const ctx = { root, home: root, readFiles: new Set<string>() } as unknown as ToolContext;
  const output = await readTool.run({ file_path: file }, ctx);
  assert.ok(Array.isArray(output));
  const [label, image] = output;
  assert.equal(label?.type, "text");
  assert.match(label?.type === "text" ? label.text : "", /image\/png, 320x200 px/);
  assert.equal(image?.type, "image");
  assert.equal(image?.type === "image" && image.source.type === "base64" ? image.source.data : "", png(320, 200).toString("base64"));
  assert.match(outputText(output), /\[image image\/png\]/);
});

test("imagem dentro de tool_result conta como imagem na estimativa, e não como base64", () => {
  const big = Buffer.alloc(3_000_000).toString("base64");
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "oi" },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: big } }],
        },
      ],
    },
  ];
  assert.ok(estimateMessagesTokens(messages) < 5_000);
});

test("anexos seguem a numeração da sessão, e o modelo recebe rótulo e imagem na ordem do texto", async () => {
  const dir = await dirIn("plif-attach-");
  const first = path.join(dir, "a.png");
  const second = path.join(dir, "b b.png");
  await writeFile(first, png(10, 10));
  await writeFile(second, png(20, 20));
  const attachments = new Attachments(4);
  const staging = path.join(dir, "staging");
  // A file manager drop arrives as a file:// link, with the space percent-encoded.
  const value = absorbDroppedImages(`então tem essa ${first} e essa outra ${pathToFileURL(second).href} `, attachments, staging).value;
  assert.equal(displayText(value, attachments), "então tem essa [Image #4] e essa outra [Image #5] ");
  assert.deepEqual(imageNumbers(value, attachments), [4, 5]);
  const content = messageContentFor(value, attachments);
  assert.ok(Array.isArray(content));
  const blocks = content as Array<{ type: string; text?: string }>;
  assert.deepEqual(blocks.map((block) => block.type), ["text", "image", "text", "image"]);
  assert.equal(blocks[0]?.text, "então tem essa [Image #4]");
  assert.equal(blocks[2]?.text, " e essa outra [Image #5]");
});

function reply(text: string): Anthropic.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "x",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

test("Shift+Enter, Alt+Enter e barra invertida quebram a linha; Enter envia; o envio mostra o bloco e os anexos", async () => {
  const base = await dirIn("plif-newline-");
  const project = path.join(base, "projeto");
  await mkdir(project);
  const image = path.join(base, "foto.png");
  await writeFile(image, png(50, 50));
  const sent: Anthropic.MessageParam[] = [];
  const model: ModelClient = {
    async create(params) {
      sent.push(params.messages.at(-1) as Anthropic.MessageParam);
      return reply("ok");
    },
  };
  const runtime = await buildRuntime(project, path.join(base, ".plif"), model);
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  try {
    await settle();
    stdin.write("linha um");
    await settle();
    stdin.write("\u001B[13;2u");
    await settle();
    stdin.write("linha dois");
    await settle();
    stdin.write("\u001B\r");
    await settle();
    stdin.write("três\\");
    await settle();
    stdin.write("\r");
    await settle();
    stdin.write(`veja ${image} `);
    await settle();
    const typing = lastFrame() ?? "";
    assert.match(typing, /linha um.*\n.*linha dois\n.*três\n.*veja \[Image #1\]/);
    assert.equal(sent.length, 0);

    stdin.write("\r");
    await waitFor(() => sent.length === 1 && /^\S?\s+\[Image #1\]/m.test(lastFrame() ?? ""));
    const content = sent[0]?.content;
    assert.ok(Array.isArray(content));
    assert.equal((content[0] as { text: string }).text, "linha um\nlinha dois\ntrês\nveja [Image #1]");
    assert.equal(content[1]?.type, "image");
    const frame = lastFrame() ?? "";
    // The sent message starts the turn's rail; each attachment gets its own line under it.
    assert.match(frame, /^\S\s+linha um$/m);
    assert.match(frame, /^\S?\s+\[Image #1\]/m);
  } finally {
    unmount();
  }
});
