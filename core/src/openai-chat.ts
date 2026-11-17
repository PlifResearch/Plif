import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { Stream } from "openai/core/streaming";
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { ModelClient, ModelProgress, ModelRequestOptions } from "./model.js";
import { ApiFailure, incompleteStream, retryApiCall, type RetryRuntime } from "./api-retry.js";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export type MaxTokensField = "max_completion_tokens" | "max_tokens";

// What a model accepts, from model.json. Unset fields follow the server: see defaultsFor().
export interface OpenAiModelTraits {
  readonly maxTokensField?: MaxTokensField;
  readonly reasoningEffort?: boolean;
}

export interface ChatOptions {
  readonly maxTokensField: MaxTokensField;
  readonly reasoningEffort: boolean;
  readonly strictTools: boolean;
  // reasoning_content is an extension of some servers (vLLM, DeepSeek). The official API does not take it back.
  readonly reasoningHistory: boolean;
  readonly promptCacheKey?: string;
}

const REQUEST_DEFAULTS: ChatOptions = {
  maxTokensField: "max_completion_tokens",
  reasoningEffort: false,
  strictTools: true,
  reasoningHistory: true,
};

export function isOfficialOpenAi(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) return true;
  try {
    return new URL(baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

// The message order is the same on every request (system, then tools, then history), so the provider's
// automatic prefix cache can reuse everything up to the newest message.
export function toChatRequest(
  params: Anthropic.MessageCreateParamsNonStreaming,
  overrides: Partial<ChatOptions> = {},
): ChatCompletionCreateParamsNonStreaming {
  const options = { ...REQUEST_DEFAULTS, ...overrides };
  const messages: ChatCompletionMessageParam[] = [];
  const system = systemText(params.system);
  if (system !== "") messages.push({ role: "system", content: system });

  for (const message of params.messages) {
    const blocks = blocksOf(message.content);
    if (message.role === "user") {
      const toolImages: Anthropic.ContentBlockParam[] = [];
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const images = Array.isArray(block.content) ? block.content.filter((item) => item.type === "image") : [];
        const note = images.length > 0 ? `\n[${images.length} image(s) from this result follow in the next user message]` : "";
        messages.push({ role: "tool", tool_call_id: block.tool_use_id, content: `${toolResultText(block)}${note}` });
        if (images.length > 0) toolImages.push({ type: "text", text: `Images returned by tool call ${block.tool_use_id}:` }, ...images);
      }
      // Chat Completions has no images in tool messages, so an image a tool returned follows them in a user message.
      const content = userContent([...toolImages, ...blocks]);
      if (content !== null) messages.push({ role: "user", content });
      continue;
    }

    const calls: ChatCompletionMessageToolCall[] = [];
    for (const block of blocks) {
      if (block.type === "tool_use") {
        calls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input) } });
      }
    }
    const text = textOf(blocks);
    const reasoning = blocks.flatMap((block) => (block.type === "thinking" ? [block.thinking] : [])).join("\n");
    const assistant: ChatCompletionAssistantMessageParam & { reasoning_content?: string } = {
      role: "assistant",
      content: calls.length > 0 && text === "" ? null : text,
    };
    if (calls.length > 0) assistant.tool_calls = calls;
    if (reasoning !== "" && options.reasoningHistory) assistant.reasoning_content = reasoning;
    messages.push(assistant);
  }

  const tools: ChatCompletionTool[] = [];
  for (const tool of params.tools ?? []) {
    if (!("input_schema" in tool)) continue;
    const strict = tool.strict === true && options.strictTools ? openAiStrictSchema(tool.input_schema) : null;
    tools.push({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: (strict?.schema ?? tool.input_schema) as Record<string, unknown>,
        ...(strict === null ? {} : { strict: true }),
      },
    });
  }

  const request: ChatCompletionCreateParamsNonStreaming = { model: params.model, messages };
  if (options.maxTokensField === "max_tokens") request.max_tokens = params.max_tokens;
  else request.max_completion_tokens = params.max_tokens;
  if (tools.length > 0) request.tools = tools;
  const effort = params.output_config?.effort;
  if (options.reasoningEffort && effort !== undefined && effort !== null) request.reasoning_effort = effort;
  if (options.promptCacheKey !== undefined) request.prompt_cache_key = options.promptCacheKey;
  const format = params.output_config?.format;
  if (format?.type === "json_schema") {
    // Strict output only when the schema already meets the strict rules, since the caller parses the text itself.
    const strict = openAiStrictSchema(format.schema);
    request.response_format = {
      type: "json_schema",
      json_schema: { name: "output", schema: format.schema, strict: strict !== null && !strict.changed },
    };
  }
  return request;
}

