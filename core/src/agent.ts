import type Anthropic from "@anthropic-ai/sdk";
import { clearOldToolResults, compactHistory, estimateMessagesTokens, type Summarize } from "./context.js";
import type { ClassifierInput } from "./classifier.js";
import type { ClassifierGate } from "./gate.js";
import { type HookBase, type HookEvent, type HookOutcome, type HookRunner, permissionModeName } from "./hooks.js";
import type { ModelClient, ModelProgress, ModelRequestOptions } from "./model.js";
import { apiFailure, type ApiFailureKind, retryNotice } from "./api-retry.js";
import { type RegisteredTool, outputText } from "./tools/registry.js";
import type { ToolContext, Verdict } from "./types.js";

export const MODEL_ID = "claude-opus-5-5";
export const EFFORT = "medium";
const MAX_TOKENS = 16_000;
const PREVIEW_CHARS = 500;
const HISTORY_ITEMS = 10;
const KEEP_TOOL_RESULTS = 3;
const CLEAR_BATCH_CHARS = 20_000;
const KEEP_RECENT_MESSAGES = 8;
const KEEP_RECENT_AFTER_OVERFLOW = 4;
const MAX_OVERFLOW_RETRIES = 2;
const REPEAT_LIMIT = 3;
// Same cap as Claude Code: after this many Stop hook continuations in a row, the next block is overridden.
export const STOP_HOOK_CAP = 8;

export interface AgentEvents {
  onMessage?(message: Anthropic.MessageParam): void;
  onText?(text: string): void;
  onNotice?(text: string): void;
  onToolStart?(use: { readonly id: string; readonly name: string; readonly input: unknown }): void;
  onToolEnd?(use: { readonly id: string; readonly name: string; readonly ok: boolean; readonly output: string }): void;
  onUsage?(usage: Anthropic.Usage): void;
  onProgress?(progress: ModelProgress): void;
}

export interface AgentOptions {
  readonly model: ModelClient;
  readonly system: string;
  readonly tools: readonly RegisteredTool[];
  readonly messages: Anthropic.MessageParam[];
  readonly ctx: ToolContext;
  readonly maxTurns: number;
  readonly gate?: ClassifierGate;
  readonly projectPolicy?: string;
  readonly events?: AgentEvents;
  readonly modelId?: string;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly compactAt?: number;
  readonly summarize?: Summarize;
  readonly maxTotalTokens?: number;
  readonly signal?: AbortSignal;
  readonly hooks?: HookRunner;
  // What the hooks are told about this run. A subagent sets agentId and agentType, which turns Stop into SubagentStop.
  readonly hookInfo?: { readonly transcriptPath?: string; readonly agentId?: string; readonly agentType?: string };
  // Notices from background tasks that finished since the last request. They join the newest user message.
  readonly drainNotices?: () => readonly string[];
}

