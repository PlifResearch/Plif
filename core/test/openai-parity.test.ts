import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensureApiKey, probeKeyRequired, providerKeyOptions } from "../src/api-key.js";
import { runAgent } from "../src/agent.js";
import { CatalogSchema } from "../src/catalog.js";
import { createClassifier } from "../src/classifier.js";
import { parseConfig } from "../src/config.js";
import { type ModelProgress, modelRoles, providerKey } from "../src/model.js";
import { openAiChatModel, openAiClient, openAiStrictSchema, toChatRequest } from "../src/openai-chat.js";
import { cleanTitle, TitledSessionStore } from "../src/session-title.js";
import { createSummarizer } from "../src/summarizer.js";
import { TOOLS } from "../src/tools/index.js";
import { MODEL_TEMPLATE } from "../src/templates.js";
import type { ToolContext } from "../src/types.js";

interface Canned {
  status?: number;
  body?: unknown;
  // Server-sent events: each item becomes one `data:` line, and [DONE] closes the stream.
  events?: unknown[];
}

interface Seen {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(canned: Canned[], seen: Seen[]): typeof fetch {
  const queue = [...canned];
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) as Record<string, unknown> });
    const next = queue.shift();
    if (next === undefined) throw new Error("no canned response left");
    if (next.events !== undefined) {
      const text = `${next.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
      return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function modelOver(canned: Canned[], seen: Seen[], baseUrl = "https://fake.test/v1", extra: Partial<Parameters<typeof openAiChatModel>[0]> = {}) {
  const client = openAiClient({ apiKey: "k", baseUrl, fetch: fakeFetch(canned, seen) });
  return openAiChatModel({ client, retry: { wait: async () => {} }, ...extra });
}

function completion(message: Record<string, unknown>, finish = "stop", usage?: Record<string, unknown>) {
  return { id: "c", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", ...message }, logprobs: null }], usage };
}

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return { id: "s", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] };
}

const user = (text: string): Anthropic.MessageParam => ({ role: "user", content: text });

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

test("stream: progresso de raciocínio, texto e ferramentas, com uso e cache lido", async () => {
  const seen: Seen[] = [];
  const model = modelOver(
    [
      {
        events: [
          chunk({ role: "assistant", reasoning_content: "pen" }),
          chunk({ reasoning_content: "sando" }),
          chunk({ content: "vou ler" }),
          chunk({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "Read", arguments: '{"file_' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: 'path":"x"}' } }] }),
          chunk({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "Grep", arguments: '{"pattern":"y"}' } }] }),
          chunk({}, "tool_calls"),
          { id: "s", object: "chat.completion.chunk", created: 0, model: "m", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 30, total_tokens: 1030, prompt_tokens_details: { cached_tokens: 900 } } },
        ],
      },
    ],
    seen,
  );
  const progress: ModelProgress[] = [];
  const stream = model.stream;
  assert.ok(stream !== undefined);
  const message = await stream({ model: "m", max_tokens: 10, messages: [user("hi")] }, undefined, (event) => progress.push(event));

  assert.deepEqual(progress, [
    { kind: "block", block: "thinking" },
    { kind: "thinking", chars: 3 },
    { kind: "thinking", chars: 5 },
    { kind: "block", block: "text" },
    { kind: "block", block: "tool_use" },
    { kind: "block", block: "tool_use" },
  ]);
  assert.deepEqual(message.content, [
    { type: "thinking", thinking: "pensando", signature: "" },
    { type: "text", text: "vou ler", citations: null },
    { type: "tool_use", id: "a", name: "Read", input: { file_path: "x" } },
    { type: "tool_use", id: "b", name: "Grep", input: { pattern: "y" } },
  ]);
  assert.equal(message.stop_reason, "tool_use");
  assert.equal(message.usage.cache_read_input_tokens, 900);
  assert.equal(message.usage.input_tokens, 100);
  assert.equal(message.usage.output_tokens, 30);
  assert.equal(seen[0]?.body["stream"], true);
  assert.deepEqual(seen[0]?.body["stream_options"], { include_usage: true });
});

test("stream: o campo reasoning (OpenRouter) também conta como raciocínio", async () => {
  const model = modelOver([{ events: [chunk({ reasoning: "abc" }), chunk({ content: "ok" }, "stop")] }], []);
  const progress: ModelProgress[] = [];
  const message = await model.stream!({ model: "m", max_tokens: 10, messages: [user("hi")] }, undefined, (event) => progress.push(event));
  assert.equal(message.content[0]?.type, "thinking");
  assert.deepEqual(progress[1], { kind: "thinking", chars: 3 });
  assert.equal(message.stop_reason, "end_turn");
});

test("stream: uma conexão encerrada sem finish_reason não libera ferramentas parciais", async () => {
  const partial = { events: [chunk({ tool_calls: [{ index: 0, id: "w", type: "function", function: { name: "Write", arguments: '{"file_path":"x","content":"partial"}' } }] })] };
  const model = modelOver([partial, partial, partial, partial], []);
  await assert.rejects(
    model.stream!({ model: "proxy-model", max_tokens: 100, messages: [user("write")] }, undefined, () => {}),
    /finish_reason/,
  );
});

test("stream: cancelar depois dos headers interrompe a leitura e rejeita a resposta parcial", { timeout: 2_000 }, async () => {
  const controller = new AbortController();
  let cancelled = false;
  const encoder = new TextEncoder();
  const client = openAiClient({
    apiKey: "proxy-token",
    baseUrl: "https://proxy.test/v1",
    fetch: (async () => new Response(new ReadableStream({
      start(output) {
        output.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: "partial" }))}\n\n`));
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch,
  });
  const model = openAiChatModel({ client });
  const reason = new Error("cancelled by user");
  const pending = model.stream!({ model: "qwen-through-proxy", max_tokens: 100, messages: [user("hi")] }, { signal: controller.signal }, () => controller.abort(reason));
  const timeout = setTimeout(() => controller.abort(reason), 1_000);
  try {
    await assert.rejects(pending, /cancelled by user/);
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(timeout);
  }
});