export function fromChatResponse(
  completion: ChatCompletion,
  model: string,
  tools: Anthropic.MessageCreateParamsNonStreaming["tools"] = [],
): Anthropic.Message {
  const choice = completion?.choices?.[0];
  if (choice?.message === undefined || choice.finish_reason == null) throw incompleteStream();

  const content: unknown[] = [];
  const reasoning = reasoningOf(choice.message);
  if (reasoning !== "") content.push({ type: "thinking", thinking: reasoning, signature: "" });
  const text = choice.message.content || choice.message.refusal;
  if (text) content.push({ type: "text", text, citations: null });
  const calls = choice.finish_reason === "length" || choice.finish_reason === "content_filter" || choice.message.refusal
    ? []
    : choice.message.tool_calls ?? [];
  const schemas = new Map((tools ?? []).flatMap((tool) => ("input_schema" in tool ? [[tool.name, tool.input_schema] as const] : [])));
  for (const call of calls) {
    if (call.type !== "function") continue;
    if (!call.function?.name) throw incompleteStream();
    const input = dropOptionalNulls(parseArguments(call.function.arguments), schemas.get(call.function.name));
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }

  const cached = completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const prompt = completion.usage?.prompt_tokens ?? 0;
  return {
    id: completion.id,
    type: "message",
    role: "assistant",
    model: completion.model || model,
    content,
    stop_reason: stopReason(choice.finish_reason, calls.length > 0, choice.message.refusal),
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, prompt - cached),
      output_tokens: completion.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cached,
    },
  } as unknown as Anthropic.Message;
}

export interface OpenAiChatOptions {
  readonly client: OpenAI;
  readonly retry?: RetryRuntime;
  readonly traits?: (model: string) => OpenAiModelTraits | undefined;
  // Sent as prompt_cache_key to the official API, which uses it to route requests with the same prefix together.
  readonly promptCacheKey?: string;
}

// Optional request fields a server can refuse. A 400 that names one turns it off for that model and the request
// goes again; the change is remembered, so later requests skip the failed attempt.
interface Adjustments {
  maxTokensField?: MaxTokensField;
  reasoningEffort?: false;
  strictTools?: false;
  reasoningHistory?: false;
  promptCacheKey?: false;
  streamUsage?: false;
}

