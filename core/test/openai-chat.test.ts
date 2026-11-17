import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";
import { modelFromProvider } from "../src/model.js";
import { runAgent } from "../src/agent.js";
import { fromChatResponse, openAiChatModel, openAiClient, toChatRequest } from "../src/openai-chat.js";
import { TOOLS } from "../src/tools/index.js";
import type { ToolContext } from "../src/types.js";

interface Canned {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface Seen {
  url: string;
  authorization: string | null;
  body: unknown;
}

function fakeFetch(canned: Canned[], seen: Seen[]): typeof fetch {
  const queue = [...canned];
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(url),
      authorization: headers.get("authorization"),
      body: JSON.parse(String(init?.body ?? "null")),
    });
    const next = queue.shift();
    if (next === undefined) throw new Error("no canned response left");
    const text = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status ?? 200, headers: { "content-type": "application/json", ...next.headers } });
  }) as typeof fetch;
}

function completion(message: Record<string, unknown>, finish = "stop", usage?: Record<string, unknown>) {
  return { id: "chatcmpl-1", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: finish, message, logprobs: null }], usage };
}

function modelOver(canned: Canned[], seen: Seen[]) {
  const client = openAiClient({ apiKey: "k", baseUrl: "https://fake.test/v1", fetch: fakeFetch(canned, seen) });
  return openAiChatModel({ client, retry: { wait: async () => {} } });
}

const user = (text: string): Anthropic.MessageParam => ({ role: "user", content: text });

test("toChatRequest converte sistema, ferramentas e resultados na ordem que a API exige", () => {
  const request = toChatRequest({
    model: "m",
    max_tokens: 100,
    system: [{ type: "text", text: "sys" }],
    tools: [{ name: "Read", description: "read", input_schema: { type: "object", properties: {} } }],
    messages: [
      user("hi"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file body" },
          { type: "text", text: "next" },
        ],
      },
    ],
  });
  assert.deepEqual(
    request.messages.map((message) => message.role),
    ["system", "user", "assistant", "tool", "user"],
  );
  const assistant = request.messages[2];
  assert.ok(assistant && assistant.role === "assistant" && assistant.tool_calls);
  const call = assistant.tool_calls[0];
  assert.ok(call && call.type === "function");
  assert.equal(call.function.arguments, '{"file_path":"a"}');
  const tool = request.messages[3];
  assert.ok(tool && tool.role === "tool");
  assert.equal(tool.tool_call_id, "t1");
  assert.equal(tool.content, "file body");
  const declared = request.tools?.[0];
  assert.ok(declared && declared.type === "function");
  assert.equal(declared.function.name, "Read");
  assert.equal(request.max_completion_tokens, 100);
});

test("toChatRequest envia saída estruturada como json_schema", () => {
  const request = toChatRequest({
    model: "m",
    max_tokens: 50,
    messages: [user("classify")],
    output_config: { format: { type: "json_schema", schema: { type: "object", properties: {} } } },
  } as Anthropic.MessageCreateParamsNonStreaming);
  assert.deepEqual(request.response_format, {
    type: "json_schema",
    json_schema: { name: "output", schema: { type: "object", properties: {} }, strict: false },
  });
});

test("fromChatResponse mapeia tool_calls, motivo de parada e cache", () => {
  const message = fromChatResponse(
    completion(
      { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: '{"file_path":"a"}' } }] },
      "tool_calls",
      { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } },
    ) as never,
    "m",
  );
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.content[0], { type: "tool_use", id: "c1", name: "Read", input: { file_path: "a" } });
  assert.equal(message.usage.input_tokens, 200);
  assert.equal(message.usage.cache_read_input_tokens, 800);
  assert.equal(message.usage.output_tokens, 20);
});

test("finish_reason length vira max_tokens", () => {
  const message = fromChatResponse(completion({ content: "cut" }, "length") as never, "m");
  assert.equal(message.stop_reason, "max_tokens");
});

test("envia a chave como Bearer e retenta 429 antes de responder", async () => {
  const seen: Seen[] = [];
  const model = modelOver(
    [{ status: 429, body: { error: { message: "slow", type: "rate_limit" } }, headers: { "retry-after-ms": "1" } }, { body: completion({ content: "hello" }) }],
    seen,
  );
  const message = await model.create({ model: "m", max_tokens: 10, messages: [user("hi")] });
  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.url, "https://fake.test/v1/chat/completions");
  assert.equal(seen[0]?.authorization, "Bearer k");
  assert.deepEqual(message.content[0], { type: "text", text: "hello", citations: null });
});

