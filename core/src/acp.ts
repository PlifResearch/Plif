import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type Anthropic from "@anthropic-ai/sdk";
import { hookContext, runAgent } from "./agent.js";
import { ClassifierGate } from "./gate.js";
import { permissionModeName } from "./hooks.js";
import { DecisionLog } from "./log.js";
import { connectMcp, type McpLoad } from "./mcp.js";
import { checkImage, imageBlock } from "./media.js";
import type { ModelClient } from "./model.js";
import { readProjectPolicy } from "./prompts.js";
import { buildRuntime, type Runtime } from "./runtime.js";
import { ensureDirs, sessionRoots, sessionScratch } from "./scratch.js";
import { buildSessionSystem } from "./session-system.js";
import type { SessionMeta } from "./session.js";
import { summarizeInput } from "./subagents.js";
import { outputText } from "./tools/registry.js";
import type { ApprovalAnswer, PermissionMode, ToolContext } from "./types.js";

// Agent Client Protocol (https://agentclientprotocol.com), version 1: JSON-RPC 2.0 over stdio, one message per line.
// An editor (Zed, JetBrains, Neovim...) starts `plif --acp` and drives Plif as its agent.

export const ACP_PROTOCOL_VERSION = 1;
const TOOL_OUTPUT_CHARS = 8_000;

const ERRORS = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603, resourceNotFound: -32002 } as const;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface AcpSession {
  readonly id: string;
  readonly runtime: Runtime;
  meta: SessionMeta;
  readonly messages: Anthropic.MessageParam[];
  readonly extraMcp: McpLoad | null;
  readonly readFiles: Set<string>;
  readonly approvals: Set<string>;
  readonly gate: ClassifierGate;
  readonly log: DecisionLog;
  readonly mode: PermissionMode;
  system: string | null;
  controller: AbortController | null;
  // The tool call running now, so a permission request can point at it.
  currentTool: string | null;
  pendingPermissions: Set<(answer: ApprovalAnswer) => void>;
}

export interface AcpOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly homeRoot: string;
  // Tests inject a scripted model; the editor run uses the configured provider.
  readonly model?: ModelClient;
  readonly log?: (line: string) => void;
}

type Json = Record<string, unknown>;