export async function runAgent(options: AgentOptions): Promise<string> {
  const byName = new Map(options.tools.map((tool) => [tool.name, tool] as const));
  const definitions = options.tools.map((tool) => tool.definition);
  const push = (message: Anthropic.MessageParam) => {
    options.messages.push(message);
    options.events?.onMessage?.(message);
  };
  const recentCalls: string[] = [];
  let spent = 0;
  let overflowRetries = 0;
  let stopContinuations = 0;
  const state: RunState = { halt: null };

  for (let turn = 0; turn < options.maxTurns; turn++) {
    throwIfAborted(options.signal);
    if (options.compactAt !== undefined && estimateMessagesTokens(options.messages) > options.compactAt) {
      await compact(options, KEEP_RECENT_MESSAGES);
    }
    clearOldToolResults(options.messages, KEEP_TOOL_RESULTS, CLEAR_BATCH_CHARS);
    const notices = options.drainNotices?.() ?? [];
    if (notices.length > 0) addUserText(options.messages, notices);

    const response = await sendOrReport(options, {
      model: options.modelId ?? MODEL_ID,
      max_tokens: MAX_TOKENS,
      system: options.system,
      cache_control: { type: "ephemeral" },
      tools: definitions,
      messages: options.messages,
      // "summarized" streams the reasoning summary, so the screen can follow the thinking. The billed tokens are the same.
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: options.effort ?? EFFORT },
    });
    options.events?.onUsage?.(response.usage);
    spent += weightedTokens(response.usage);
    if (options.maxTotalTokens !== undefined && spent > options.maxTotalTokens) {
      throw new Error(`token budget exceeded: ${spent} of ${options.maxTotalTokens} tokens used`);
    }

    if (response.stop_reason === "model_context_window_exceeded") {
      if (options.summarize === undefined || overflowRetries >= MAX_OVERFLOW_RETRIES) {
        throw new Error("the context window is full and the history cannot be compacted further");
      }
      overflowRetries++;
      if (!(await compact(options, KEEP_RECENT_AFTER_OVERFLOW))) {
        throw new Error("the context window is full and a PreCompact hook blocked the compaction");
      }
      turn--;
      continue;
    }
    overflowRetries = 0;

    push({ role: "assistant", content: response.content });
    const modelReason = textOf(response.content);
    if (modelReason !== "") options.events?.onText?.(modelReason);
    const uses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
    if (uses.length === 0) {
      const final = response.stop_reason === "max_tokens" ? `${modelReason}\n[response truncated: the max_tokens limit was reached]` : modelReason;
      const subagent = options.hookInfo?.agentType !== undefined;
      const event: HookEvent = subagent ? "SubagentStop" : "Stop";
      if (options.hooks?.has(event) !== true) return final;
      const outcome = await fireHook(options, event, options.hookInfo?.agentType ?? "", {
        stop_hook_active: stopContinuations > 0,
        last_assistant_message: modelReason,
      });
      if (outcome.stop !== null) return final;
      const feedback = [...(outcome.block === null ? [] : [outcome.block]), ...outcome.context];
      if (feedback.length === 0) return final;
      if (stopContinuations >= STOP_HOOK_CAP) {
        options.events?.onNotice?.(`${event} hook asked to continue ${STOP_HOOK_CAP} times in a row; the turn ends here`);
        return final;
      }
      stopContinuations++;
      push({ role: "user", content: [{ type: "text", text: `<hook_feedback event="${event}">\n${feedback.join("\n\n")}\n</hook_feedback>` }] });
      continue;
    }
    stopContinuations = 0;

    const blocked = blockReason(response.stop_reason);
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) {
      options.events?.onToolStart?.({ id: use.id, name: use.name, input: use.input });
      const signature = `${use.name}:${JSON.stringify(use.input)}`;
      let result: Anthropic.ToolResultBlockParam;
      if (isRepeating(recentCalls, signature)) {
        result = errorResult(
          use.id,
          `this exact call has run ${REPEAT_LIMIT} times in a row. Change the input or the approach, or explain the blocker to the user.`,
        );
      } else {
        recentCalls.push(signature);
        if (recentCalls.length > REPEAT_LIMIT * 2) recentCalls.shift();
        result =
          blocked !== null
            ? errorResult(use.id, blocked)
            : state.halt !== null
              ? errorResult(use.id, `not run: the turn was stopped by a hook (${state.halt})`)
              : await runUse(use, byName, options, modelReason, state);
      }
      options.events?.onToolEnd?.({ id: use.id, name: use.name, ok: result.is_error !== true, output: typeof result.content === "string" ? result.content : outputText((result.content ?? []) as Parameters<typeof outputText>[0]) });
      results.push(result);
    }
    push({ role: "user", content: results });
    if (state.halt !== null) {
      options.events?.onNotice?.(`stopped by a hook: ${state.halt}`);
      return "";
    }
  }
  throw new Error(`turn limit of ${options.maxTurns} reached without a final answer`);
}

// Adds text to the newest user message, or starts a user message when the history ends with the assistant.
function addUserText(messages: Anthropic.MessageParam[], texts: readonly string[]): void {
  const blocks: Anthropic.TextBlockParam[] = texts.map((text) => ({ type: "text", text }));
  const last = messages.at(-1);
  if (last?.role === "user") {
    last.content = typeof last.content === "string" ? [{ type: "text", text: last.content }, ...blocks] : [...last.content, ...blocks];
  } else {
    messages.push({ role: "user", content: blocks });
  }
}

// Streams when the client can, so progress comes from the API events. Other clients get a plain request.
function send(options: AgentOptions, params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
  const requestOptions = apiOptions(options);
  if (options.model.stream === undefined) return options.model.create(params, requestOptions);
  return options.model.stream(params, requestOptions, (progress) => options.events?.onProgress?.(progress));
}

function apiOptions(options: AgentOptions): ModelRequestOptions {
  return { signal: options.signal, onRetry: (event) => options.events?.onNotice?.(retryNotice(event)) };
}