export function openAiChatModel(options: OpenAiChatOptions): ModelClient {
  const official = isOfficialOpenAi(options.client.baseURL);
  const adjusted = new Map<string, Adjustments>();

  const requestOptions = (model: string): ChatOptions & { streamUsage: boolean } => {
    const traits = options.traits?.(model);
    const fixes = adjusted.get(model) ?? {};
    const key = official && fixes.promptCacheKey !== false ? options.promptCacheKey : undefined;
    return {
      maxTokensField: fixes.maxTokensField ?? traits?.maxTokensField ?? (official ? "max_completion_tokens" : "max_tokens"),
      reasoningEffort: fixes.reasoningEffort ?? traits?.reasoningEffort ?? official,
      strictTools: fixes.strictTools ?? true,
      reasoningHistory: fixes.reasoningHistory ?? !official,
      ...(key === undefined ? {} : { promptCacheKey: key }),
      streamUsage: fixes.streamUsage ?? true,
    };
  };

  const run = async (
    params: Anthropic.MessageCreateParamsNonStreaming,
    send: (request: ChatCompletionCreateParamsNonStreaming, streamUsage: boolean) => Promise<ChatCompletion>,
    controls?: ModelRequestOptions,
  ): Promise<Anthropic.Message> => {
    return retryApiCall(async () => {
      const chosen = requestOptions(params.model);
      const request = toChatRequest(params, chosen);
      try {
        return fromChatResponse(await send(request, chosen.streamUsage), params.model, params.tools);
      } catch (error) {
        if (isContextOverflow(error)) return overflowMessage(params.model);
        if (error instanceof SyntaxError) throw incompleteStream();
        const fix = adjustmentFor(error, request, chosen, adjusted.get(params.model) ?? {});
        if (fix === null) throw error;
        adjusted.set(params.model, { ...adjusted.get(params.model), ...fix });
        throw new ApiFailure("compatibility", "The API rejected an optional parameter; compatible settings were selected.", { cause: error });
      }
    }, controls, options.retry);
  };

  return {
    create: (params, request) =>
      run(params, (body) => options.client.chat.completions.create(body, { signal: request?.signal, maxRetries: 0 }), request),
    stream: (params, request, onProgress) =>
      run(params, async (body, streamUsage) => {
        // asResponse() leaves body consumption to us. The SSE decoder must share cancellation with the request,
        // and the deadline must include the streamed body, not only the time until the headers arrive.
        const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(request?.signal === undefined ? [] : [request.signal])]);
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          const response = await options.client.chat.completions
            .create({ ...body, stream: true, ...(streamUsage ? { stream_options: { include_usage: true } } : {}) }, { signal, maxRetries: 0 })
            .asResponse();
          let completion: ChatCompletion;
          // A server that ignores stream: true answers with the whole completion as JSON.
          if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
            completion = (await response.json()) as ChatCompletion;
          } else {
            const stream = Stream.fromSSEResponse<ChatCompletionChunk>(response, controller, options.client);
            completion = await collectStream(stream, params.model, onProgress);
          }
          signal.throwIfAborted();
          return completion;
        } catch (error) {
          signal.throwIfAborted();
          throw error;
        } finally {
          signal.removeEventListener("abort", abort);
        }
      }, request),
  };
}

export function openAiClient(options: {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}): OpenAI {
  const keyless = options.apiKey === "";
  return new OpenAI({
    apiKey: keyless ? "unused" : options.apiKey,
    baseURL: options.baseUrl ?? OPENAI_BASE_URL,
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
    fetch: options.fetch,
    defaultHeaders: keyless ? { Authorization: null } : undefined,
  });
}

type ReasoningFields = { reasoning_content?: string | null; reasoning?: string | null };

// vLLM and DeepSeek name the reasoning text reasoning_content; OpenRouter and newer vLLM name it reasoning.
function reasoningOf(message: object): string {
  const fields = message as ReasoningFields;
  const value = fields.reasoning_content ?? fields.reasoning;
  return typeof value === "string" ? value : "";
}

interface PendingCall {
  id: string;
  name: string;
  arguments: string;
}

