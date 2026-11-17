import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { test } from "node:test";
import { ApiFailure, apiFailure, incompleteStream, retryAfter, retryApiCall, type RetryEvent } from "../src/api-retry.js";
import { runAgent } from "../src/agent.js";
import { createClassifier } from "../src/classifier.js";
import { ClassifierGate } from "../src/gate.js";
import { anthropicModel } from "../src/model.js";
import { openAiChatModel, openAiClient } from "../src/openai-chat.js";
import { createSummarizer } from "../src/summarizer.js";
import type { ToolContext } from "../src/types.js";

const params: Anthropic.MessageCreateParamsNonStreaming = { model: "proxy-model", max_tokens: 100, messages: [{ role: "user", content: "continue" }] };
const now = Date.parse("2026-11-15T17:00:00Z");
const rate = () => new OpenAI.APIError(429, { code: "rate_limit_exceeded", message: "Too many requests" }, undefined, new Headers());

function fakeClock() {
  const waits: number[] = [];
  return { waits, wait: async (ms: number) => { waits.push(ms); }, now: () => now };
}

function http(status: number, code = "", message = "rejected", headers = new Headers()) {
  return new OpenAI.APIError(status, { code, message }, undefined, headers);
}

test("API retries stop at five with increasing delays and preserve the last failure", async () => {
  let attempts = 0;
  const clock = fakeClock();
  const events: RetryEvent[] = [];
  await assert.rejects(retryApiCall(async () => { attempts++; throw rate(); }, { onRetry: (event) => events.push(event) }, clock), (error: unknown) => {
    assert.ok(error instanceof ApiFailure);
    assert.equal(error.kind, "rate_limit");
    assert.match(error.message, /stopped after 5 retries/i);
    return true;
  });
  assert.equal(attempts, 6);
  assert.deepEqual(clock.waits, [2_000, 4_000, 8_000, 16_000, 32_000]);
  assert.deepEqual(events.map((event) => event.retry), [1, 2, 3, 4, 5]);
});

test("incomplete streams get three retries, including interleaved rate limits", async () => {
  const clock = fakeClock();
  let attempts = 0;
  await assert.rejects(retryApiCall(async () => { attempts++; throw incompleteStream(); }, {}, clock), /after 3 incomplete-stream retries/);
  assert.equal(attempts, 4);
  assert.deepEqual(clock.waits, [2_000, 4_000, 8_000]);
  attempts = 0;
  const errors = [incompleteStream(), rate(), incompleteStream(), rate(), incompleteStream(), incompleteStream()];
  await assert.rejects(retryApiCall(async () => { throw errors[attempts++]; }, {}, clock), /after 3 incomplete-stream retries/);
  assert.equal(attempts, 6);
});

test("the global budget also bounds mixed stream, compatibility and server failures", async () => {
  let attempts = 0;
  const errors = [rate(), http(503), new ApiFailure("compatibility", "adjusted"), http(502), incompleteStream(), rate()];
  await assert.rejects(retryApiCall(async () => { throw errors[attempts++]; }, {}, fakeClock()), /after 5 retries/);
  assert.equal(attempts, 6);
});

test("Retry-After seconds, HTTP date, milliseconds and exhausted-resource resets are honored", () => {
  assert.equal(retryAfter(new Headers({ "retry-after": "12" }), now), 12_000);
  assert.equal(retryAfter(new Headers({ "retry-after-ms": "1250" }), now), 1_250);
  assert.equal(retryAfter(new Headers({ "retry-after": new Date(now + 30_000).toUTCString() }), now), 30_000);
  assert.equal(retryAfter(new Headers({ "retry-after": "invalid" }), now), undefined);
  assert.equal(retryAfter(new Headers({ "retry-after-ms": "-1" }), now), undefined);
  assert.equal(retryAfter(new Headers({ "x-ratelimit-reset-tokens": "1m2.5s", "x-ratelimit-remaining-tokens": "0" }), now), 62_500);
  assert.equal(retryAfter(new Headers({ "x-ratelimit-reset-tokens": "1h", "x-ratelimit-remaining-tokens": "10" }), now), undefined);
  assert.equal(retryAfter(new Headers({ "anthropic-ratelimit-requests-reset": new Date(now + 60_000).toISOString(), "anthropic-ratelimit-requests-remaining": "0" }), now), 60_000);
});