// Returns false when a PreCompact hook blocked the compaction.
async function compact(options: AgentOptions, keepRecent: number): Promise<boolean> {
  if (options.summarize === undefined) return true;
  const summarize = options.summarize;
  const before = await fireHook(options, "PreCompact", "auto", { trigger: "auto", custom_instructions: null });
  if (before.block !== null) {
    options.events?.onNotice?.(`compaction blocked by a hook: ${before.block}`);
    return false;
  }
  const instructions = before.instructions.length > 0 ? before.instructions.join("\n\n") : undefined;
  let summary = "";
  const next = await compactHistory(
    options.messages,
    async (messages) => (summary = await summarize(messages, apiOptions(options), instructions)),
    keepRecent,
  );
  throwIfAborted(options.signal);
  if (next === null) return true;
  options.messages.splice(0, options.messages.length, ...next);
  options.events?.onNotice?.("history compacted to stay inside the context window");
  await fireHook(options, "PostCompact", "auto", { trigger: "auto", compact_summary: summary });
  // As in Claude Code, SessionStart runs again after a compaction so its context comes back.
  if (options.hookInfo?.agentType === undefined) {
    const restart = await fireHook(options, "SessionStart", "compact", { source: "compact" });
    if (restart.context.length > 0) addUserText(options.messages, [hookContext("SessionStart", restart.context)]);
  }
  return true;
}

interface RunState {
  // Set when a hook answered continue: false. The remaining tool calls of the round do not run.
  halt: string | null;
}

export function hookBaseOf(options: AgentOptions): HookBase {
  return {
    session: options.ctx.session,
    cwd: options.ctx.root,
    transcriptPath: options.hookInfo?.transcriptPath,
    permissionMode: permissionModeName(options.ctx.mode),
    agentId: options.hookInfo?.agentId,
    agentType: options.hookInfo?.agentType,
  };
}

const NO_HOOKS: HookOutcome = { ran: 0, block: null, context: [], messages: [], stop: null, permission: null, refusal: null, approved: false, allowIgnored: false, instructions: [] };

// Runs one event and shows its messages for the user. Without hooks for the event, it costs nothing.
async function fireHook(options: AgentOptions, event: HookEvent, match: string, fields: Record<string, unknown>): Promise<HookOutcome> {
  if (options.hooks === undefined || !options.hooks.has(event)) return NO_HOOKS;
  const outcome = await options.hooks.fire(event, match, hookBaseOf(options), fields);
  for (const message of outcome.messages) options.events?.onNotice?.(message);
  return outcome;
}

export function hookContext(event: string, texts: readonly string[]): string {
  return `<hook_context event="${event}">\n${texts.join("\n\n")}\n</hook_context>`;
}

// API errors end the turn. StopFailure hooks hear about them, for logs and alerts; they cannot change the outcome.
async function sendOrReport(options: AgentOptions, params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
  try {
    return await send(options, params);
  } catch (error) {
    const failure = apiFailure(error);
    if (failure !== null && failure.kind !== "cancelled" && options.hooks?.has("StopFailure") === true) {
      const kind = STOP_FAILURE[failure.kind];
      await fireHook(options, "StopFailure", kind, { error: kind, error_details: failure.message, last_assistant_message: `API Error: ${failure.message}` });
    }
    throw error;
  }
}

const STOP_FAILURE: Record<ApiFailureKind, string> = {
  rate_limit: "rate_limit",
  usage_limit: "billing_error",
  authentication: "authentication_failed",
  permission: "authentication_failed",
  not_found: "model_not_found",
  invalid_request: "invalid_request",
  server: "server_error",
  connection: "server_error",
  timeout: "server_error",
  incomplete_stream: "server_error",
  compatibility: "invalid_request",
  cancelled: "unknown",
};

function isRepeating(recent: readonly string[], signature: string): boolean {
  if (recent.length < REPEAT_LIMIT - 1) return false;
  return recent.slice(-(REPEAT_LIMIT - 1)).every((entry) => entry === signature);
}

// Cache writes cost 1.25x and cache reads 0.1x the base input price.
function weightedTokens(usage: Anthropic.Usage): number {
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return Math.round(usage.input_tokens + usage.output_tokens + cacheWrite * 1.25 + cacheRead * 0.1);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error("the turn was interrupted");
}

function blockReason(stopReason: Anthropic.Message["stop_reason"]): string | null {
  if (stopReason === "max_tokens") return "response cut at the max_tokens limit; no tool was executed";
  if (stopReason === "refusal") return "the model refused the response; no tool was executed";
  return null;
}

