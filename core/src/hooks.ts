import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { killTree, treeSpawnOptions } from "./exec.js";
import { currentHost } from "./platform.js";
import { shellFor } from "./shell.js";

// The events follow Claude Code's names, input fields and output fields, so a hook written for it runs here.
export const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

// Exit code 2 blocks only on these events. On the others it is an error the user sees.
const BLOCKING: ReadonlySet<HookEvent> = new Set(["UserPromptSubmit", "PreToolUse", "Stop", "SubagentStop", "PreCompact"]);
// Plain stdout becomes context for the model only on these events.
const PLAIN_CONTEXT: ReadonlySet<HookEvent> = new Set(["SessionStart", "UserPromptSubmit"]);
const CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStart",
  "SubagentStop",
]);

const DEFAULT_TIMEOUT_SECONDS = 30;
const SESSION_END_TIMEOUT_SECONDS = 1.5;
const MAX_CAPTURE_CHARS = 64_000;
// Same cap as Claude Code for additionalContext, systemMessage and plain stdout.
export const MAX_HOOK_TEXT_CHARS = 10_000;

// Other handler types (http, prompt, agent, mcp_tool) and extra fields are read and skipped, so a settings
// file written for Claude Code loads. Only command hooks run.
const HANDLER = z.looseObject({
  type: z.string(),
  command: z.string().optional(),
  // Seconds, as in Claude Code.
  timeout: z.number().positive().optional(),
  if: z.string().optional(),
});
const GROUP = z.object({ matcher: z.string().optional(), hooks: z.array(HANDLER) });
const SETTINGS = z.looseObject({
  hooks: z.record(z.string(), z.array(GROUP)).default({}),
});

export type Settings = z.infer<typeof SETTINGS>;

// "user": ~/.plif/settings.json. "project": .plif/settings.json of a trusted folder. Only user hooks can release an action.
export type HookSource = "user" | "project";

export interface LoadedSettings {
  readonly settings: Settings;
  readonly warnings: readonly string[];
  readonly source: HookSource;
}

export async function loadSettings(file: string, source: HookSource = "user"): Promise<LoadedSettings> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: { hooks: {} }, warnings: [], source };
    throw error;
  }
  const settings = SETTINGS.parse(JSON.parse(text));
  const warnings: string[] = [];
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      warnings.push(`${file}: hook event ${event} is not supported by Plif and was skipped`);
      continue;
    }
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (hook.type !== "command" || hook.command === undefined || hook.command === "") {
          warnings.push(`${file}: ${event} hook of type ${hook.type} was skipped; Plif runs only command hooks`);
        } else if (hook.if !== undefined) {
          warnings.push(`${file}: the "if" filter of a ${event} hook is not supported; the hook runs for every match of its matcher`);
        }
      }
    }
  }
  return { settings, warnings, source };
}

export interface HookListing {
  readonly event: string;
  readonly matcher: string;
  readonly command: string;
}

// Fields every hook receives, besides hook_event_name.
export interface HookBase {
  readonly session: string;
  readonly cwd: string;
  readonly transcriptPath?: string;
  readonly permissionMode?: string;
  readonly agentId?: string;
  readonly agentType?: string;
}

export type PermissionDecision = "allow" | "deny" | "ask";

export interface HookOutcome {
  // How many hooks ran.
  readonly ran: number;
  // Why the action is blocked (exit 2, or decision "block"), on the events that can block.
  readonly block: string | null;
  // Text for the model: additionalContext, plain stdout on SessionStart and UserPromptSubmit, PostToolUse feedback.
  readonly context: readonly string[];
  // Text for the user: systemMessage and errors of hooks that failed without blocking.
  readonly messages: readonly string[];
  // continue: false. The turn stops with this reason.
  readonly stop: string | null;
  // PreToolUse: the strictest permission answer. fromUser: an "allow" came from a user hook, so it may release the action.
  readonly permission: { readonly decision: PermissionDecision; readonly reason: string; readonly fromUser: boolean } | null;
  // PreToolUse: the last updatedInput.
  readonly updatedInput?: Record<string, unknown>;
  // PermissionRequest: a hook refused, with the message for the model and whether the turn stops.
  readonly refusal: { readonly message: string; readonly interrupt: boolean } | null;
  // PermissionRequest: a user hook answered "allow" and approves the action.
  readonly approved: boolean;
  // PermissionRequest: a project hook answered "allow". Project hooks cannot release actions, so it is only reported.
  readonly allowIgnored: boolean;
  // PreCompact: plain stdout, used as extra instructions for the summary.
  readonly instructions: readonly string[];
}