test("agente com stream executa duas ferramentas da mesma resposta e devolve os dois resultados", async () => {
  const base = await tempDir("plif-openai-par-");
  const one = path.join(base, "one.txt");
  const two = path.join(base, "two.txt");
  await writeFile(one, "first\n");
  await writeFile(two, "second\n");
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
        events: [
          chunk({ tool_calls: [{ index: 0, id: "r1", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: one, offset: null, limit: null }) } }] }),
          chunk({ tool_calls: [{ index: 1, id: "r2", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: two }) } }] }),
          chunk({}, "tool_calls"),
        ],
      },
      { events: [chunk({ content: "done" }, "stop")] },
    ],
    seen,
  );
  const answer = await runAgent({ model, system: "s", tools: TOOLS, messages: [user("read both")], ctx, maxTurns: 4 });
  assert.equal(answer, "done");
  const second = seen[1]?.body as { messages: Array<{ role: string; tool_call_id?: string; content: string }> };
  const tools = second.messages.filter((message) => message.role === "tool");
  assert.deepEqual(tools.map((message) => message.tool_call_id), ["r1", "r2"]);
  assert.match(tools[0]?.content ?? "", /first/);
  assert.match(tools[1]?.content ?? "", /second/);
});

test("ferramenta strict vira esquema estrito da OpenAI e o null dos campos opcionais some da entrada", () => {
  const read = TOOLS.find((tool) => tool.name === "Read");
  assert.ok(read);
  const request = toChatRequest({ model: "m", max_tokens: 10, messages: [user("x")], tools: [read.definition] });
  const declared = request.tools?.[0];
  assert.ok(declared && declared.type === "function");
  assert.equal(declared.function.strict, true);
  const parameters = declared.function.parameters as { required: string[]; properties: Record<string, { type: unknown }> };
  assert.deepEqual(parameters.required, ["file_path", "offset", "limit"]);
  assert.deepEqual(parameters.properties["offset"]?.type, ["integer", "null"]);

  const memory = TOOLS.find((tool) => tool.name === "Memory");
  assert.ok(memory);
  const loose = toChatRequest({ model: "m", max_tokens: 10, messages: [user("x")], tools: [memory.definition] }).tools?.[0];
  assert.ok(loose && loose.type === "function");
  assert.equal(loose.function.strict, undefined);
});

test("esquema com registro não pode ser estrito", () => {
  assert.equal(openAiStrictSchema({ type: "object", properties: { env: { type: "object", additionalProperties: { type: "string" } } } }), null);
  const ready = openAiStrictSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false });
  assert.equal(ready?.changed, false);
});