async function runUse(
  use: Anthropic.ToolUseBlock,
  tools: ReadonlyMap<string, RegisteredTool>,
  options: AgentOptions,
  modelReason: string,
  state: RunState,
): Promise<Anthropic.ToolResultBlockParam> {
  const { ctx } = options;
  const tool = tools.get(use.name);
  if (tool === undefined) return errorResult(use.id, `unknown tool: ${use.name}`);

  let parsed = tool.parse(use.input);
  if (!parsed.ok) return errorResult(use.id, `invalid input: ${parsed.message}`);

  const pre = await fireHook(options, "PreToolUse", use.name, { tool_name: use.name, tool_input: parsed.data, tool_use_id: use.id });
  if (pre.stop !== null) state.halt = pre.stop;
  let input: unknown = use.input;
  if (pre.updatedInput !== undefined) {
    // A rewritten input is validated and judged by the policy again, as if the model had sent it.
    const reparsed = tool.parse(pre.updatedInput);
    if (!reparsed.ok) return errorResult(use.id, `a PreToolUse hook rewrote the input into an invalid one: ${reparsed.message}`);
    parsed = reparsed;
    input = pre.updatedInput;
  }
  const verdict = applyHookDecision(await tool.policy(parsed.data, ctx), pre);
  const preContext = pre.context;
  const base = {
    session: ctx.session,
    tool: use.name,
    level: verdict.level,
    decision: verdict.decision,
    reason: verdict.reason,
    input: preview(input),
  };

  if (verdict.decision === "deny") {
    await ctx.log.record({ ...base, outcome: "blocked" });
    return withContext(errorResult(use.id, `blocked (level ${verdict.level}): ${verdict.reason}`), "PreToolUse", preContext);
  }

  let approvedBy = "policy";
  // An "allow" from a hook in ~/.plif/settings.json approves an action the policy would ask about, as in Claude Code.
  // It never reaches a denied action (level 0, protected paths, read-only mode).
  const hookApproved = verdict.decision === "ask_user" && pre.permission?.decision === "allow" && pre.permission.fromUser;
  if (hookApproved) approvedBy = "hook";
  if (verdict.decision === "ask_user" && !hookApproved) {
    const pending = { ...use, input } as Anthropic.ToolUseBlock;
    const review =
      options.gate === undefined || ctx.mode.approval === "ask"
        ? null
        : await options.gate.review(classifierInput(pending, options, modelReason), apiOptions(options));
    if (review?.decision === "deny") {
      await ctx.log.record({ ...base, classifier: review, outcome: "refused by classifier" });
      return errorResult(use.id, `blocked by the classifier: ${review.reason}`);
    }

    const summary = summaryOf(input);
    const signature = `${use.name} ${summary}`;
    if (review?.decision === "allow") {
      approvedBy = "classifier";
    } else if (ctx.mode.approval === "never") {
      await ctx.log.record({ ...base, classifier: review, outcome: "blocked in no-prompt mode" });
      return errorResult(use.id, `blocked in no-prompt mode: ${verdict.reason}`);
    } else if (ctx.sessionApprovals?.has(signature) === true) {
      approvedBy = "session";
    } else {
      const request = await fireHook(options, "PermissionRequest", use.name, { tool_name: use.name, tool_input: parsed.data });
      if (request.allowIgnored) options.events?.onNotice?.(`a project PermissionRequest hook answered allow for ${use.name}; only hooks in ~/.plif/settings.json release actions, so you decide`);
      if (request.refusal !== null) {
        if (request.refusal.interrupt) state.halt = request.refusal.message;
        await ctx.log.record({ ...base, classifier: review, outcome: "refused by hook" });
        return errorResult(use.id, `refused by a PermissionRequest hook: ${request.refusal.message}`);
      }
      if (request.approved) {
        approvedBy = "hook";
      } else {
        // Notification hooks are side effects (a sound, a message on the phone). They do not hold the approval.
        void fireHook(options, "Notification", "permission_prompt", {
          message: `Plif needs your permission to use ${use.name}`,
          title: "Permission needed",
          notification_type: "permission_prompt",
        }).catch(() => undefined);
        const reason = review === null ? verdict.reason : `${verdict.reason}. Classifier: ${review.reason}`;
        const answer = await ctx.approver.ask({ tool: use.name, summary, reason });
        if (answer === "deny") {
          await ctx.log.record({ ...base, classifier: review, outcome: "refused by user" });
          return errorResult(use.id, `the user did not approve this action: ${verdict.reason}`);
        }
        if (answer === "session") ctx.sessionApprovals?.add(signature);
        approvedBy = "user";
      }
    }
  }

  const started = Date.now();
  try {
    const content = await tool.run(parsed.data, ctx);
    const post = await fireHook(options, "PostToolUse", use.name, {
      tool_name: use.name,
      tool_input: parsed.data,
      tool_response: { ok: true, output: outputText(content) },
      tool_use_id: use.id,
      duration_ms: Date.now() - started,
    });
    if (post.stop !== null) state.halt = post.stop;
    await ctx.log.record({ ...base, approvedBy, outcome: "executed" });
    return withContext(withContext({ type: "tool_result", tool_use_id: use.id, content }, "PreToolUse", preContext), "PostToolUse", post.context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.log.record({ ...base, approvedBy, outcome: "error", error: message });
    const failure = await fireHook(options, "PostToolUseFailure", use.name, {
      tool_name: use.name,
      tool_input: parsed.data,
      tool_use_id: use.id,
      error: message,
      is_interrupt: options.signal?.aborted === true,
      duration_ms: Date.now() - started,
    });
    if (failure.stop !== null) state.halt = failure.stop;
    return withContext(errorResult(use.id, message), "PostToolUseFailure", failure.context);
  }
}

// Hooks make a decision stricter here. Releasing an action the policy asks about happens later, only for user hooks.
function applyHookDecision(policy: Verdict, outcome: HookOutcome): Verdict {
  if (outcome.stop !== null && policy.decision !== "deny") {
    return { level: policy.level, decision: "deny", reason: `hook stopped the turn: ${outcome.stop}` };
  }
  const answer = outcome.permission;
  if (answer === null) return policy;
  if (answer.decision === "deny") return { level: policy.level, decision: "deny", reason: `hook: ${answer.reason || "blocked by a hook"}` };
  if (answer.decision === "ask" && policy.decision === "allow") {
    return { level: policy.level, decision: "ask_user", reason: `hook asked: ${answer.reason || "review this action"}` };
  }
  return policy;
}

// Hook context reaches the model next to the result it is about.
function withContext(result: Anthropic.ToolResultBlockParam, event: string, texts: readonly string[]): Anthropic.ToolResultBlockParam {
  if (texts.length === 0) return result;
  const note = hookContext(event, texts);
  if (typeof result.content === "string" || result.content === undefined) {
    return { ...result, content: `${result.content ?? ""}\n\n${note}` };
  }
  return { ...result, content: [...result.content, { type: "text", text: note }] } as Anthropic.ToolResultBlockParam;
}

function classifierInput(use: Anthropic.ToolUseBlock, options: AgentOptions, modelReason: string): ClassifierInput {
  return {
    user_messages: userMessages(options.messages),
    recent_actions: recentActions(options.messages, use.id),
    pending_action: { tool: use.name, input: use.input },
    model_reason: modelReason,
    project_policy: options.projectPolicy ?? "",
  };
}

// Only the text the user typed. Tool results and image data stay out of the classifier input.
function userMessages(messages: readonly Anthropic.MessageParam[]): string[] {
  return messages
    .flatMap((message) => {
      if (message.role !== "user") return [];
      if (typeof message.content === "string") return [message.content];
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      return text === "" ? [] : [text];
    })
    .slice(-HISTORY_ITEMS);
}

function recentActions(
  messages: readonly Anthropic.MessageParam[],
  pendingId: string,
): Array<{ tool: string; input: unknown }> {
  const actions: Array<{ tool: string; input: unknown }> = [];
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "tool_use" && block.id !== pendingId) actions.push({ tool: block.name, input: block.input });
    }
  }
  return actions.slice(-HISTORY_ITEMS);
}

function errorResult(id: string, message: string): Anthropic.ToolResultBlockParam {
  return { type: "tool_result", tool_use_id: id, content: message, is_error: true };
}

// The approval box shows the part of the input a person reads first: the command, or the path.
function summaryOf(input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "url", "pattern"]) {
      const value = record[key];
      if (typeof value === "string" && value !== "") return value;
    }
  }
  return preview(input);
}

function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)} [...]` : text;
}

function textOf(content: readonly Anthropic.ContentBlock[]): string {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