test("provider cooldowns are a minimum and subsequent waits keep growing", async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await retryApiCall(async () => {
    if (calls++ < 2) throw http(429, "rate_limit_exceeded", "slow", new Headers({ "retry-after": "120" }));
    return "ok";
  }, {}, clock);
  assert.equal(result, "ok");
  assert.deepEqual(clock.waits, [120_000, 121_000]);
});

test("authentication, access, missing models, invalid requests and exhausted credits do not retry", async () => {
  const cases: Array<[unknown, string]> = [
    [http(401), "authentication"], [http(403), "permission"], [http(404), "not_found"], [http(400), "invalid_request"], [http(413), "invalid_request"], [http(402), "usage_limit"],
    [http(429, "insufficient_quota"), "usage_limit"],
    [http(429, "insufficient_quota", "credits exhausted", new Headers({ "retry-after": "60" })), "usage_limit"],
    [http(404, "", "model not found after a rate limit"), "not_found"],
    [new Anthropic.APIError(400, { error: { type: "invalid_request_error", message: "Your credit balance is too low" } }, undefined, new Headers()), "usage_limit"],
    [http(429, "daily_limit_exceeded"), "usage_limit"],
  ];
  for (const [failure, kind] of cases) {
    let calls = 0;
    const clock = fakeClock();
    await assert.rejects(retryApiCall(async () => { calls++; throw failure; }, {}, clock), (error: unknown) => error instanceof ApiFailure && error.kind === kind);
    assert.equal(calls, 1);
    assert.deepEqual(clock.waits, []);
  }
});

test("a usage allowance with an explicit reset can be retried, and x-should-retry false is respected", async () => {
  const clock = fakeClock();
  let calls = 0;
  await retryApiCall(async () => {
    if (calls++ === 0) throw http(429, "usage_limit_reached", "limit", new Headers({ "retry-after": "300" }));
  }, {}, clock);
  assert.equal(calls, 2);
  assert.deepEqual(clock.waits, [300_000]);
  calls = 0;
  await assert.rejects(retryApiCall(async () => { calls++; throw http(503, "", "down", new Headers({ "x-should-retry": "false" })); }, {}, clock));
  assert.equal(calls, 1);
});

test("network failures, timeouts and overloads are recoverable; programming errors are preserved", async () => {
  for (const error of [new OpenAI.APIConnectionError({}), new Anthropic.APIConnectionTimeoutError(), http(408), http(409), http(529)]) {
    let calls = 0;
    const clock = fakeClock();
    assert.equal(await retryApiCall(async () => { if (calls++ === 0) throw error; return "ok"; }, {}, clock), "ok");
    assert.equal(calls, 2);
    assert.deepEqual(clock.waits, [2_000]);
  }
  const bug = new Error("internal bug");
  await assert.rejects(retryApiCall(async () => { throw bug; }, {}, fakeClock()), (error: unknown) => error === bug);
});

test("cancellation interrupts a real retry sleep without sending another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  let waiting: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { waiting = resolve; });
  const pending = retryApiCall(async () => { calls++; throw rate(); }, { signal: controller.signal, onRetry: () => waiting?.() });
  await ready;
  controller.abort(new Error("cancel retry"));
  await assert.rejects(pending, /abort|cancel retry/i);
  assert.equal(calls, 1);
});

test("API messages omit raw credentials and preserve safe request IDs", () => {
  const failure = apiFailure(http(401, "invalid_api_key", "Incorrect key: sk-secret-do-not-display", new Headers({ "x-request-id": "req_test-123" })));
  assert.ok(failure);
  assert.doesNotMatch(failure.message, /sk-secret/);
  assert.equal(failure.details.requestId, "req_test-123");
  assert.equal(apiFailure(http(401, "invalid_api_key", "bad", new Headers({ "x-request-id": "sk-should-not-show" })))?.details.requestId, undefined);
});