test("imagem em resultado de ferramenta segue numa mensagem de usuário logo depois das mensagens tool", () => {
  const request = toChatRequest({
    model: "m",
    max_tokens: 10,
    messages: [
      user("veja"),
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.png" } }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "image a.png" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    request.messages.map((message) => message.role),
    ["user", "assistant", "tool", "user"],
  );
  const tool = request.messages[2];
  assert.ok(tool?.role === "tool");
  assert.match(String(tool.content), /image a\.png[\s\S]*1 image\(s\) from this result follow/);
  const after = request.messages[3];
  assert.ok(after?.role === "user" && Array.isArray(after.content));
  assert.deepEqual(after.content, [
    { type: "text", text: "Images returned by tool call t1:" },
    { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
  ]);
});

test("API oficial: max_completion_tokens, reasoning_effort e prompt_cache_key; outros servidores: max_tokens", async () => {
  const seen: Seen[] = [];
  const params = { model: "m", max_tokens: 50, messages: [user("hi")], output_config: { effort: "high" as const } };
  const official = modelOver([{ body: completion({ content: "a" }) }], seen, "https://api.openai.com/v1", { promptCacheKey: "plif-key" });
  await official.create(params);
  assert.equal(seen[0]?.body["max_completion_tokens"], 50);
  assert.equal(seen[0]?.body["reasoning_effort"], "high");
  assert.equal(seen[0]?.body["prompt_cache_key"], "plif-key");

  const local = modelOver([{ body: completion({ content: "b" }) }], seen, "http://localhost:11434/v1", { promptCacheKey: "plif-key" });
  await local.create(params);
  assert.equal(seen[1]?.body["max_tokens"], 50);
  assert.equal(seen[1]?.body["max_completion_tokens"], undefined);
  assert.equal(seen[1]?.body["reasoning_effort"], undefined);
  assert.equal(seen[1]?.body["prompt_cache_key"], undefined);

  const flagged = modelOver([{ body: completion({ content: "c" }) }], seen, "http://localhost:8000/v1", {
    traits: () => ({ reasoningEffort: true, maxTokensField: "max_completion_tokens" }),
  });
  await flagged.create(params);
  assert.equal(seen[2]?.body["reasoning_effort"], "high");
  assert.equal(seen[2]?.body["max_completion_tokens"], 50);
});

test("servidor que recusa max_tokens recebe max_completion_tokens, e a troca fica para as próximas", async () => {
  const seen: Seen[] = [];
  const refusal = {
    status: 400,
    body: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: "invalid_request_error", param: "max_tokens", code: "unsupported_parameter" } },
  };
  const model = modelOver([refusal, { body: completion({ content: "a" }) }, { body: completion({ content: "b" }) }], seen, "http://localhost:8000/v1");
  await model.create({ model: "m", max_tokens: 10, messages: [user("hi")] });
  await model.create({ model: "m", max_tokens: 10, messages: [user("hi")] });
  assert.equal(seen.length, 3);
  assert.equal(seen[0]?.body["max_tokens"], 10);
  assert.equal(seen[1]?.body["max_completion_tokens"], 10);
  assert.equal(seen[2]?.body["max_completion_tokens"], 10);
});

test("reasoning_effort recusado sai da requisição", async () => {
  const seen: Seen[] = [];
  const model = modelOver(
    [
      { status: 400, body: { error: { message: "Unrecognized request argument supplied: reasoning_effort", type: "invalid_request_error", param: null, code: null } } },
      { body: completion({ content: "ok" }) },
    ],
    seen,
    "https://api.openai.com/v1",
  );
  await model.create({ model: "m", max_tokens: 10, messages: [user("hi")], output_config: { effort: "low" } });
  assert.equal(seen[0]?.body["reasoning_effort"], "low");
  assert.equal(seen[1]?.body["reasoning_effort"], undefined);
});

test("proxy: strict, stream_options e reasoning_content recusados são retirados por modelo", async () => {
  const seen: Seen[] = [];
  const rejected = (param: string) => ({ status: 400, body: { error: { message: `Unsupported parameter: ${param}`, param, code: "unsupported_parameter" } } });
  const model = modelOver([
    rejected("tools[0].function.strict"), rejected("stream_options"), rejected("messages[1].reasoning_content"),
    { events: [chunk({ content: "done" }, "stop")] },
    { events: [chunk({ content: "again" }, "stop")] },
  ], seen);
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: "qwen-through-proxy", max_tokens: 100,
    tools: [TOOLS.find((tool) => tool.name === "Read")!.definition],
    messages: [user("hi"), { role: "assistant", content: [{ type: "thinking", thinking: "thought", signature: "" }, { type: "text", text: "ok" }] }, user("continue")],
  };
  await model.stream!(params, undefined, () => {});
  await model.stream!(params, undefined, () => {});
  assert.equal(seen.length, 5);
  const last = seen.at(-1)!.body;
  assert.equal(last["stream_options"], undefined);
  assert.equal((last["tools"] as Array<{ function: { strict?: boolean } }>)[0]?.function.strict, undefined);
  assert.equal((last["messages"] as Array<{ reasoning_content?: string }>)[1]?.reasoning_content, undefined);
  assert.equal(last["model"], "qwen-through-proxy");
  assert.equal(seen[0]?.url, "https://fake.test/v1/chat/completions");
});