export async function collectStream(
  stream: AsyncIterable<ChatCompletionChunk>,
  model: string,
  onProgress: (progress: ModelProgress) => void,
): Promise<ChatCompletion> {
  let id = "";
  let modelName = "";
  let text = "";
  let refusal = "";
  let reasoning = "";
  let finish: string | null = null;
  let usage: ChatCompletion["usage"];
  let block: "thinking" | "text" | null = null;
  const calls = new Map<number, PendingCall>();
  let lastIndex = -1;

  const enter = (next: "thinking" | "text") => {
    if (block === next) return;
    block = next;
    onProgress({ kind: "block", block: next });
  };

  for await (const chunk of stream) {
    id ||= chunk.id;
    modelName ||= chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices.find((entry) => entry.index === 0) ?? chunk.choices[0];
    if (choice === undefined) continue;
    const delta = choice.delta;
    const thought = reasoningOf(delta);
    if (thought !== "") {
      enter("thinking");
      reasoning += thought;
      onProgress({ kind: "thinking", chars: thought.length });
    }
    if (delta.content) {
      enter("text");
      text += delta.content;
    }
    if (delta.refusal) {
      enter("text");
      refusal += delta.refusal;
    }
    for (const call of delta.tool_calls ?? []) {
      // Some servers leave out the index and send each call whole; a new id then means a new call.
      const known = typeof call.index === "number" ? call.index : call.id !== undefined || lastIndex === -1 ? calls.size : lastIndex;
      let entry = calls.get(known);
      if (entry === undefined) {
        entry = { id: "", name: "", arguments: "" };
        calls.set(known, entry);
        block = null;
        onProgress({ kind: "block", block: "tool_use" });
      }
      lastIndex = known;
      if (call.id) entry.id = call.id;
      if (call.function?.name) entry.name += call.function.name;
      if (call.function?.arguments) entry.arguments += call.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  if (finish === null) throw incompleteStream();

  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => ({
      id: call.id === "" ? `call_${index}` : call.id,
      type: "function" as const,
      function: { name: call.name, arguments: call.arguments },
    }));
  const message: ChatCompletion.Choice["message"] & ReasoningFields = {
    role: "assistant",
    content: text === "" ? null : text,
    refusal: refusal === "" ? null : refusal,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(reasoning === "" ? {} : { reasoning_content: reasoning }),
  };
  return {
    id: id || "stream",
    object: "chat.completion",
    created: 0,
    model: modelName || model,
    choices: [{ index: 0, finish_reason: finish as ChatCompletion.Choice["finish_reason"], logprobs: null, message }],
    ...(usage === undefined ? {} : { usage }),
  };
}

function isContextOverflow(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError)) return false;
  if (error.code === "context_length_exceeded") return true;
  // vLLM, llama.cpp and others answer 400 with only a message.
  return (error.status === 400 || error.status === 413) && /context[ _]length|context window|maximum context|prompt is too long/i.test(error.message);
}

const REFUSED_FIELD = /unsupported|not supported|unrecognized|unknown|extra|not allowed|not permitted/i;

function adjustmentFor(
  error: unknown,
  request: ChatCompletionCreateParamsNonStreaming,
  chosen: ChatOptions & { streamUsage: boolean },
  done: Adjustments,
): Adjustments | null {
  if (!(error instanceof OpenAI.APIError) || (error.status !== 400 && error.status !== 422)) return null;
  const said = `${error.param ?? ""} ${error.code ?? ""} ${error.message}`;
  const strictTools = request.tools?.some((tool) => tool.type === "function" && tool.function.strict === true) === true;
  if (strictTools && (error.code === "invalid_function_parameters" || (error.param ?? "").startsWith("tools") || /\bstrict\b/i.test(error.message))) {
    return { strictTools: false };
  }
  if (!REFUSED_FIELD.test(said)) return null;
  // One swap only: a server that refuses both fields has another problem.
  if (said.includes(chosen.maxTokensField) && done.maxTokensField === undefined) {
    return { maxTokensField: chosen.maxTokensField === "max_tokens" ? "max_completion_tokens" : "max_tokens" };
  }
  if (chosen.reasoningEffort && said.includes("reasoning_effort")) return { reasoningEffort: false };
  if (chosen.promptCacheKey !== undefined && said.includes("prompt_cache_key")) return { promptCacheKey: false };
  if (chosen.streamUsage && said.includes("stream_options")) return { streamUsage: false };
  if (chosen.reasoningHistory && said.includes("reasoning_content")) return { reasoningHistory: false };
  return null;
}