function completion() {
  return { id: "ok", model: "proxy-model", object: "chat.completion", created: 0, choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop", logprobs: null }] };
}

test("OpenAI SDK transport makes exactly six attempts even if the SDK was configured for its own retries", async () => {
  let calls = 0;
  const bodies: string[] = [];
  const client = new OpenAI({ apiKey: "fake", baseURL: "https://proxy.test/v1", maxRetries: 10, fetch: (async (_url, init) => {
    calls++; bodies.push(String(init?.body));
    return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow" } }), { status: 429 });
  }) as typeof fetch });
  const model = openAiChatModel({ client, retry: fakeClock() });
  await assert.rejects(model.create(params), /after 5 retries/);
  assert.equal(calls, 6);
  assert.equal(new Set(bodies).size, 1);
});

test("a failed stream retries from the original history and executes no partial tool calls", async () => {
  let calls = 0;
  const bodies: string[] = [];
  const partial = { id: "p", model: "proxy-model", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "Touch", arguments: "{}" } }] }, finish_reason: null }] };
  const client = openAiClient({ apiKey: "fake", baseUrl: "https://proxy.test/v1", fetch: (async (_url, init) => {
    calls++; bodies.push(String(init?.body));
    return new Response(`data: ${JSON.stringify(partial)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch });
  let executed = 0;
  const notices: string[] = [];
  const messages = structuredClone(params.messages);
  await assert.rejects(runAgent({
    model: openAiChatModel({ client, retry: fakeClock() }), system: "s", messages, ctx: {} as ToolContext, maxTurns: 1,
    tools: [{ name: "Touch", definition: { name: "Touch", input_schema: { type: "object" } }, parse: () => ({ ok: true, data: {} }), policy: async () => ({ level: 2, decision: "allow", reason: "test" }), run: async () => { executed++; return "done"; } }],
    events: { onNotice: (text) => notices.push(text) },
  }), /after 3 incomplete-stream retries/);
  assert.equal(calls, 4);
  assert.equal(executed, 0);
  assert.deepEqual(messages, params.messages);
  assert.equal(new Set(bodies).size, 1);
  assert.equal(notices.length, 3);
  assert.match(notices[0] ?? "", /Retrying in 2s/);
});

test("Anthropic also disables nested SDK retries and respects the same five retry limit", async () => {
  let calls = 0;
  const client = new Anthropic({ apiKey: "fake", maxRetries: 10, fetch: (async () => {
    calls++;
    return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "overloaded" } }), { status: 529 });
  }) as typeof fetch });
  await assert.rejects(anthropicModel(client, fakeClock()).create(params), /after 5 retries/);
  assert.equal(calls, 6);
});

test("recovering after an API error returns only the successful completion", async () => {
  let calls = 0;
  const model = openAiChatModel({ client: openAiClient({ apiKey: "fake", fetch: (async () => {
    return calls++ === 0
      ? new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow" } }), { status: 429 })
      : new Response(JSON.stringify(completion()), { headers: { "content-type": "application/json" } });
  }) as typeof fetch }), retry: fakeClock() });
  const result = await model.create(params);
  assert.deepEqual(result.content, [{ type: "text", text: "done", citations: null }]);
  assert.equal(calls, 2);
});

function anthropicEvents(complete: boolean): string {
  const events: object[] = [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
  ];
  if (complete) events.push({ type: "message_stop" });
  return events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

test("Anthropic requires message_stop and recovers on the third stream retry", async () => {
  let calls = 0;
  const client = new Anthropic({ apiKey: "fake", fetch: (async () => new Response(anthropicEvents(++calls === 4), { headers: { "content-type": "text/event-stream" } })) as typeof fetch });
  const clock = fakeClock();
  const message = await anthropicModel(client, clock).stream!(params, undefined, () => {});
  assert.equal(calls, 4);
  assert.equal(message.stop_reason, "end_turn");
  assert.deepEqual(clock.waits, [2_000, 4_000, 8_000]);
});

test("Anthropic stops an incomplete stream after three retries", async () => {
  let calls = 0;
  const client = new Anthropic({ apiKey: "fake", fetch: (async () => {
    calls++;
    return new Response(anthropicEvents(false), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch });
  await assert.rejects(anthropicModel(client, fakeClock()).stream!(params, undefined, () => {}), /after 3 incomplete-stream retries/);
  assert.equal(calls, 4);
});

test("malformed tool arguments in a finished stream are retried before execution", async () => {
  let calls = 0;
  const event = { id: "m", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "Write", arguments: '{"file_path":' } }] }, finish_reason: "tool_calls" }] };
  const client = openAiClient({ apiKey: "fake", fetch: (async () => {
    calls++;
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch });
  await assert.rejects(openAiChatModel({ client, retry: fakeClock() }).stream!(params, undefined, () => {}), /after 3 incomplete-stream retries/);
  assert.equal(calls, 4);
});

test("an explicit output token limit is reported without retrying partial tool arguments", async () => {
  let calls = 0;
  const event = { id: "m", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "Write", arguments: '{"file_path":' } }] }, finish_reason: "length" }] };
  const client = openAiClient({ apiKey: "fake", fetch: (async () => {
    calls++;
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch });
  const message = await openAiChatModel({ client, retry: fakeClock() }).stream!(params, undefined, () => {});
  assert.equal(calls, 1);
  assert.equal(message.stop_reason, "max_tokens");
  assert.equal(message.content.some((block) => block.type === "tool_use"), false);
});

test("compatibility fallbacks share the five retry budget with transient errors", async () => {
  let calls = 0;
  const client = openAiClient({ apiKey: "fake", fetch: (async () => {
    calls++;
    const error = calls === 1
      ? { code: "unsupported_parameter", param: "max_completion_tokens", message: "Unsupported parameter: max_completion_tokens" }
      : { code: "rate_limit_exceeded", message: "Too many requests" };
    return new Response(JSON.stringify({ error }), { status: calls === 1 ? 400 : 429 });
  }) as typeof fetch });
  await assert.rejects(openAiChatModel({ client, retry: fakeClock() }).create(params), /after 5 retries/);
  assert.equal(calls, 6);
});

test("classifier retries are cancellable and cancellation never becomes an approval", async () => {
  const controller = new AbortController();
  let calls = 0;
  const model = { create: () => retryApiCall(async () => { calls++; throw rate(); }, { signal: controller.signal, onRetry: () => controller.abort(new Error("stop classifier")) }, fakeClock()) };
  const gate = new ClassifierGate(createClassifier(model, "s"));
  await assert.rejects(gate.review({ user_messages: [], recent_actions: [], pending_action: { tool: "Write", input: {} }, model_reason: "", project_policy: "" }, { signal: controller.signal }), /stop classifier/);
  assert.equal(calls, 1);
  assert.equal(gate.isPaused, false);
});

test("classifier and compaction pass cancellation and retry notices to the provider", async () => {
  const controller = new AbortController();
  const event: RetryEvent = { retry: 1, maxRetries: 5, delayMs: 2_000, kind: "rate_limit", message: "limit" };
  const noticed: RetryEvent[] = [];
  const options = { signal: controller.signal, onRetry: (notice: RetryEvent) => noticed.push(notice) };
  let calls = 0;
  const model = { create: async (_params: Anthropic.MessageCreateParamsNonStreaming, controls?: import("../src/model.js").ModelRequestOptions) => {
    assert.equal(controls?.signal, controller.signal);
    controls?.onRetry?.(event);
    return { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: calls++ === 0 ? '{"decision":"ask_user","rule":"unclear","reason":"review"}' : "summary" }] } as Anthropic.Message;
  } };
  const decision = await createClassifier(model, "s")({ user_messages: [], recent_actions: [], pending_action: { tool: "Read", input: {} }, model_reason: "", project_policy: "" }, options);
  assert.equal(decision.decision, "ask_user");
  assert.equal(await createSummarizer(model, "m")(params.messages, options), "summary");
  assert.deepEqual(noticed, [event, event]);
});

test("retrying the next model response does not replay an already completed tool", async () => {
  let calls = 0;
  let executed = 0;
  const call = { id: "m", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "Touch", arguments: "{}" } }] }, finish_reason: "tool_calls" }] };
  const partial = { id: "p", model: "m", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] };
  const client = openAiClient({ apiKey: "fake", fetch: (async () => {
    const event = calls++ === 0 ? call : partial;
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch });
  const ctx = { session: "retry", log: { record: async () => {} } } as unknown as ToolContext;
  const messages = structuredClone(params.messages);
  await assert.rejects(runAgent({
    model: openAiChatModel({ client, retry: fakeClock() }), messages, ctx, system: "s", maxTurns: 2,
    tools: [{ name: "Touch", definition: { name: "Touch", input_schema: { type: "object" } }, parse: () => ({ ok: true, data: {} }), policy: async () => ({ level: 2, decision: "allow", reason: "test" }), run: async () => { executed++; return "done"; } }],
  }), /after 3 incomplete-stream retries/);
  assert.equal(calls, 5);
  assert.equal(executed, 1);
  assert.equal(messages.length, 3);
  assert.equal(messages[1]?.role, "assistant");
  assert.equal(messages[2]?.role, "user");
});