test("estouro de janela vira motivo de parada, para o agente compactar", async () => {
  const seen: Seen[] = [];
  const model = modelOver([{ status: 400, body: { error: { code: "context_length_exceeded", message: "too long", type: "invalid_request_error" } } }], seen);
  const message = await model.create({ model: "m", max_tokens: 10, messages: [user("hi")] });
  assert.equal(message.stop_reason, "model_context_window_exceeded");
  assert.equal(seen.length, 1);
});

test("HTTP 401 falha sem nova tentativa", async () => {
  const seen: Seen[] = [];
  const model = modelOver([{ status: 401, body: { error: { message: "bad key", type: "invalid_request_error" } } }], seen);
  await assert.rejects(model.create({ model: "m", max_tokens: 10, messages: [user("hi")] }), /401/);
  assert.equal(seen.length, 1);
});

test("sem chave, a requisição sai sem cabeçalho Authorization", async () => {
  const seen: Seen[] = [];
  const client = openAiClient({ apiKey: "", baseUrl: "https://fake.test/v1", fetch: fakeFetch([{ body: completion({ content: "free" }) }], seen) });
  const message = await openAiChatModel({ client }).create({ model: "m", max_tokens: 10, messages: [user("hi")] });
  assert.equal(seen[0]?.authorization, null);
  assert.deepEqual(message.content[0], { type: "text", text: "free", citations: null });
});

test("provedor padrão é openai e anthropic aceita URL própria", () => {
  const defaults = parseConfig("");
  assert.equal(defaults.provider.kind, "openai");
  assert.equal(defaults.provider.base_url, undefined);
  assert.equal(defaults.provider.api_key_env, undefined);
  const anthropic = parseConfig('[provider]\nkind = "anthropic"\nbase_url = "https://example.com"\n');
  assert.equal(anthropic.provider.kind, "anthropic");
  assert.throws(() => parseConfig('[provider]\nbase_url = "not a url"\n'));
});

test("agente completo com provedor openai: chama Read, recebe o resultado e termina", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-openai-")));
  const file = path.join(base, "a.txt");
  await writeFile(file, "line one\n");
  const ctx: ToolContext = {
    root: base,
    home: path.join(base, "home"),
    session: "openai",
    sandbox: null,
    mode: { approval: "on-request", readOnly: false },
    readFiles: new Set(),
    approver: { ask: async () => "deny" as const },
    log: { record: async () => {} },
  };
  const seen: Seen[] = [];
  const model = modelOver(
    [
      {
        body: completion(
          { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: file }) } }] },
          "tool_calls",
        ),
      },
      { body: completion({ content: "done" }) },
    ],
    seen,
  );
  const answer = await runAgent({ model, system: "s", tools: TOOLS, messages: [user("read it")], ctx, maxTurns: 4 });
  assert.equal(answer, "done");
  const second = seen[1]?.body as { messages: Array<{ role: string; content: string | null }> };
  const tool = second.messages.find((message) => message.role === "tool");
  assert.match(tool?.content ?? "", /1\tline one/);
});

test("reasoning_content vira bloco de pensamento e volta na mensagem do assistente", () => {
  const first = fromChatResponse(
    completion({ content: null, reasoning_content: "r1", tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: "{}" } }] }, "tool_calls") as never,
    "m",
  );
  assert.equal(first.content[0]?.type, "thinking");
  const request = toChatRequest({ model: "m", max_tokens: 10, messages: [user("go"), { role: "assistant", content: first.content as Anthropic.ContentBlockParam[] }] });
  const assistant = request.messages[1] as { reasoning_content?: string };
  assert.equal(assistant.reasoning_content, "r1");
});

test("toChatRequest envia a imagem do usuário como image_url, na ordem do texto", () => {
  const request = toChatRequest({
    model: "gpt-x",
    max_tokens: 100,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "veja [Image #1]" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "text", text: " e diga" },
        ],
      },
    ],
  } as Anthropic.MessageCreateParamsNonStreaming);
  const user = request.messages.find((message) => message.role === "user");
  assert.deepEqual(user?.content, [
    { type: "text", text: "veja [Image #1]" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    { type: "text", text: " e diga" },
  ]);
});

test("toChatRequest mantém mensagem só de texto como string", () => {
  const request = toChatRequest({
    model: "gpt-x",
    max_tokens: 100,
    messages: [{ role: "user", content: "oi" }],
  } as Anthropic.MessageCreateParamsNonStreaming);
  assert.equal(request.messages.find((message) => message.role === "user")?.content, "oi");
});
