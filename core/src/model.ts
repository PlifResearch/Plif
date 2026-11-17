import Anthropic from "@anthropic-ai/sdk";
import { type Catalog, findModel } from "./catalog.js";
import type { Config } from "./config.js";
import { OPENAI_BASE_URL, openAiChatModel, openAiClient } from "./openai-chat.js";
import { incompleteStream, retryApiCall, type RetryOptions, type RetryRuntime } from "./api-retry.js";

export type ModelRequestOptions = RetryOptions;

// What the model is writing right now, taken from the stream. Nothing here is estimated from elapsed time.
export type ModelProgress =
  | { readonly kind: "block"; readonly block: "thinking" | "text" | "tool_use" }
  | { readonly kind: "thinking"; readonly chars: number };

export interface ModelClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming, options?: ModelRequestOptions): Promise<Anthropic.Message>;
  // Optional: clients without streaming report no progress, and the caller falls back to create().
  stream?(
    params: Anthropic.MessageCreateParamsNonStreaming,
    options: ModelRequestOptions | undefined,
    onProgress: (progress: ModelProgress) => void,
  ): Promise<Anthropic.Message>;
}

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export function anthropicModel(
  client: Anthropic = new Anthropic({ maxRetries: 0, timeout: REQUEST_TIMEOUT_MS }),
  retryRuntime: RetryRuntime = {},
): ModelClient {
  return {
    create: (params, options) => retryApiCall(() => client.messages.create(params, { signal: options?.signal, maxRetries: 0 }), options, retryRuntime),
    stream: (params, options, onProgress) => retryApiCall(async () => {
      const stream = client.messages.stream(params, { signal: options?.signal, maxRetries: 0 });
      let stopped = false;
      stream.on("streamEvent", (event) => {
        if (event.type === "message_stop") stopped = true;
        if (event.type === "content_block_start") {
          const block = blockKind(event.content_block.type);
          if (block !== null) onProgress({ kind: "block", block });
        } else if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
          onProgress({ kind: "thinking", chars: event.delta.thinking.length });
        }
      });
      const response = await stream.finalMessage();
      if (!stopped) throw incompleteStream();
      return response;
    }, options, retryRuntime),
  };
}

function blockKind(type: string): "thinking" | "text" | "tool_use" | null {
  if (type === "thinking" || type === "redacted_thinking") return "thinking";
  if (type === "text") return "text";
  if (type === "tool_use" || type === "server_tool_use") return "tool_use";
  return null;
}

export interface ProviderOptions {
  // model.json says which models take reasoning_effort and which max tokens field they want.
  readonly catalog?: Catalog;
  readonly promptCacheKey?: string;
}

// The key in config.toml wins over the environment variable. The keychain has already filled the variable by now.
export function providerKey(provider: Config["provider"], env: NodeJS.ProcessEnv): string {
  const name = provider.api_key_env ?? (provider.kind === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");
  return provider.api_key ?? env[name] ?? "";
}

export function modelFromProvider(provider: Config["provider"], env: NodeJS.ProcessEnv, options: ProviderOptions = {}): ModelClient {
  const apiKey = providerKey(provider, env);
  if (provider.kind === "anthropic") {
    return anthropicModel(
      new Anthropic({
        apiKey: apiKey === "" ? undefined : apiKey,
        baseURL: provider.base_url,
        maxRetries: 0,
        timeout: REQUEST_TIMEOUT_MS,
      }),
    );
  }

  const catalog = options.catalog;
  return openAiChatModel({
    client: openAiClient({ apiKey, baseUrl: provider.base_url ?? OPENAI_BASE_URL }),
    traits: catalog === undefined ? undefined : (id) => findModel(catalog, id),
    ...(options.promptCacheKey === undefined ? {} : { promptCacheKey: options.promptCacheKey }),
  });
}

// Which model does each internal job. Empty fields in [models] keep the catalog choice.
export interface ModelRoles {
  readonly classifier: string;
  readonly compaction: string;
  readonly sessionSummary: string;
  // Unset: the subagent rules in subagents.ts decide.
  readonly subagent?: string;
  readonly explore?: string;
}

export function modelRoles(config: Config, catalog: Catalog): ModelRoles {
  const models = config.models;
  return {
    classifier: models.classifier ?? catalog.classifier,
    compaction: models.compaction ?? catalog.classifier,
    sessionSummary: models.session_summary ?? catalog.classifier,
    ...(models.subagent === undefined ? {} : { subagent: models.subagent }),
    ...(models.explore === undefined ? {} : { explore: models.explore }),
  };
}