test("stream: um proxy que ignora stream e retorna JSON segue pelo mesmo adaptador", async () => {
  const model = modelOver([{ body: completion({ content: "ordinary JSON" }) }], []);
  const response = await model.stream!({ model: "proxy-id", max_tokens: 100, messages: [user("hi")] }, undefined, () => {});
  assert.deepEqual(response.content, [{ type: "text", text: "ordinary JSON", citations: null }]);
});

test("motivos de parada: length, content_filter, tool_calls e stop", async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["length", { content: "cut" }, "max_tokens"],
    ["content_filter", { content: null }, "refusal"],
    ["tool_calls", { content: null, tool_calls: [{ id: "c", type: "function", function: { name: "Read", arguments: "{}" } }] }, "tool_use"],
    ["stop", { content: "fim" }, "end_turn"],
  ];
  for (const [finish, message, expected] of cases) {
    const model = modelOver([{ body: completion(message, finish) }], []);
    assert.equal((await model.create({ model: "m", max_tokens: 10, messages: [user("hi")] })).stop_reason, expected, finish);
  }
  const refused = modelOver([{ body: completion({ content: null, refusal: "I can't help with that" }) }], []);
  const message = await refused.create({ model: "m", max_tokens: 10, messages: [user("hi")] });
  assert.equal(message.stop_reason, "refusal");
  assert.deepEqual(message.content[0], { type: "text", text: "I can't help with that", citations: null });
});

test("estouro de contexto no stream e em servidor que só manda a mensagem vira model_context_window_exceeded", async () => {
  const official = modelOver([{ status: 400, body: { error: { code: "context_length_exceeded", message: "too long", type: "invalid_request_error" } } }], []);
  const viaStream = await official.stream!({ model: "m", max_tokens: 10, messages: [user("hi")] }, undefined, () => {});
  assert.equal(viaStream.stop_reason, "model_context_window_exceeded");

  const vllm = modelOver([{ status: 400, body: { object: "error", message: "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.", type: "BadRequestError", code: 400 } }], []);
  const viaMessage = await vllm.create({ model: "m", max_tokens: 10, messages: [user("hi")] });
  assert.equal(viaMessage.stop_reason, "model_context_window_exceeded");
});

test("sinal já abortado cancela a requisição", async () => {
  const seen: Seen[] = [];
  const model = modelOver([{ body: completion({ content: "never" }) }], seen);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(model.create({ model: "m", max_tokens: 10, messages: [user("hi")] }, { signal: controller.signal }));
});

test("classificador e resumidor funcionam pelo provedor OpenAI", async () => {
  const seen: Seen[] = [];
  const model = modelOver(
    [
      { body: completion({ content: JSON.stringify({ decision: "allow", rule: "clearly_safe", reason: "reads a file" }) }) },
      { body: completion({ content: "summary of the session" }) },
    ],
    seen,
    "https://api.openai.com/v1",
  );
  const classify = createClassifier(model, "classifier prompt", "gpt-classifier");
  const decision = await classify({ user_messages: ["read"], recent_actions: [], pending_action: { tool: "Read", input: {} }, model_reason: "", project_policy: "" });
  assert.equal(decision.decision, "allow");
  assert.equal(seen[0]?.body["model"], "gpt-classifier");
  assert.equal((seen[0]?.body["response_format"] as { json_schema: { strict: boolean } }).json_schema.strict, true);

  const summary = await createSummarizer(model, "gpt-compact")([user("old work")]);
  assert.equal(summary, "summary of the session");
  assert.equal(seen[1]?.body["model"], "gpt-compact");
  assert.equal(seen[1]?.body["reasoning_effort"], "low");
});