export interface HookRunner {
  readonly list: readonly HookListing[];
  readonly count: number;
  readonly warnings: readonly string[];
  has(event: HookEvent): boolean;
  fire(event: HookEvent, match: string, base: HookBase, fields: Record<string, unknown>): Promise<HookOutcome>;
}

interface Handler {
  readonly source: HookSource;
  readonly event: HookEvent;
  readonly matcher: string | undefined;
  readonly command: string;
  readonly timeoutSeconds: number | undefined;
}

const RANK: Record<PermissionDecision, number> = { allow: 0, ask: 1, deny: 2 };

export function createHookRunner(loaded: readonly (LoadedSettings | Settings)[]): HookRunner {
  const items: LoadedSettings[] = loaded.map((item) => (isLoaded(item) ? item : { settings: item, warnings: [], source: "user" }));
  const handlers: Handler[] = [];
  for (const { settings, source } of items) {
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!(HOOK_EVENTS as readonly string[]).includes(event)) continue;
      for (const group of groups) {
        for (const hook of group.hooks) {
          if (hook.type !== "command" || hook.command === undefined || hook.command === "") continue;
          handlers.push({ source, event: event as HookEvent, matcher: group.matcher, command: hook.command, timeoutSeconds: hook.timeout });
        }
      }
    }
  }
  return {
    count: handlers.length,
    list: handlers.map((handler) => ({ event: handler.event, matcher: handler.matcher ?? "*", command: handler.command })),
    warnings: items.flatMap((item) => item.warnings),
    has: (event) => handlers.some((handler) => handler.event === event),
    fire: (event, match, base, fields) => fire(handlers, event, match, base, fields),
  };
}

function isLoaded(item: LoadedSettings | Settings): item is LoadedSettings {
  return "settings" in item && "warnings" in item && Array.isArray(item["warnings"]);
}

const EMPTY: HookOutcome = { ran: 0, block: null, context: [], messages: [], stop: null, permission: null, refusal: null, approved: false, allowIgnored: false, instructions: [] };

async function fire(handlers: readonly Handler[], event: HookEvent, match: string, base: HookBase, fields: Record<string, unknown>): Promise<HookOutcome> {
  const chosen = handlers.filter((handler) => handler.event === event && matches(handler.matcher, match, event));
  if (chosen.length === 0) return EMPTY;
  const payload = {
    session_id: base.session,
    ...(base.transcriptPath === undefined ? {} : { transcript_path: base.transcriptPath }),
    cwd: base.cwd,
    ...(base.permissionMode === undefined ? {} : { permission_mode: base.permissionMode }),
    hook_event_name: event,
    ...(base.agentId === undefined ? {} : { agent_id: base.agentId }),
    ...(base.agentType === undefined ? {} : { agent_type: base.agentType }),
    ...fields,
  };

  let block: string | null = null;
  let stop: string | null = null;
  let permission: HookOutcome["permission"] = null;
  let updatedInput: Record<string, unknown> | undefined;
  let refusal: HookOutcome["refusal"] = null;
  let approved = false;
  let allowIgnored = false;
  let userAllow = false;
  const context: string[] = [];
  const messages: string[] = [];
  const instructions: string[] = [];
  const raise = (decision: PermissionDecision, reason: string) => {
    if (permission === null || RANK[decision] > RANK[permission.decision]) permission = { decision, reason, fromUser: false };
  };

  for (const handler of chosen) {
    const fallback = event === "SessionEnd" ? SESSION_END_TIMEOUT_SECONDS : DEFAULT_TIMEOUT_SECONDS;
    const result = await runCommand(handler.command, payload, base.cwd, (handler.timeoutSeconds ?? fallback) * 1000);
    const label = `${event} hook (${handler.command.length > 60 ? `${handler.command.slice(0, 60)}...` : handler.command})`;

    if (result.code === null || result.timedOut) {
      const why = result.timedOut ? "did not answer in time" : "could not start";
      // A PreToolUse hook that fails this way blocks the action (fails closed).
      if (event === "PreToolUse") raise("deny", `the hook ${why}`);
      else messages.push(`${label} ${why}`);
      continue;
    }
    if (result.code === 2) {
      const reason = cap(result.stderr.trim()) || "blocked by a hook";
      if (event === "PreToolUse") raise("deny", reason);
      else if (BLOCKING.has(event)) block ??= reason;
      // PostToolUse and PostToolUseFailure send the stderr to the model, next to the result.
      else if (event === "PostToolUse" || event === "PostToolUseFailure") context.push(reason);
      else messages.push(`${label}: ${reason}`);
      continue;
    }
    if (result.code !== 0) {
      messages.push(`${label} failed with exit ${result.code}${result.stderr.trim() === "" ? "" : `: ${cap(result.stderr.trim()).slice(0, 300)}`}`);
      continue;
    }

    const stdout = result.stdout.trim();
    const json = parseObject(stdout);
    if (json === null) {
      if (stdout === "") continue;
      if (PLAIN_CONTEXT.has(event)) context.push(cap(stdout));
      else if (event === "PreCompact") instructions.push(cap(stdout));
      continue;
    }

    if (json["continue"] === false) stop ??= typeof json["stopReason"] === "string" && json["stopReason"] !== "" ? json["stopReason"] : "stopped by a hook";
    if (typeof json["systemMessage"] === "string" && json["systemMessage"] !== "") messages.push(cap(json["systemMessage"]));
    const specific = isRecord(json["hookSpecificOutput"]) ? json["hookSpecificOutput"] : {};
    const reason = typeof json["reason"] === "string" ? cap(json["reason"]) : "";

    if (event === "PreToolUse") {
      const answer = toPermission(specific["permissionDecision"]) ?? toPermission(json["decision"]);
      const why = typeof specific["permissionDecisionReason"] === "string" ? cap(specific["permissionDecisionReason"]) : reason;
      if (answer !== null) raise(answer, why);
      if (answer === "allow" && handler.source === "user") userAllow = true;
      if (isRecord(specific["updatedInput"])) updatedInput = specific["updatedInput"];
    } else if (event === "PermissionRequest") {
      const decision = isRecord(specific["decision"]) ? specific["decision"] : {};
      if (decision["behavior"] === "deny") {
        refusal ??= {
          message: typeof decision["message"] === "string" && decision["message"] !== "" ? cap(decision["message"]) : "refused by a hook",
          interrupt: decision["interrupt"] === true,
        };
      } else if (decision["behavior"] === "allow") {
        if (handler.source === "user") approved = true;
        else allowIgnored = true;
      }
    } else if (json["decision"] === "block") {
      if (BLOCKING.has(event)) block ??= reason || "blocked by a hook";
      else if (event === "PostToolUse") context.push(reason || "a hook flagged this result");
    }
    const extra = specific["additionalContext"];
    if (typeof extra === "string" && extra !== "" && CONTEXT_EVENTS.has(event)) context.push(cap(extra));
  }

  const final = permission as HookOutcome["permission"];
  const decided = final === null ? null : { ...final, fromUser: final.decision === "allow" && userAllow };
  return { ran: chosen.length, block, context, messages, stop, permission: decided, updatedInput, refusal, approved: refusal === null && approved, allowIgnored, instructions };
}