// OpenAI strict mode wants every property in `required` and `additionalProperties: false` on every object.
// Optional fields become nullable instead, and dropOptionalNulls() takes the null out before the tool sees it.
// Null means the schema cannot be strict (records, oneOf), and the tool goes without strict.
export function openAiStrictSchema(schema: unknown): { schema: Record<string, unknown>; changed: boolean } | null {
  let changed = false;
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (node === null || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    if ("oneOf" in record || "allOf" in record || "not" in record || "patternProperties" in record || "propertyNames" in record) {
      throw new Error("not strict");
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === "default") {
        changed = true;
        continue;
      }
      result[key] = key === "properties" ? value : visit(value);
    }
    const isObject = record["type"] === "object" || "properties" in record;
    if (!isObject) return result;
    if (record["additionalProperties"] !== undefined && record["additionalProperties"] !== false) throw new Error("not strict");
    const properties = (record["properties"] ?? {}) as Record<string, unknown>;
    const required = new Set(Array.isArray(record["required"]) ? (record["required"] as string[]) : []);
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      const converted = visit(value);
      if (required.has(key)) next[key] = converted;
      else {
        changed = true;
        next[key] = nullable(converted);
      }
    }
    if (record["additionalProperties"] !== false) changed = true;
    result["properties"] = next;
    result["required"] = Object.keys(properties);
    result["additionalProperties"] = false;
    return result;
  };
  try {
    const converted = visit(schema);
    if (converted === null || typeof converted !== "object" || Array.isArray(converted)) return null;
    return { schema: converted as Record<string, unknown>, changed };
  } catch {
    return null;
  }
}

function nullable(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  const record = node as Record<string, unknown>;
  if (typeof record["type"] === "string" && !("enum" in record)) return { ...record, type: [record["type"], "null"] };
  return { anyOf: [record, { type: "null" }] };
}

function dropOptionalNulls(value: unknown, schema: unknown): Record<string, unknown> {
  const clean = (node: unknown, shape: unknown): unknown => {
    if (shape === null || typeof shape !== "object") return node;
    const record = shape as Record<string, unknown>;
    if (Array.isArray(node)) return node.map((item) => clean(item, record["items"]));
    if (node === null || typeof node !== "object") return node;
    const properties = (record["properties"] ?? {}) as Record<string, unknown>;
    const required = new Set(Array.isArray(record["required"]) ? (record["required"] as string[]) : []);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if (item === null && !required.has(key)) continue;
      result[key] = clean(item, properties[key]);
    }
    return result;
  };
  return clean(value, schema) as Record<string, unknown>;
}

function systemText(system: Anthropic.MessageCreateParamsNonStreaming["system"]): string {
  if (system === undefined) return "";
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n\n");
}

function blocksOf(content: Anthropic.MessageParam["content"]): Anthropic.ContentBlockParam[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function textOf(blocks: readonly Anthropic.ContentBlockParam[]): string {
  return blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

// Images travel as image_url parts with a data URL, in the same order as the text around them.
function userContent(blocks: readonly Anthropic.ContentBlockParam[]): string | ChatCompletionContentPart[] | null {
  if (!blocks.some((block) => block.type === "image")) {
    const text = textOf(blocks);
    return text === "" ? null : text;
  }
  const parts: ChatCompletionContentPart[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text !== "") parts.push({ type: "text", text: block.text });
    if (block.type !== "image") continue;
    if (block.source.type === "base64") {
      parts.push({ type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } });
    } else if (block.source.type === "url") {
      parts.push({ type: "image_url", image_url: { url: block.source.url } });
    }
  }
  return parts;
}

function toolResultText(block: Anthropic.ToolResultBlockParam): string {
  const text =
    typeof block.content === "string"
      ? block.content
      : (block.content ?? []).flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
  return block.is_error ? `error: ${text}` : text;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw === "" ? "{}" : raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw incompleteStream();
    return value as Record<string, unknown>;
  } catch {
    throw incompleteStream();
  }
}

function stopReason(finish: string | null, hasCalls: boolean, refusal: string | null | undefined): string {
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter" || refusal) return "refusal";
  if (hasCalls || finish === "tool_calls" || finish === "function_call") return "tool_use";
  return "end_turn";
}

function overflowMessage(model: string): Anthropic.Message {
  return {
    id: "overflow",
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: "model_context_window_exceeded",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}