test("detecção de chave: 200 dispensa e fica em cache, 401 pede, sem rede não decide", async () => {
  const dir = await tempDir("plif-probe-");
  const cacheFile = path.join(dir, "provider-probe.json");
  const urls: string[] = [];
  const answering = (status: number) =>
    (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response("{}", { status });
    }) as typeof fetch;

  assert.equal(await probeKeyRequired({ baseUrl: "http://localhost:11434/v1/", cacheFile, fetch: answering(200) }), false);
  assert.equal(urls[0], "http://localhost:11434/v1/models");
  assert.equal(await probeKeyRequired({ baseUrl: "http://localhost:11434/v1", cacheFile, fetch: answering(500) }), false);
  assert.equal(urls.length, 1);
  if (process.platform !== "win32") assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);

  assert.equal(await probeKeyRequired({ baseUrl: "https://openrouter.test/api/v1", cacheFile, fetch: answering(401) }), true);
  assert.equal(await probeKeyRequired({ baseUrl: "https://other.test/v1", cacheFile, fetch: answering(403) }), true);
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  assert.equal(await probeKeyRequired({ baseUrl: "http://down.test/v1", cacheFile, fetch: offline }), null);
  const cache = JSON.parse(await readFile(cacheFile, "utf8")) as Record<string, unknown>;
  assert.equal("http://down.test/v1" in cache, false);
  // An expired entry is asked again.
  assert.equal(await probeKeyRequired({ baseUrl: "http://localhost:11434/v1", cacheFile, fetch: answering(401), now: Date.now() + 2 * 86_400_000 }), true);
});

test("ensureApiKey: chave do TOML primeiro, servidor sem chave não pergunta, sem rede pergunta", async () => {
  const never = async () => {
    throw new Error("must not ask");
  };
  assert.equal((await ensureApiKey({ envName: "X_KEY", anthropic: false, env: { X_KEY: "env" } as NodeJS.ProcessEnv, store: null, ask: never, configKey: "toml" }))?.source, "config");
  const keyless = await ensureApiKey({ envName: "X_KEY", anthropic: false, env: {} as NodeJS.ProcessEnv, store: null, ask: never, keyOptional: async () => true });
  assert.equal(keyless?.source, "keyless");

  const asked: Array<string | null> = [];
  const env = {} as NodeJS.ProcessEnv;
  const typed = await ensureApiKey({
    envName: "X_KEY",
    anthropic: false,
    env,
    store: null,
    checkPrefix: false,
    keyOptional: async () => false,
    ask: async (problem) => {
      asked.push(problem);
      return "local-token";
    },
  });
  assert.equal(typed?.source, "typed");
  assert.equal(env["X_KEY"], "local-token");
  assert.deepEqual(asked, [null]);
});

test("providerKeyOptions só testa servidor compatível que não é o da OpenAI", () => {
  const official = providerKeyOptions(parseConfig("").provider, "/tmp/x");
  assert.equal(official.keyOptional, undefined);
  assert.equal(official.checkPrefix, true);
  const local = providerKeyOptions(parseConfig('[provider]\nbase_url = "http://localhost:1234/v1"\napi_key_env = "LM_KEY"\n').provider, "/tmp/x");
  assert.equal(typeof local.keyOptional, "function");
  assert.equal(local.checkPrefix, false);
  assert.equal(local.envName, "LM_KEY");
  const anthropic = providerKeyOptions(parseConfig('[provider]\nkind = "anthropic"\nbase_url = "https://proxy.test"\n').provider, "/tmp/x");
  assert.equal(anthropic.keyOptional, undefined);
  assert.equal(anthropic.envName, "ANTHROPIC_API_KEY");
});

test("api_key do TOML vence a variável de ambiente", () => {
  const provider = parseConfig('[provider]\napi_key = "from-toml"\n').provider;
  assert.equal(providerKey(provider, { OPENAI_API_KEY: "from-env" } as NodeJS.ProcessEnv), "from-toml");
  assert.equal(providerKey(parseConfig("").provider, { OPENAI_API_KEY: "from-env" } as NodeJS.ProcessEnv), "from-env");
  assert.equal(parseConfig('[provider]\napi_key = ""\n').provider.api_key, undefined);
});