// Claude Code matcher rules: "*", "" or none match everything; only letters, digits, "_", "-", space, "," and "|"
// is an exact name or a list; anything else is an unanchored JavaScript regular expression.
export function matches(matcher: string | undefined, value: string, event?: HookEvent): boolean {
  if (event === "UserPromptSubmit" || event === "Stop") return true;
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((part) => part.trim())
      .includes(value);
  }
  try {
    return new RegExp(matcher).test(value);
  } catch {
    return false;
  }
}

function toPermission(value: unknown): PermissionDecision | null {
  if (value === "allow" || value === "approve") return "allow";
  if (value === "deny" || value === "block") return "deny";
  if (value === "ask") return "ask";
  return null;
}

function parseObject(text: string): Record<string, unknown> | null {
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cap(text: string): string {
  return text.length > MAX_HOOK_TEXT_CHARS ? `${text.slice(0, MAX_HOOK_TEXT_CHARS)}\n[hook output cut at ${MAX_HOOK_TEXT_CHARS} characters]` : text;
}

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

// Hook commands are written by the user in settings.json. They run through the shell, with the event on stdin.
async function runCommand(command: string, payload: unknown, cwd: string, timeoutMs: number): Promise<CommandResult> {
  const host = currentHost();
  let shell: string;
  try {
    shell = shellFor(host);
  } catch {
    return { code: null, stdout: "", stderr: "could not find the hook shell", timedOut: false };
  }
  return new Promise((resolve) => {
    const child = spawn(shell, ["-c", command], {
      cwd,
      ...treeSpawnOptions(host.platform),
      stdio: ["pipe", "pipe", "pipe"],
      // CLAUDE_PROJECT_DIR too, so scripts written for Claude Code find the project.
      env: { ...process.env, PLIF_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          killTree(child.pid, "SIGKILL", host.platform);
        } catch {
          // The process group has already ended.
        }
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE_CHARS) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE_CHARS) stderr += chunk.toString("utf8");
    });
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: "could not start the hook", timedOut: false });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

// The value Claude Code calls permission_mode, with Plif's own mode names.
export function permissionModeName(mode: { readonly approval: string; readonly readOnly: boolean }): string {
  if (mode.readOnly) return "read_only";
  if (mode.approval === "ask") return "ask";
  if (mode.approval === "never") return "never_ask";
  return "auto";
}