export async function serveAcp(options: AcpOptions): Promise<void> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const runtimes = new Map<string, Promise<Runtime>>();
  const sessions = new Map<string, AcpSession>();
  const pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  let nextId = 1;

  const write = (message: Json) => {
    options.output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const notify = (method: string, params: Json) => write({ method, params });
  const request = (method: string, params: Json): Promise<Json> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      write({ id, method, params });
    });
  const update = (sessionId: string, value: Json) => notify("session/update", { sessionId, update: value });

  const runtimeFor = (cwd: string): Promise<Runtime> => {
    let found = runtimes.get(cwd);
    if (found === undefined) {
      found = buildRuntime(cwd, options.homeRoot, options.model);
      runtimes.set(cwd, found);
    }
    return found;
  };

  const openSession = async (cwd: unknown, servers: unknown, meta: SessionMeta | null, messages: Anthropic.MessageParam[]): Promise<AcpSession> => {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new RpcError(ERRORS.invalidParams, "cwd must be an absolute path");
    const runtime = await runtimeFor(cwd);
    const extra = await connectExtraMcp(servers);
    for (const error of extra?.errors ?? []) log(error);
    const created = meta ?? (await runtime.sessions.create(runtime.root, runtime.config.model, runtime.git?.branch));
    const session: AcpSession = {
      id: created.id,
      runtime,
      meta: created,
      messages,
      extraMcp: extra,
      readFiles: new Set(),
      approvals: new Set(),
      gate: new ClassifierGate(runtime.classify),
      log: new DecisionLog(runtime.layout.logs),
      mode: { approval: runtime.config.approval_policy === "never" ? "never" : "on-request", readOnly: runtime.config.sandbox_mode === "read-only" },
      system: null,
      controller: null,
      currentTool: null,
      pendingPermissions: new Set(),
    };
    sessions.set(session.id, session);
    return session;
  };

  const sessionOf = (params: Json): AcpSession => {
    const session = sessions.get(String(params["sessionId"] ?? ""));
    if (session === undefined) throw new RpcError(ERRORS.resourceNotFound, `unknown session: ${String(params["sessionId"])}`);
    return session;
  };

  const askPermission = async (session: AcpSession, tool: string, summary: string, reason: string): Promise<ApprovalAnswer> => {
    const toolCallId = session.currentTool ?? `permission-${Date.now()}`;
    const cancelled = new Promise<ApprovalAnswer>((resolve) => {
      const settle = () => {
        session.pendingPermissions.delete(settle);
        resolve("deny");
      };
      session.pendingPermissions.add(settle);
    });
    const asked = request("session/request_permission", {
      sessionId: session.id,
      toolCall: { toolCallId, title: `${tool}: ${summary}`, rawInput: { reason } },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-session", name: "Allow this session", kind: "allow_always" },
        { optionId: "reject", name: "Deny", kind: "reject_once" },
      ],
    }).then((result) => {
      const outcome = (result["outcome"] ?? {}) as Json;
      if (outcome["outcome"] !== "selected") return "deny" as const;
      if (outcome["optionId"] === "allow-once") return "once" as const;
      if (outcome["optionId"] === "allow-session") return "session" as const;
      return "deny" as const;
    });
    return Promise.race([asked, cancelled]);
  };

  const contextFor = (session: AcpSession): ToolContext => {
    const { runtime } = session;
    const roots = sessionRoots(runtime.root, runtime.layout.sessions, session.id);
    return {
      root: runtime.root,
      tasks: runtime.tasks,
      terminals: runtime.terminals,
      scratchRoots: roots.policy,
      home: runtime.userHome,
      session: session.id,
      sandbox: runtime.sandboxAvailable && runtime.sandbox !== null ? { ...runtime.sandbox, writableRoots: [...runtime.sandbox.writableRoots, ...roots.sandbox] } : null,
      mode: session.mode,
      memoryDir: runtime.config.memory.enabled ? runtime.memoryDir : undefined,
      webDomains: runtime.config.web.allowed_domains.map((domain) => domain.toLowerCase()),
      readFiles: session.readFiles,
      sessionApprovals: session.approvals,
      approver: { ask: (asked) => askPermission(session, asked.tool, asked.summary, asked.reason) },
      log: session.log,
    };
  };

  const prompt = async (params: Json): Promise<Json> => {
    const session = sessionOf(params);
    if (session.controller !== null) throw new RpcError(ERRORS.invalidRequest, "a prompt is already running in this session");
    const { runtime } = session;
    const content = promptContent(params["prompt"]);
    const base = { session: session.id, cwd: runtime.root, transcriptPath: transcriptOf(runtime, session.id), permissionMode: permissionModeName(session.mode) };
    if (runtime.hooks.has("UserPromptSubmit")) {
      const check = await runtime.hooks.fire("UserPromptSubmit", "", base, { prompt: textOf(content) });
      for (const message of check.messages) log(message);
      if (check.block !== null) {
        update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Prompt blocked by a hook: ${check.block}` } });
        return { stopReason: "refusal" };
      }
      if (check.context.length > 0) content.push({ type: "text", text: hookContext("UserPromptSubmit", check.context) });
    }
    const user: Anthropic.MessageParam = { role: "user", content };
    session.messages.push(user);
    await persist(session, user);
    await ensureDirs(sessionScratch(runtime.root, session.id).scratchpad);
    session.system ??= await buildSessionSystem(runtime, session.id);

    const controller = new AbortController();
    session.controller = controller;
    const tools = [...runtime.tools, ...(session.extraMcp?.tools ?? [])].filter((tool) => tool.name !== "Agent");
    try {
      await runAgent({
        model: runtime.model,
        system: session.system,
        tools,
        messages: session.messages,
        ctx: contextFor(session),
        gate: session.gate,
        projectPolicy: await readProjectPolicy(runtime.root),
        maxTurns: runtime.config.agent.max_turns,
        compactAt: runtime.config.context.compact_at_tokens,
        summarize: runtime.summarize,
        maxTotalTokens: runtime.config.agent.max_total_tokens,
        signal: controller.signal,
        hooks: runtime.hooks,
        hookInfo: { transcriptPath: transcriptOf(runtime, session.id) },
        modelId: runtime.config.model,
        effort: runtime.config.model_reasoning_effort,
        events: {
          onMessage: (message) => {
            void persist(session, message);
          },
          onText: (text) => update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }),
          onNotice: (text) => log(text),
          onToolStart: (use) => {
            session.currentTool = use.id;
            update(session.id, toolCallUpdate(use.id, use.name, use.input, runtime.root));
          },
          onToolEnd: (use) => {
            session.currentTool = null;
            update(session.id, {
              sessionUpdate: "tool_call_update",
              toolCallId: use.id,
              status: use.ok ? "completed" : "failed",
              content: [{ type: "content", content: { type: "text", text: clip(use.output) } }],
            });
          },
        },
      });
      return { stopReason: "end_turn" };
    } catch (error) {
      if (controller.signal.aborted) return { stopReason: "cancelled" };
      const message = error instanceof Error ? error.message : String(error);
      if (/turn limit of \d+ reached/.test(message)) return { stopReason: "max_turn_requests" };
      throw new RpcError(ERRORS.internal, message);
    } finally {
      session.controller = null;
      session.currentTool = null;
    }
  };

  const persist = async (session: AcpSession, message: Anthropic.MessageParam) => {
    session.meta = await session.runtime.sessions.append(session.meta, message).catch((error: unknown) => {
      log(`could not save the session: ${error instanceof Error ? error.message : String(error)}`);
      return session.meta;
    });
  };

  const handlers: Record<string, (params: Json) => Promise<Json>> = {
    initialize: async () => ({
      // Plif speaks version 1. A client asking for another one gets 1 back and decides whether to go on.
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      agentInfo: { name: "plif", title: "Plif", version: "0.1.0" },
      authMethods: [],
    }),
    authenticate: async () => ({}),
    "session/new": async (params) => {
      const session = await openSession(params["cwd"], params["mcpServers"], null, []);
      return { sessionId: session.id };
    },
    "session/load": async (params) => {
      const cwd = params["cwd"];
      if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new RpcError(ERRORS.invalidParams, "cwd must be an absolute path");
      const runtime = await runtimeFor(cwd);
      const loaded = await runtime.sessions.load(String(params["sessionId"] ?? "")).catch(() => null);
      if (loaded === null || loaded.meta.cwd !== runtime.root) throw new RpcError(ERRORS.resourceNotFound, `no session ${String(params["sessionId"])} in ${cwd}`);
      sessions.delete(loaded.meta.id);
      const session = await openSession(cwd, params["mcpServers"], loaded.meta, loaded.messages);
      for (const entry of replay(loaded.messages, runtime.root)) update(session.id, entry);
      return {};
    },
    "session/prompt": prompt,
  };

  const notifications: Record<string, (params: Json) => void> = {
    "session/cancel": (params) => {
      const session = sessions.get(String(params["sessionId"] ?? ""));
      if (session === undefined) return;
      session.controller?.abort();
      for (const settle of [...session.pendingPermissions]) settle("deny");
    },
  };

  const handle = async (message: Json): Promise<void> => {
    const id = message["id"];
    const method = message["method"];
    if (typeof method !== "string") {
      // A response to a request Plif sent.
      const waiter = typeof id === "number" ? pending.get(id) : undefined;
      if (waiter === undefined) return;
      pending.delete(id as number);
      if (message["error"] !== undefined) waiter.reject(new Error(String((message["error"] as Json)["message"] ?? "client error")));
      else waiter.resolve((message["result"] ?? {}) as Json);
      return;
    }
    const params = (typeof message["params"] === "object" && message["params"] !== null ? message["params"] : {}) as Json;
    if (id === undefined || id === null) {
      notifications[method]?.(params);
      return;
    }
    const handler = handlers[method];
    if (handler === undefined) {
      write({ id, error: { code: ERRORS.methodNotFound, message: `method not found: ${method}` } });
      return;
    }
    try {
      write({ id, result: await handler(params) });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : ERRORS.internal;
      write({ id, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  };

  let buffer = "";
  const inFlight = new Set<Promise<void>>();
  options.input.setEncoding("utf8");
  await new Promise<void>((resolve) => {
    options.input.on("data", (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf("\n");
      while (end !== -1) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");
        if (line === "") continue;
        let message: Json;
        try {
          message = JSON.parse(line) as Json;
        } catch {
          write({ id: null, error: { code: ERRORS.parse, message: "parse error" } });
          continue;
        }
        const work = handle(message).catch((error: unknown) => log(`acp: ${error instanceof Error ? error.message : String(error)}`));
        inFlight.add(work);
        void work.finally(() => inFlight.delete(work));
      }
    });
    options.input.once("end", () => resolve());
    options.input.once("close", () => resolve());
  });
  for (const session of sessions.values()) session.controller?.abort();
  await Promise.allSettled([...inFlight]);
  for (const session of sessions.values()) await session.extraMcp?.close();
  for (const runtime of runtimes.values()) await (await runtime).dispose();
}

function transcriptOf(runtime: Runtime, id: string): string {
  return path.join(runtime.layout.sessions, id, "transcript.jsonl");
}

// The editor's MCP servers come as arrays of {name, value}; Plif's client wants records.
async function connectExtraMcp(raw: unknown): Promise<McpLoad | null> {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const servers: Record<string, unknown> = {};
  for (const entry of raw as Json[]) {
    const name = String(entry["name"] ?? "");
    if (name === "") continue;
    const pairs = (value: unknown) => Object.fromEntries(((Array.isArray(value) ? value : []) as Json[]).map((pair) => [String(pair["name"]), String(pair["value"])]));
    servers[name] =
      entry["type"] === "http" || entry["type"] === "sse"
        ? { type: entry["type"], url: entry["url"], headers: pairs(entry["headers"]) }
        : { command: entry["command"], args: entry["args"] ?? [], env: pairs(entry["env"]) };
  }
  return connectMcp(servers);
}

// ACP content blocks become Anthropic content. Resources are inlined as text the model can read.
export function promptContent(raw: unknown): Anthropic.ContentBlockParam[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new RpcError(ERRORS.invalidParams, "prompt must be a non-empty array of content blocks");
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const block of raw as Json[]) {
    const type = block["type"];
    if (type === "text") blocks.push({ type: "text", text: String(block["text"] ?? "") });
    else if (type === "image") {
      const bytes = Buffer.from(String(block["data"] ?? ""), "base64");
      const image = checkImage(bytes);
      if (typeof image === "string") throw new RpcError(ERRORS.invalidParams, `image refused: ${image}`);
      blocks.push(imageBlock(bytes, image.type));
    } else if (type === "resource") {
      const resource = (block["resource"] ?? {}) as Json;
      const uri = String(resource["uri"] ?? "");
      blocks.push({
        type: "text",
        text: typeof resource["text"] === "string" ? `<resource uri="${uri}">\n${resource["text"]}\n</resource>` : `<resource uri="${uri}">(binary content not included)</resource>`,
      });
    } else if (type === "resource_link") {
      blocks.push({ type: "text", text: `<resource_link uri="${String(block["uri"] ?? "")}" name="${String(block["name"] ?? "")}" />` });
    } else {
      throw new RpcError(ERRORS.invalidParams, `unsupported content block: ${String(type)}`);
    }
  }
  return blocks;
}

function textOf(content: readonly Anthropic.ContentBlockParam[]): string {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

const KINDS: Record<string, string> = {
  Read: "read",
  Write: "edit",
  Edit: "edit",
  Bash: "execute",
  Terminal: "execute",
  Monitor: "execute",
  Git: "execute",
  Grep: "search",
  Glob: "search",
  WebSearch: "fetch",
  WebFetch: "fetch",
  WebView: "fetch",
  Plan: "think",
};

export function toolCallUpdate(id: string, name: string, input: unknown, root: string): Json {
  const record = (typeof input === "object" && input !== null ? input : {}) as Json;
  const file = typeof record["file_path"] === "string" ? record["file_path"] : typeof record["path"] === "string" ? record["path"] : null;
  const summary = summarizeInput(input).split(`${root}${path.sep}`).join("");
  return {
    sessionUpdate: "tool_call",
    toolCallId: id,
    title: `${name}: ${summary}`,
    kind: KINDS[name] ?? "other",
    status: "in_progress",
    rawInput: input,
    ...(file === null ? {} : { locations: [{ path: path.isAbsolute(file) ? file : path.join(root, file) }] }),
  };
}

// session/load sends the whole conversation back as updates, in order.
export function replay(messages: readonly Anthropic.MessageParam[], root: string): Json[] {
  const out: Json[] = [];
  for (const message of messages) {
    const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    for (const block of blocks) {
      if (block.type === "text" && block.text.trim() !== "") {
        out.push({ sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: block.text } });
      } else if (block.type === "tool_use") {
        out.push({ ...toolCallUpdate(block.id, block.name, block.input, root), status: "completed" });
      } else if (block.type === "tool_result") {
        const text = typeof block.content === "string" ? block.content : outputText((block.content ?? []) as Parameters<typeof outputText>[0]);
        out.push({ sessionUpdate: "tool_call_update", toolCallId: block.tool_use_id, status: block.is_error === true ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text: clip(text) } }] });
      }
    }
  }
  return out;
}

function clip(text: string): string {
  return text.length > TOOL_OUTPUT_CHARS ? `${text.slice(0, TOOL_OUTPUT_CHARS)}\n[cut at ${TOOL_OUTPUT_CHARS} characters]` : text;
}