test("[models]: campos vazios usam o catálogo e main substitui model", () => {
  const catalog = CatalogSchema.parse(JSON.parse(MODEL_TEMPLATE));
  const defaults = parseConfig('model = "gpt-6-luna"\n[models]\nmain = ""\nclassifier = ""\n');
  assert.equal(defaults.model, "gpt-6-luna");
  assert.deepEqual(modelRoles(defaults, catalog), { classifier: catalog.classifier, compaction: catalog.classifier, sessionSummary: catalog.classifier });

  const set = parseConfig(
    'model = "gpt-6-luna"\n[models]\nmain = "big"\nclassifier = "small"\ncompaction = "mid"\nsession_summary = "tiny"\nsubagent = "sub"\nexplore = "scan"\n',
  );
  assert.equal(set.model, "big");
  assert.deepEqual(modelRoles(set, catalog), { classifier: "small", compaction: "mid", sessionSummary: "tiny", subagent: "sub", explore: "scan" });
});

test("o template do config documenta provider e models e é válido", async () => {
  const { CONFIG_TEMPLATE } = await import("../src/templates.js");
  const config = parseConfig(CONFIG_TEMPLATE);
  assert.equal(config.provider.kind, "openai");
  assert.equal(parseConfig("").model, config.model);
  assert.equal(config.approval_policy, "on-request");
  assert.equal(config.models.main, undefined);
  assert.match(CONFIG_TEMPLATE, /api_key = ""/);
  assert.match(CONFIG_TEMPLATE, /session_summary/);
});

async function titledStore(title: (excerpt: string) => Promise<string>) {
  return new TitledSessionStore(await tempDir("plif-titles-"), title);
}

async function turn(store: TitledSessionStore, meta: Awaited<ReturnType<TitledSessionStore["create"]>>, text: string) {
  let next = await store.append(meta, user(text));
  next = await store.append(next, { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] });
  next = await store.append(next, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] });
  next = await store.append(next, { role: "assistant", content: [{ type: "text", text: `answer to ${text}` }] });
  await store.idle;
  return next;
}

test("título da sessão: gerado no primeiro turno e depois a cada 10, e uma falha mantém o atual", async () => {
  const excerpts: string[] = [];
  let fail = false;
  const store = await titledStore(async (excerpt) => {
    excerpts.push(excerpt);
    if (fail) throw new Error("model down");
    return `"Title number ${excerpts.length} with a lot of extra words that go past the sixty character limit"`;
  });
  let meta = await store.create("/p", "m");
  meta = await turn(store, meta, "configure ollama");
  assert.equal(excerpts.length, 1);
  assert.match(excerpts[0] ?? "", /user: configure ollama/);
  const first = (await store.list("/p"))[0]?.title ?? "";
  assert.equal(first, "Title number 1 with a lot of extra words that go past the si");
  assert.ok(first.length <= 60);

  for (let index = 2; index <= 10; index++) meta = await turn(store, meta, `step ${index}`);
  assert.equal(excerpts.length, 1);
  // The caller's meta copy keeps the generated title on later appends.
  assert.equal((await store.list("/p"))[0]?.title, first);

  fail = true;
  meta = await turn(store, meta, "step 11");
  assert.equal(excerpts.length, 2);
  assert.equal((await store.list("/p"))[0]?.title, first);
});

test("título escolhido pela pessoa não é trocado, e sessão retomada continua a contagem", async () => {
  let calls = 0;
  const store = await titledStore(async () => {
    calls++;
    return "Generated";
  });
  let meta = await store.create("/p", "m");
  meta = await turn(store, meta, "one");
  assert.equal(calls, 1);
  await store.rename(meta.id, "Mine");
  meta = { ...meta, title: "Mine" };
  for (let index = 2; index <= 11; index++) meta = await turn(store, meta, `step ${index}`);
  assert.equal(calls, 1);
  assert.equal((await store.list("/p"))[0]?.title, "Mine");

  const dir = await tempDir("plif-resume-");
  const other = new TitledSessionStore(dir, async () => {
    calls++;
    return "Resumed";
  });
  let session = await other.create("/q", "m");
  session = await turn(other, session, "first");
  assert.equal(calls, 2);
  const reopened = new TitledSessionStore(dir, async () => {
    calls++;
    return "After resume";
  });
  const loaded = await reopened.load(session.id);
  session = loaded.meta;
  for (let index = 2; index <= 10; index++) session = await turn(reopened, session, `more ${index}`);
  assert.equal(calls, 2);
  session = await turn(reopened, session, "eleven");
  assert.equal(calls, 3);
  assert.equal((await reopened.list("/q"))[0]?.title, "After resume");
});

test("cleanTitle tira aspas, prefixo e linhas extras", () => {
  assert.equal(cleanTitle('Title: "Fix login bug"\nmore'), "Fix login bug");
  assert.equal(cleanTitle("# Plan the release"), "Plan the release");
  assert.equal(cleanTitle("   "), "");
});
