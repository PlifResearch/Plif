import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { promptContent, serveAcp } from "../src/acp.js";
import type { ModelClient } from "../src/model.js";

type Json = Record<string, unknown>;

// A fake editor: writes requests to Plif's stdin and reads its stdout line by line.
async function editor(model: ModelClient, answerPermission: (params: Json) => Json = () => ({ outcome: { outcome: "selected", optionId: "allow-once" } })) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-acp-")));
  const project = path.join(base, "project");
  await mkdir(project);
  const input = new PassThrough();
  const output = new PassThrough();
  const seen: Json[] = [];
  const waiters = new Map<number, (message: Json) => void>();
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let end = buffer.indexOf("\n");
    while (end !== -1) {
      const message = JSON.parse(buffer.slice(0, end)) as Json;
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
      seen.push(message);
      if (message["method"] === "session/request_permission") {
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id: message["id"], result: answerPermission(message["params"] as Json) })}\n`);
      } else if (typeof message["id"] === "number" && message["method"] === undefined) {
        waiters.get(message["id"] as number)?.(message);
      }
    }
  });
  const logs: string[] = [];
  const served = serveAcp({ input, output, homeRoot: path.join(base, ".plif"), model, log: (line) => logs.push(line) });
  let id = 0;
  const call = (method: string, params: Json): Promise<Json> =>
    new Promise((resolve) => {
      const current = ++id;
      waiters.set(current, resolve);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
    });
  const send = (method: string, params: Json) => input.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  const close = async () => {
    input.end();
    await served;
  };
  const updates = () => seen.filter((message) => message["method"] === "session/update").map((message) => (message["params"] as Json)["update"] as Json);
  return { base, project, call, send, close, seen, updates, logs };
}

function reply(content: unknown[], stop = "end_turn"): Anthropic.Message {
  return { id: "m", type: "message", role: "assistant", model: "m", stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content } as unknown as Anthropic.Message;
}

function scripted(replies: Anthropic.Message[]): ModelClient {
  return {
    create: async () => {
      const next = replies.shift();
      if (next === undefined) throw new Error("no scripted reply left");
      return next;
    },
  };
}

test("ACP: initialize anuncia a versão 1 e as capacidades; método desconhecido dá -32601", async () => {
  const client = await editor(scripted([]));
  try {
    const init = await client.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const result = init["result"] as Json;
    assert.equal(result["protocolVersion"], 1);
    assert.deepEqual((result["agentCapabilities"] as Json)["loadSession"], true);
    assert.deepEqual((result["agentInfo"] as Json)["name"], "plif");
    const unknown = await client.call("session/teleport", {});
    assert.equal((unknown["error"] as Json)["code"], -32601);
    const relative = await client.call("session/new", { cwd: "project", mcpServers: [] });
    assert.equal((relative["error"] as Json)["code"], -32602);
  } finally {
    await client.close();
  }
});

test("ACP: prompt roda ferramenta, manda tool_call, tool_call_update e a resposta, e termina com end_turn", async () => {
  const placeholder = "__FILE__";
  const replies = [reply([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: placeholder } }], "tool_use"), reply([{ type: "text", text: "the file says hello" }])];
  const client = await editor(scripted(replies));
  try {
    const file = path.join(client.project, "hello.txt");
    await writeFile(file, "hello\n");
    ((replies[0]?.content[0] as unknown) as { input: Json }).input["file_path"] = file;
    await client.call("initialize", { protocolVersion: 1 });
    const created = (await client.call("session/new", { cwd: client.project, mcpServers: [] }))["result"] as Json;
    const sessionId = String(created["sessionId"]);
    const answer = await client.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "read hello.txt" }] });
    assert.deepEqual(answer["result"], { stopReason: "end_turn" });
    const kinds = client.updates().map((update) => update["sessionUpdate"]);
    assert.deepEqual(kinds, ["tool_call", "tool_call_update", "agent_message_chunk"]);
    const call = client.updates()[0] ?? {};
    assert.equal(call["kind"], "read");
    assert.deepEqual(call["locations"], [{ path: file }]);
    assert.equal(client.updates()[1]?.["status"], "completed");
    assert.match(JSON.stringify(client.updates()[1]), /hello/);
  } finally {
    await client.close();
  }
});

test("ACP: ação que precisa de aprovação vira session/request_permission, e a recusa chega ao modelo", async () => {
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "plif-acp-outside-")));
  await writeFile(path.join(outside, "secret.txt"), "top secret\n");
  const asked: Json[] = [];
  const client = await editor(
    scripted([reply([{ type: "tool_use", id: "t9", name: "Read", input: { file_path: path.join(outside, "secret.txt") } }], "tool_use"), reply([{ type: "text", text: "ok" }])]),
    (params) => {
      asked.push(params);
      return { outcome: { outcome: "selected", optionId: "reject" } };
    },
  );
  try {
    await client.call("initialize", { protocolVersion: 1 });
    const sessionId = String(((await client.call("session/new", { cwd: client.project, mcpServers: [] }))["result"] as Json)["sessionId"]);
    await client.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "read it" }] });
    assert.equal(asked.length, 1);
    assert.equal((asked[0]?.["toolCall"] as Json)["toolCallId"], "t9");
    assert.deepEqual(((asked[0]?.["options"] as Json[]) ?? []).map((option) => option["kind"]), ["allow_once", "allow_always", "reject_once"]);
    const end = client.updates().find((update) => update["sessionUpdate"] === "tool_call_update");
    assert.equal(end?.["status"], "failed");
    assert.doesNotMatch(JSON.stringify(client.updates()), /top secret/);
  } finally {
    await client.close();
  }
});

test("ACP: session/cancel encerra o turno com stopReason cancelled", async () => {
  const model: ModelClient = {
    create: (_params, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  };
  const client = await editor(model);
  try {
    await client.call("initialize", { protocolVersion: 1 });
    const sessionId = String(((await client.call("session/new", { cwd: client.project, mcpServers: [] }))["result"] as Json)["sessionId"]);
    const running = client.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "think forever" }] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    client.send("session/cancel", { sessionId });
    assert.deepEqual((await running)["result"], { stopReason: "cancelled" });
  } finally {
    await client.close();
  }
});

test("ACP: session/load repete a conversa como updates antes de responder", async () => {
  const client = await editor(scripted([reply([{ type: "text", text: "first answer" }])]));
  try {
    await client.call("initialize", { protocolVersion: 1 });
    const sessionId = String(((await client.call("session/new", { cwd: client.project, mcpServers: [] }))["result"] as Json)["sessionId"]);
    await client.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "first question" }] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = client.updates().length;
    const loaded = await client.call("session/load", { sessionId, cwd: client.project, mcpServers: [] });
    assert.deepEqual(loaded["result"], {});
    const replayed = client.updates().slice(before);
    assert.deepEqual(
      replayed.map((update) => [update["sessionUpdate"], (update["content"] as Json)["text"]]),
      [
        ["user_message_chunk", "first question"],
        ["agent_message_chunk", "first answer"],
      ],
    );
    const missing = await client.call("session/load", { sessionId: "nope", cwd: client.project, mcpServers: [] });
    assert.equal((missing["error"] as Json)["code"], -32002);
  } finally {
    await client.close();
  }
});

test("ACP: blocos de recurso viram texto, link de recurso vira referência e imagem inválida é recusada", () => {
  const content = promptContent([
    { type: "text", text: "look" },
    { type: "resource", resource: { uri: "file:///a.py", text: "print(1)" } },
    { type: "resource_link", uri: "file:///b.md", name: "b.md" },
  ]);
  assert.match(JSON.stringify(content), /<resource uri=\\"file:\/\/\/a.py\\">\\nprint\(1\)/);
  assert.match(JSON.stringify(content), /resource_link uri=\\"file:\/\/\/b.md\\"/);
  assert.throws(() => promptContent([{ type: "image", data: "bm90IGFuIGltYWdl", mimeType: "image/png" }]), /image refused/);
  assert.throws(() => promptContent([]), /non-empty/);
});
