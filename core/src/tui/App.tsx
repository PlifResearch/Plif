import type Anthropic from "@anthropic-ai/sdk";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Box, type DOMElement, Text, measureElement, useApp, useInput, usePaste, useStdin, useWindowSize } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { hookContext, runAgent } from "../agent.js";
import { type HookBase, type HookEvent, permissionModeName } from "../hooks.js";
import { findModel } from "../catalog.js";
import { setDefaultEffort, setTrust } from "../config.js";
import { ClassifierGate } from "../gate.js";
import { DecisionLog } from "../log.js";
import { loadInstructions, readIndex } from "../memory.js";
import { installServer, loadMarketplace, type MarketplaceEntry, searchEntries, serverFromEntry } from "../marketplace.js";
import { type McpServerConfig, loadMcpFile } from "../mcp.js";
import { skillsBlock } from "../skills.js";
import { readProjectPolicy } from "../prompts.js";
import { buildSessionSystem } from "../session-system.js";
import type { Runtime } from "../runtime.js";
import type { SessionMeta } from "../session.js";
import type { ApprovalAnswer, ApprovalRequest, PermissionMode, ToolContext } from "../types.js";
import { COMMANDS, matchingCommands, parseCommand } from "./commands.js";
import { Header, MENU_HINT, PROMPT_HINT, Prompt, SlashMenu } from "./components.js";
import { APPROVAL_ANSWERS, APPROVAL_OPTIONS, Approval, TrustDialog, initialApprovalFocus } from "./dialogs.js";
import { type Item, ItemView, TurnRail, turnsOf } from "./transcript.js";
import { type MouseEvent, ToolActivityView, ToolCardView, ToolGroupView, historyUnits, isMouseInput, mouseEvents } from "./tool-cards.js";
import { TaskChips, TaskPanel } from "./tasks.js";
import { AgentFooter, AgentTranscript, agentTitle, formatTokenCount } from "./agents.js";
import { type Subagent, type SubagentRunner, type ToolActivity, subagentModel, subagentNotice, subagentRoleBlock, subagentTools, summarizeInput, toolActivity } from "../subagents.js";
import { type HistoryLimits, HistoryView } from "./history.js";
import { formatSize, SessionPicker } from "./session-picker.js";
import { EffortMenu } from "./effort-menu.js";
import { ModelPicker } from "./model-picker.js";
import type { SessionEntry } from "../session.js";
import { completionNotice } from "../tasks.js";
import { ensureDirs, sessionFolders, sessionRoots, sessionScratch, stagingDir } from "../scratch.js";
import { McpBrowser } from "./mcp-browser.js";
import { VpsBrowser } from "./vps-browser.js";
import { checkKey, loadVpsList, saveVpsList, testConnection, type Vps, type VpsDraftInput, vpsBlock, vpsFromDraft, vpsPolicyLine } from "../vps.js";
import { loadMascot } from "./mascot.js";
import { isImagePasteKey } from "./terminal.js";
import {
  absorbDroppedImages,
  attachImage,
  Attachments,
  countImages,
  imageNumbers,
  displayText,
  messageContentFor,
  readClipboardImage,
  releaseAttachments,
  removeLast,
  storeAttachments,
} from "./images.js";

type Effort = Runtime["config"]["model_reasoning_effort"];

const MENU_ROWS = 8;
// Rows moved by one arrow press or one wheel step. The wheel arrives as arrow keys in the alternate screen.
const SCROLL_STEP = 3;
// Only the newest items are kept on screen. Each one is laid out on every frame, so the list has a ceiling.
const MAX_ITEMS = 500;

// History items never change once added, so they skip re-rendering while the person types.
const MemoItem = React.memo(ItemView);
const MemoHeader = React.memo(Header);

function windowOf<T>(items: readonly T[], selected: number, size: number): { items: T[]; start: number } {
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), items.length - size));
  return { items: items.slice(start, start + size), start };
}

export interface InitialSession {
  readonly meta: SessionMeta;
  readonly messages: Anthropic.MessageParam[];
}

// The first mode is the default: the classifier decides, and the person is asked only when it cannot.
const MODES = [
  { label: "auto", approval: "on-request", readOnly: false, tone: "accent" },
  { label: "ask", approval: "ask", readOnly: false, tone: "accent" },
  { label: "never ask", approval: "never", readOnly: false, tone: "warn" },
  { label: "read only", approval: "on-request", readOnly: true, tone: "ok" },
] as const;

interface Pending {
  readonly id: number;
  readonly request: ApprovalRequest;
  readonly resolve: (answer: ApprovalAnswer) => void;
}

// Shift+Enter as terminals without the kitty protocol send it, after Ink drops the escape byte:
// xterm modifyOtherKeys (CSI 27;2;13~), CSI u (CSI 13;2u), and ESC CR from terminals set up like Claude Code's /terminal-setup.
const SHIFT_ENTER = /^(?:\x1b?\[27;2;13~|\x1b?\[13;2u|\x1b\r)$/;

// The exit hint stays up this long; a second Ctrl+C inside the window exits.
const EXIT_WINDOW_MS = 2000;

export function App({
  runtime,
  trusted,
  initialSession,
  onSessionChange,
}: {
  readonly runtime: Runtime;
  readonly trusted: boolean;
  readonly initialSession?: InitialSession;
  readonly onSessionChange?: (id: string) => void;
}): React.ReactElement {
  const { exit } = useApp();
  const [logo] = useState(() => loadMascot());
  const { rows, columns } = useWindowSize();
  // Rows scrolled back from the newest line of the history. 0 follows new content.
  const [scrollBack, setScrollBack] = useState(0);
  const limitsRef = useRef<HistoryLimits>({ maxScroll: 0, viewport: 0 });
  const onLimits = useCallback((limits: HistoryLimits) => {
    limitsRef.current = limits;
  }, []);
  const scrollBy = (delta: number) =>
    setScrollBack((current) => Math.min(Math.max(0, current + delta), limitsRef.current.maxScroll));
  const page = () => Math.max(1, limitsRef.current.viewport - 2);
  const startMode = runtime.config.sandbox_mode === "read-only" ? 3 : runtime.config.approval_policy === "never" ? 2 : 0;
  const initialItems: Item[] = [
    ...(trusted ? [{ kind: "header" as const, id: 0 }] : []),
    ...itemsFromMessages(initialSession?.messages ?? [], trusted ? 1 : 0),
  ];

  // Which conversation fills the screen: null is main, a number is a subagent. The cursor walks the footer list.
  const [viewing, setViewing] = useState<number | null>(null);
  const viewingRef = useRef<number | null>(null);
  const [agentCursor, setAgentCursor] = useState<number | null>(null);
  const [, setAgentVersion] = useState(0);
  const agentFilesRef = useRef(new Map<number, Set<string>>());
  const [phase, setPhase] = useState<"trust" | "chat" | "browser" | "vps" | "tasks" | "resume" | "effort" | "model">(trusted ? "chat" : "trust");
  const [resumeList, setResumeList] = useState<SessionEntry[]>([]);
  // Background tasks: each change re-renders the chips and the panel. Notices wait here while a turn is running.
  const [, setTaskVersion] = useState(0);
  const noticesRef = useRef<string[]>([]);
  const wakeRef = useRef<(text: string) => void>(() => {});
  // Context from SessionStart and UserPromptSubmit hooks, added to the next message the model gets.
  const pendingContextRef = useRef<string[]>([]);
  // Whether the next new session comes from the first start or from /clear, for the SessionStart matcher.
  const nextSourceRef = useRef<"startup" | "clear">("startup");
  const [browser, setBrowser] = useState<BrowserState | null>(null);
  // The VPS is off unless this session switched it on. It is restored with the session on /resume and --session.
  const [sessionVps, setSessionVps] = useState<Vps | null>(initialSession?.meta.vps ?? null);
  const vpsRef = useRef<Vps | null>(sessionVps);
  const [vpsList, setVpsList] = useState<Vps[]>([]);
  const [trustIndex, setTrustIndex] = useState(0);
  const [items, setItems] = useState<Item[]>(initialItems);
  const nextId = useRef(initialItems.length + 1);
  const [value, setValue] = useState("");
  const valueRef = useRef("");
  const [menuIndex, setMenuIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // The tool running now. It shows in the history; the status line keeps only the phase, the clock and the tokens.
  const [running, setRunning] = useState<ToolActivity | null>(null);
  const [turnTokens, setTurnTokens] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  // Subagents run beside the main turn, so approvals can overlap. They wait in line and show one at a time.
  const approvalQueueRef = useRef<Pending[]>([]);
  const approvalIdRef = useRef(0);
  const [approvalIndex, setApprovalIndex] = useState(0);
  // Actions the user approved for this session, by signature (tool and input summary).
  const sessionApprovalsRef = useRef(new Set<string>());
  const [exitHint, setExitHint] = useState(false);
  const exitArmedRef = useRef(0);
  // Prompts sent in this session, oldest first, for Ctrl+R. The search keeps the query it started with.
  const promptHistoryRef = useRef<string[]>([]);
  const promptSearchRef = useRef<{ query: string; original: string; from: number } | null>(null);
  const [modeIndex, setModeIndex] = useState(startMode);
  const [modelId, setModelId] = useState(runtime.config.model);
  const [effort, setEffort] = useState<Effort>(runtime.config.model_reasoning_effort);
  const [tokens, setTokens] = useState(0);
  const [turnStart, setTurnStart] = useState<number | null>(null);
  // What the model is writing in the current turn, from its stream. The busy line shows only this.
  const [progress, setProgress] = useState<{ block: "thinking" | "text" | "tool_use" | null; thinkingChars: number }>(
    { block: null, thinkingChars: 0 },
  );
  const [sessionId, setSessionId] = useState(initialSession?.meta.id ?? "");
  useEffect(() => {
    if (sessionId !== "") onSessionChange?.(sessionId);
  }, [sessionId, onSessionChange]);

  const modeRef = useRef<PermissionMode>(modeFrom(MODES[startMode] ?? MODES[0]));
  const sessionRef = useRef<SessionMeta | null>(initialSession?.meta ?? null);
  const messagesRef = useRef<Anthropic.MessageParam[]>(initialSession?.messages ?? []);
  const readFilesRef = useRef(new Set<string>());
  // Images pasted or dropped into the prompt. The prompt text holds markers that point here.
  const attachmentsRef = useRef<Attachments>(new Attachments(countImages(initialSession?.messages ?? []) + 1));
  const stagingPath = stagingDir(runtime.root);
  const gateRef = useRef(new ClassifierGate(runtime.classify));
  const logRef = useRef(new DecisionLog(runtime.layout.logs));
  const persistRef = useRef<Promise<void>>(Promise.resolve());
  const summariesRef = useRef(new Map<string, string>());
  const inputsRef = useRef(new Map<string, unknown>());
  const startsRef = useRef(new Map<string, number>());
  // Tool cards: a click opens or closes one, the pointer lights it. Each card's box is kept to find it under the mouse.
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<number>>(new Set());
  const [hoveredTool, setHoveredTool] = useState<number | null>(null);
  const cardRefs = useRef(new Map<number, DOMElement>());
  const systemRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const coauthorRef = useRef<string | null>(runtime.config.git.coauthor === "" ? null : runtime.config.git.coauthor);

  const menu = phase === "chat" ? matchingCommands(value) : [];
  // The menu shows a window of rows around the selection, so it fits small terminals.
  const menuWindow = windowOf(menu, menuIndex, MENU_ROWS);
  const modelName = findModel(runtime.catalog, modelId)?.name ?? modelId;
  const pathLabel = runtime.root.replace(runtime.userHome, "~");
  const details = [runtime.git?.branch, sessionVps === null ? undefined : `vps ${sessionVps.name}`].filter(Boolean).join(" · ");
  const modelLine = `${modelName} · ${effort}`;
  const mode = MODES[modeIndex] ?? MODES[0];

  const add = (make: (id: number) => Item) => {
    const id = nextId.current++;
    setItems((previous) => [...previous, make(id)]);
  };
  const notice = (text: string, tone: "dim" | "warn" | "error" | "footer" = "dim") =>
    add((id) => ({ kind: "notice", id, text, tone }));

  const setInput = (next: string) => {
    valueRef.current = next;
    setValue(next);
  };

  // Text typed or pasted in. A dragged image path becomes an image marker right away.
  const typeText = (text: string) => {
    const absorbed = absorbDroppedImages(valueRef.current + text, attachmentsRef.current, stagingPath);
    setInput(absorbed.value);
    setMenuIndex(0);
    for (const rejected of absorbed.rejected) notice(`image not attached: ${rejected}`, "warn");
  };

  const pasteClipboardImage = async () => {
    const image = await readClipboardImage();
    if (image === null) {
      notice("no image on the clipboard");
      return;
    }
    setInput(attachImage(valueRef.current, attachmentsRef.current, image, stagingPath));
    setMenuIndex(0);
  };

  const setBusyState = (next: boolean) => {
    busyRef.current = next;
    setBusy(next);
  };

  const persist = (message: Anthropic.MessageParam): Promise<void> => {
    persistRef.current = persistRef.current
      .then(async () => {
        const meta = sessionRef.current;
        if (meta === null) return;
        sessionRef.current = await runtime.sessions.append(meta, message);
        setSessionId(sessionRef.current.id);
      })
      .catch((error: unknown) => notice(`could not save the session: ${messageOf(error)}`, "error"));
    return persistRef.current;
  };

  const transcriptOf = (id: string) => path.join(runtime.layout.sessions, id, "transcript.jsonl");
  const hookBase = (id: string): HookBase => ({
    session: id,
    cwd: runtime.root,
    transcriptPath: id === "" ? undefined : transcriptOf(id),
    permissionMode: permissionModeName(modeRef.current),
  });
  // Runs a session-level event and shows its messages. Context it returns waits for the next prompt.
  const fireSessionHook = async (event: HookEvent, match: string, id: string, fields: Record<string, unknown>) => {
    if (!runtime.hooks.has(event)) return null;
    const outcome = await runtime.hooks.fire(event, match, hookBase(id), fields);
    for (const message of outcome.messages) notice(message, "warn");
    return outcome;
  };
  const startSessionHooks = async (id: string, source: "startup" | "resume" | "clear") => {
    const outcome = await fireSessionHook("SessionStart", source, id, { source, model: modelId });
    if (outcome !== null && outcome.context.length > 0) pendingContextRef.current.push(hookContext("SessionStart", outcome.context));
  };
  const endSessionHooks = async (reason: "clear" | "resume") => {
    const id = sessionRef.current?.id;
    if (id !== undefined) await fireSessionHook("SessionEnd", reason, id, { reason });
  };

  const ensureSession = async (): Promise<SessionMeta> => {
    if (sessionRef.current === null) {
      sessionRef.current = await runtime.sessions.create(runtime.root, modelId, runtime.git?.branch);
      setSessionId(sessionRef.current.id);
      await startSessionHooks(sessionRef.current.id, nextSourceRef.current);
    }
    return sessionRef.current;
  };

  const showApproval = (next: Pending | null) => {
    pendingRef.current = next;
    setApprovalIndex(next === null ? 0 : initialApprovalFocus(next.request));
    setPending(next);
  };

  const approver = {
    ask: (request: ApprovalRequest) =>
      new Promise<ApprovalAnswer>((resolve) => {
        const next: Pending = { id: approvalIdRef.current++, request, resolve };
        if (pendingRef.current === null) showApproval(next);
        else approvalQueueRef.current.push(next);
      }),
  };

  const answer = (choice: ApprovalAnswer) => {
    const current = pendingRef.current;
    if (current === null) return;
    showApproval(approvalQueueRef.current.shift() ?? null);
    current.resolve(choice);
  };

  // Plif is idle: the first Ctrl+C shows a hint, a second one inside the window exits.
  const idleCtrlC = () => {
    const now = Date.now();
    if (now - exitArmedRef.current <= EXIT_WINDOW_MS) {
      exit();
      return;
    }
    exitArmedRef.current = now;
    setExitHint(true);
    setTimeout(() => setExitHint(false), EXIT_WINDOW_MS);
  };

  // Each press shows the next older prompt that contains the query. Esc restores the text the search started with.
  const stepPromptSearch = () => {
    const history = promptHistoryRef.current;
    const search = promptSearchRef.current ?? { query: valueRef.current, original: valueRef.current, from: history.length };
    promptSearchRef.current = search;
    for (let index = search.from - 1; index >= 0; index -= 1) {
      const entry = history[index];
      if (entry !== undefined && entry.includes(search.query)) {
        search.from = index;
        setInput(entry);
        return;
      }
    }
  };

  const mcpFile = path.join(runtime.layout.root, "mcp.json");
  const marketplaceCache = path.join(runtime.layout.root, "cache", "marketplace.json");

  const readInstalled = async (): Promise<Record<string, McpServerConfig>> => {
    try {
      return (await loadMcpFile(mcpFile)) as Record<string, McpServerConfig>;
    } catch {
      return {};
    }
  };

  const openBrowser = (): void => {
    setPhase("browser");
    setBrowser({ entries: null, loadError: null, source: null, installed: {}, errors: runtime.mcpErrors });
    void (async () => {
      try {
        const loaded = await loadMarketplace(runtime.config.marketplace.url, marketplaceCache);
        setBrowser((current) => (current === null ? null : { ...current, entries: loaded.entries, source: loaded.source }));
      } catch (error) {
        setBrowser((current) => (current === null ? null : { ...current, entries: [], loadError: messageOf(error) }));
      }
      const installed = await readInstalled();
      setBrowser((current) => (current === null ? null : { ...current, installed }));
    })();
  };

  const installEntry = async (entry: MarketplaceEntry): Promise<string> => {
    try {
      await installServer(mcpFile, entry.id, serverFromEntry(entry));
      const installed = await readInstalled();
      setBrowser((current) => (current === null ? null : { ...current, installed }));
      return `installed ${entry.id}. It connects the next time you open Plif.`;
    } catch (error) {
      return `could not install ${entry.id}: ${messageOf(error)}`;
    }
  };

  const vpsFile = path.join(runtime.layout.root, "vps.json");

  const applySessionVps = (vps: Vps | null): void => {
    vpsRef.current = vps;
    setSessionVps(vps);
    systemRef.current = null;
  };

  const openVps = (): void => {
    setPhase("vps");
    loadVpsList(vpsFile)
      .then(setVpsList)
      .catch((error: unknown) => notice(messageOf(error), "error"));
  };

  const toggleVps = (vps: Vps | null): void => {
    applySessionVps(vps);
    void (async () => {
      const meta = await ensureSession();
      sessionRef.current = await runtime.sessions.setVps(meta, vps);
    })().catch((error: unknown) => notice(messageOf(error), "error"));
  };

  // Auto-mode: a new VPS is checked and tested before it is saved. Only the classifier reviews its commands.
  const addVps = async (draft: VpsDraftInput): Promise<string> => {
    try {
      const vps = vpsFromDraft(draft);
      const problems = await checkKey(vps.keyPath, runtime.userHome);
      if (problems.length > 0) return problems.join("; ");
      const test = await testConnection(vps, runtime.userHome);
      if (!test.ok) return `could not connect to ${vps.name}: ${test.message}`;
      const next = [...vpsList.filter((item) => item.name !== vps.name), vps];
      await saveVpsList(vpsFile, next);
      setVpsList(next);
      return `added ${vps.name}: connected`;
    } catch (error) {
      return messageOf(error);
    }
  };

  const testVps = async (vps: Vps): Promise<string> => {
    const result = await testConnection(vps, runtime.userHome);
    return result.ok ? `${vps.name}: connected` : `${vps.name}: ${result.message}`;
  };

  const deleteVps = async (vps: Vps): Promise<string> => {
    const next = vpsList.filter((item) => item.name !== vps.name);
    await saveVpsList(vpsFile, next);
    setVpsList(next);
    if (vpsRef.current?.name === vps.name) toggleVps(null);
    return `removed ${vps.name}`;
  };

  const contextFor = (session: string): ToolContext => {
    const roots = sessionRoots(runtime.root, runtime.layout.sessions, session);
    return {
    root: runtime.root,
    tasks: runtime.tasks,
    terminals: runtime.terminals,
    subagents: { start: (spec) => runtime.subagents.start(spec, runSubagentRef.current) },
    scratchRoots: roots.policy,
    home: runtime.userHome,
    session,
    sandbox: runtime.sandboxAvailable && runtime.sandbox !== null ? { ...runtime.sandbox, writableRoots: [...runtime.sandbox.writableRoots, ...roots.sandbox] } : null,
    mode: modeRef.current,
    memoryDir: runtime.config.memory.enabled ? runtime.memoryDir : undefined,
    coauthor: coauthorRef.current,
    webDomains: runtime.config.web.allowed_domains.map((domain) => domain.toLowerCase()),
    readFiles: readFilesRef.current,
    sessionApprovals: sessionApprovalsRef.current,
    approver,
    log: logRef.current,
    };
  };

  const buildSystem = (sessionId: string): Promise<string> =>
    buildSessionSystem(runtime, sessionId, vpsRef.current === null ? [] : [vpsBlock(vpsRef.current, runtime.userHome)]);

  // Each type has its own system prompt and tool list. General also reads the project instructions; Explore skips them to stay cheap.
  const buildSubagentSystem = async (agent: Subagent, sessionId: string): Promise<string> => {
    const parts = [runtime.subagentSystems[agent.type], subagentRoleBlock(agent.type)];
    parts.push(
      `<scratchpad>\nScratch folder for this session: ${sessionScratch(runtime.root, sessionId).scratchpad}. Use it for temporary files instead of /tmp.\n</scratchpad>`,
    );
    if (agent.type === "general") {
      const instructions = await loadInstructions(runtime.layout, runtime.root);
      if (instructions.length > 0) {
        parts.push(`<instructions>\n${instructions.map((item) => `## ${item.source}\n${item.text}`).join("\n\n")}\n</instructions>`);
      }
    }
    return parts.join("\n\n");
  };

  const runSubagent: SubagentRunner = async (agent, run) => {
    const meta = await ensureSession();
    const base = contextFor(meta.id);
    const files = agentFilesRef.current.get(agent.id) ?? new Set<string>();
    agentFilesRef.current.set(agent.id, files);
    const shared = modeRef.current;
    const ctx: ToolContext = {
      ...base,
      subagents: undefined,
      readFiles: files,
      // Explore stays read-only whatever the session mode is. The approval mode still follows the session.
      mode: agent.type === "explore" ? { get approval() { return shared.approval; }, set approval(_value) {}, readOnly: true } : shared,
      approver: { ask: (request) => approver.ask({ ...request, from: agentTitle(agent) }) },
    };
    const chosen = subagentModel(runtime.catalog, agent.type, modelId, runtime.config.models);
    const subagentBase = { ...hookBase(meta.id), agentId: String(agent.id), agentType: agent.type };
    let system = await buildSubagentSystem(agent, meta.id);
    if (runtime.hooks.has("SubagentStart")) {
      const started = await runtime.hooks.fire("SubagentStart", agent.type, subagentBase, {});
      for (const message of started.messages) notice(message, "warn");
      if (started.context.length > 0) system = `${system}\n\n${hookContext("SubagentStart", started.context)}`;
    }
    return runAgent({
      model: runtime.model,
      system,
      tools: subagentTools(runtime.tools, agent.type),
      messages: agent.messages,
      ctx,
      gate: gateRef.current,
      projectPolicy: [await readProjectPolicy(runtime.root), vpsRef.current === null ? "" : vpsPolicyLine(vpsRef.current)].filter((line) => line !== "").join("\n"),
      maxTurns: runtime.config.agent.max_turns,
      compactAt: runtime.config.context.compact_at_tokens,
      summarize: runtime.summarize,
      maxTotalTokens: runtime.config.agent.max_total_tokens,
      signal: run.signal,
      hooks: runtime.hooks,
      hookInfo: { transcriptPath: transcriptOf(meta.id), agentId: String(agent.id), agentType: agent.type },
      drainNotices: run.drainNotices,
      modelId: chosen.id,
      effort: chosen.effort,
      events: run.events,
    });
  };
  const runSubagentRef = useRef<SubagentRunner>(runSubagent);
  runSubagentRef.current = runSubagent;
  // The view's model line names the subagent's own model and effort, not the session's.
  const subagentModelLine = (agent: Subagent): string => {
    const chosen = subagentModel(runtime.catalog, agent.type, modelId, runtime.config.models);
    return `${findModel(runtime.catalog, chosen.id)?.name ?? chosen.id} · ${chosen.effort}`;
  };

  const showView = (id: number | null) => {
    viewingRef.current = id;
    setViewing(id);
    setAgentCursor(null);
    setScrollBack(0);
  };

  // fromUser is false when a finished background task wakes the conversation; UserPromptSubmit is for typed prompts.
  const submitPrompt = async (raw: string, fromUser = true) => {
    const meta = await ensureSession();
    if (fromUser) {
      const check = await fireSessionHook("UserPromptSubmit", "", meta.id, { prompt: displayText(raw, attachmentsRef.current) });
      if (check?.block != null) {
        notice(`prompt blocked by a hook: ${check.block}`, "warn");
        return;
      }
      if (check?.stop != null) {
        notice(`stopped by a hook: ${check.stop}`, "warn");
        return;
      }
      if (check !== null && check.context.length > 0) pendingContextRef.current.push(hookContext("UserPromptSubmit", check.context));
    }
    const scratch = sessionScratch(runtime.root, meta.id);
    await ensureDirs(scratch.scratchpad);
    // Images leave the staging folder for the session folder before they are read and sent.
    storeAttachments(raw, attachmentsRef.current, scratch.images);
    const hookTexts = pendingContextRef.current.splice(0);
    const content = messageContentFor(raw, attachmentsRef.current);
    const user: Anthropic.MessageParam = {
      role: "user",
      content: hookTexts.length === 0 ? content : [...(typeof content === "string" ? [{ type: "text" as const, text: content }] : content), ...hookTexts.map((text) => ({ type: "text" as const, text }))],
    };
    // A subagent report can be long. The model gets all of it; the history shows only that it arrived.
    const shown = displayText(raw, attachmentsRef.current)
      .replace(/<report>[\s\S]*?<\/report>\n?/g, "(report received)\n")
      .trim();
    const images = imageNumbers(raw, attachmentsRef.current);
    releaseAttachments(raw, attachmentsRef.current);
    messagesRef.current.push(user);
    add((id) => ({ kind: "user", id, text: shown, images }));
    await persist(user);

    setBusyState(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const started = Date.now();
    let turnTokenCount = 0;
    let promptTokens = 0;
    let cachedTokens = 0;
    setTurnStart(started);
    setTurnTokens(0);
    setProgress({ block: null, thinkingChars: 0 });
    try {
      await runAgent({
        model: runtime.model,
        system: systemRef.current ?? (systemRef.current = await buildSystem(meta.id)),
        tools: runtime.tools,
        messages: messagesRef.current,
        ctx: contextFor(meta.id),
        gate: gateRef.current,
        projectPolicy: [await readProjectPolicy(runtime.root), vpsRef.current === null ? "" : vpsPolicyLine(vpsRef.current)].filter((line) => line !== "").join("\n"),
        maxTurns: runtime.config.agent.max_turns,
        compactAt: runtime.config.context.compact_at_tokens,
        summarize: runtime.summarize,
        maxTotalTokens: runtime.config.agent.max_total_tokens,
        signal: controller.signal,
        hooks: runtime.hooks,
        hookInfo: { transcriptPath: transcriptOf(meta.id) },
        drainNotices: () => noticesRef.current.splice(0),
        modelId,
        effort,
        events: {
          onMessage: (message) => {
            void persist(message);
          },
          onText: (reply) => add((id) => ({ kind: "assistant", id, text: reply })),
          onNotice: (text) => notice(text),
          onToolStart: (use) => {
            // Paths inside the project read shorter and line up better as the object of the verb.
            const summary = summarizeInput(use.input).split(`${runtime.root}${path.sep}`).join("");
            summariesRef.current.set(use.id, summary);
            inputsRef.current.set(use.id, use.input);
            startsRef.current.set(use.id, Date.now());
            setRunning(toolActivity(use.name, use.input, summary));
          },
          onProgress: (event) => {
            setProgress((current) =>
              event.kind === "block"
                ? { ...current, block: event.block }
                : { ...current, thinkingChars: current.thinkingChars + event.chars },
            );
          },
          onToolEnd: (use) => {
            setRunning(null);
            setProgress((current) => ({ ...current, block: null }));
            // Writes into the session folder of artifacts are announced, so the deliverable is easy to find.
            const written = summariesRef.current.get(use.id) ?? "";
            if (use.name === "Write" && use.ok && written.includes(path.join(meta.id, "artifacts"))) {
              notice(`artefato salvo: ${path.basename(written)}`, "footer");
            }
            // add() builds the item later, inside the state update, so the values are taken now.
            const input = inputsRef.current.get(use.id);
            inputsRef.current.delete(use.id);
            const durationMs = Date.now() - (startsRef.current.get(use.id) ?? Date.now());
            startsRef.current.delete(use.id);
            add((id) => ({ kind: "tool", id, name: use.name, summary: written, ok: use.ok, output: use.output, input, durationMs }));
          },
          onUsage: (usage) => {
            const delta = usage.input_tokens + usage.output_tokens;
            turnTokenCount += delta;
            setTurnTokens(turnTokenCount);
            setTokens((total) => total + delta);
            const read = usage.cache_read_input_tokens ?? 0;
            cachedTokens += read;
            promptTokens += usage.input_tokens + read + (usage.cache_creation_input_tokens ?? 0);
          },
        },
      });
    } catch (error) {
      // Esc or Ctrl+C is the user's choice, not a failure: the turn line says "Interrupted" and nothing else.
      if (controller.signal.aborted !== true) notice(messageOf(error), "error");
    } finally {
      const stopped = abortRef.current?.signal.aborted === true;
      abortRef.current = null;
      setBusyState(false);
      setRunning(null);
      setTurnStart(null);
      const seconds = Math.round((Date.now() - started) / 1000);
      add((id) => ({ kind: "turnEnd", id, seconds, tokens: turnTokenCount, stopped }));
      // A task that finished after the last request of this turn starts a turn of its own.
      if (noticesRef.current.length > 0) wakeRef.current(noticesRef.current.splice(0).join("\n"));
      else if (!stopped) {
        void fireSessionHook("Notification", "idle_prompt", meta.id, {
          message: "Plif is waiting for your input",
          title: "Turn finished",
          notification_type: "idle_prompt",
        }).catch(() => undefined);
      }
    }
  };

  // Loads a session of this project into the screen. One from another project is named with the way to open it there.
  const resumeSession = async (prefix: string): Promise<void> => {
    try {
      const loaded = await runtime.sessions.load(prefix);
      if (loaded.meta.cwd !== runtime.root) {
        notice(`this session belongs to ${loaded.meta.cwd}. To continue: cd${JSON.stringify(loaded.meta.cwd)} && plif --session ${loaded.meta.id.slice(0, 8)}`, "warn");
        return;
      }
      if (sessionRef.current !== null && sessionRef.current.id !== loaded.meta.id) await endSessionHooks("resume");
      sessionRef.current = loaded.meta;
      messagesRef.current = loaded.messages;
      if (attachmentsRef.current.size === 0) attachmentsRef.current.next = countImages(loaded.messages) + 1;
      applySessionVps(loaded.meta.vps ?? null);
      readFilesRef.current = new Set();
      sessionApprovalsRef.current = new Set();
      systemRef.current = null;
      setSessionId(loaded.meta.id);
      for (const item of itemsFromMessages(loaded.messages, nextId.current)) {
        add(() => item);
      }
      notice(`session ${loaded.meta.id.slice(0, 8)} resumed`);
      await startSessionHooks(loaded.meta.id, "resume");
    } catch (error) {
      notice(messageOf(error), "error");
    }
  };

  const runCommand = async (text: string) => {
    const { name, arg } = parseCommand(text);
    switch (name) {
      case "help":
        notice(
          COMMANDS.map((command) => `/${command.name}${command.args === "" ? "" : ` ${command.args}`}  ${command.description}`).join(
            "\n",
          ),
        );
        return;
      case "model": {
        if (arg === "") {
          setPhase("model");
          return;
        }
        const found = findModel(runtime.catalog, arg);
        if (found === undefined) {
          notice(`unknown model: ${arg}. See /model.`, "warn");
          return;
        }
        setModelId(found.id);
        if (!found.efforts.includes(effort)) setEffort(found.defaultEffort);
        notice(`model: ${found.name}`);
        return;
      }
      case "effort": {
        const allowed = findModel(runtime.catalog, modelId)?.efforts ?? [];
        if (arg === "") {
          setPhase("effort");
          return;
        }
        if (!(allowed as readonly string[]).includes(arg)) {
          notice(`invalid effort for ${modelId}. Options: ${allowed.join(", ")}`, "warn");
          return;
        }
        setEffort(arg as Effort);
        notice(`effort: ${arg}`);
        return;
      }
      case "resume": {
        if (arg === "") {
          const list = await runtime.sessions.list();
          if (list.length === 0) {
            notice("no sessions yet");
            return;
          }
          setResumeList(list);
          setPhase("resume");
          return;
        }
        await resumeSession(arg);
        return;
      }
      case "clear":
        await endSessionHooks("clear");
        nextSourceRef.current = "clear";
        pendingContextRef.current = [];
        applySessionVps(null);
        sessionRef.current = null;
        messagesRef.current = [];
        readFilesRef.current = new Set();
        sessionApprovalsRef.current = new Set();
        attachmentsRef.current.clear();
        setSessionId("");
        notice("new session");
        return;
      case "coauthor": {
        if (arg === "off") coauthorRef.current = null;
        else if (arg === "on") coauthorRef.current = runtime.config.git.coauthor === "" ? null : runtime.config.git.coauthor;
        else if (arg !== "") {
          notice("use /coauthor on or /coauthor off", "warn");
          return;
        }
        notice(coauthorRef.current === null ? "co-author line off for new commits" : `co-author line on: ${coauthorRef.current}`);
        return;
      }
      case "vps":
        openVps();
        return;
      case "tasks":
        if (runtime.tasks.list().length === 0) notice("no background tasks in this session");
        else setPhase("tasks");
        return;
      case "artifacts": {
        const id = sessionRef.current?.id;
        const dir = id === undefined ? null : sessionFolders(runtime.layout.sessions, id).artifacts;
        const names = dir === null ? [] : await readdir(dir).catch(() => [] as string[]);
        if (dir === null || names.length === 0) {
          notice("no artifacts in this session");
          return;
        }
        const rows = await Promise.all(
          names.map(async (name) => {
            const info = await stat(path.join(dir, name));
            return `${name}  ${formatSize(info.size)}  ${info.mtime.toISOString().slice(0, 16).replace("T", " ")}`;
          }),
        );
        notice([`artifacts in ${dir}:`, ...rows].join("\n"));
        return;
      }
      case "mcp":
        openBrowser();
        return;
      case "exit":
        exit();
        return;
      default:
        notice(`unknown command: /${name}. See /help.`, "warn");
    }
  };

  // A paste arrives whole, newlines included. Dragged image paths inside it become attachments.
  usePaste((text) => {
    if (phase !== "chat" || pendingRef.current !== null) return;
    setAgentCursor(null);
    typeText(text.replace(/\r\n?/g, "\n"));
  });

  // Keeps the latest submit in a ref, because the subscription below is set once.
  // A session opened with plif --session counts as a resume for SessionStart hooks.
  const resumedOnStartRef = useRef(false);
  useEffect(() => {
    if (resumedOnStartRef.current || initialSession === undefined) return;
    resumedOnStartRef.current = true;
    void startSessionHooks(initialSession.meta.id, "resume").catch((error: unknown) => notice(messageOf(error), "error"));
  });

  wakeRef.current = (text: string) => {
    void submitPrompt(text, false).catch((error: unknown) => notice(messageOf(error), "error"));
  };
  useEffect(
    () =>
      runtime.tasks.subscribe((event) => {
        setTaskVersion((version) => version + 1);
        if (event.kind !== "finished") return;
        const { task } = event;
        notice(`task #${task.id} finished: ${task.status}${task.exitCode === null ? "" : ` (exit ${task.exitCode})`}`, "footer");
        const text = completionNotice(task);
        if (busyRef.current) noticesRef.current.push(text);
        else wakeRef.current(text);
      }),
    [runtime],
  );

  useEffect(
    () =>
      runtime.subagents.subscribe((event) => {
        setAgentVersion((version) => version + 1);
        const { agent } = event;
        if (event.kind === "started" && agent.transcript.length === 1) {
          notice(`${agentTitle(agent)} started: ${agent.description} · ↓ to follow`, "footer");
        }
        if (event.kind !== "finished") return;
        const outcome = agent.status === "done" ? "finished" : agent.status === "stopped" ? "stopped" : "failed";
        notice(`${agentTitle(agent)} ${outcome} · ${formatTokenCount(agent.tokens)} tokens`, agent.status === "failed" ? "warn" : "footer");
        const text = subagentNotice(agent);
        if (busyRef.current) noticesRef.current.push(text);
        else wakeRef.current(text);
      }),
    [runtime],
  );

  // Text typed while a subagent is in view goes to it, even during a main turn.
  const sendToAgent = (id: number) => {
    const text = valueRef.current.trim();
    setInput("");
    setScrollBack(0);
    if (text === "") return;
    if (!runtime.subagents.send(id, text)) notice("this subagent no longer exists", "warn");
  };

  const onEnter = async () => {
    const target = viewingRef.current;
    if (target !== null && !valueRef.current.trim().startsWith("/")) {
      sendToAgent(target);
      return;
    }
    if (busyRef.current) return;
    const current = valueRef.current;
    const currentMenu = matchingCommands(current);
    const picked = currentMenu[menuIndex];
    if (currentMenu.length > 0 && picked !== undefined && current !== `/${picked.name}`) {
      setInput(`/${picked.name}`);
      setMenuIndex(0);
      return;
    }
    const text = current.trim();
    setInput("");
    setMenuIndex(0);
    setScrollBack(0);
    if (text === "") return;
    if (text.startsWith("/")) {
      await runCommand(text);
      return;
    }
    promptHistoryRef.current.push(current);
    await submitPrompt(current);
  };

  const cycleMode = () => {
    const next = (modeIndex + 1) % MODES.length;
    const target = MODES[next] ?? MODES[0];
    modeRef.current.approval = target.approval;
    modeRef.current.readOnly = target.readOnly;
    setModeIndex(next);
  };

  const confirmTrust = async () => {
    await setTrust(runtime.layout.config, runtime.root, "trusted");
    add(() => ({ kind: "header", id: 0 }));
    setPhase("chat");
  };

  // The card under a screen row. Rows come from the layout, less the part of the history scrolled away.
  const cardAt = (row: number): number | null => {
    const { maxScroll, viewport } = limitsRef.current;
    if (row >= viewport) return null;
    const offset = maxScroll - Math.min(scrollBack, maxScroll);
    for (const [id, element] of cardRefs.current) {
      const box = measureElement(element);
      const top = box.y - offset;
      if (row >= top && row < top + box.height) return id;
    }
    return null;
  };

  const onMouse = (event: MouseEvent) => {
    if (event.button === 64 || event.button === 65) {
      scrollBy(event.button === 64 ? SCROLL_STEP : -SCROLL_STEP);
      return;
    }
    if (phase !== "chat" || viewingRef.current !== null) return;
    const hit = cardAt(event.y - 1);
    // Motion with no button held (35) moves the highlight. A left press (0) opens or closes the card.
    if (event.button === 35) {
      if (hit !== hoveredTool) setHoveredTool(hit);
      return;
    }
    if (event.button === 0 && event.press && hit !== null) {
      setExpandedTools((current) => {
        const next = new Set(current);
        if (!next.delete(hit)) next.add(hit);
        return next;
      });
    }
  };

  // Ink drops mouse reports as unknown control sequences, so they are read from stdin beside it.
  // In paused mode every read Ink makes also emits "data", so nothing is consumed twice.
  const { stdin } = useStdin();
  const onMouseRef = useRef(onMouse);
  onMouseRef.current = onMouse;
  useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      for (const event of mouseEvents(chunk.toString())) onMouseRef.current(event);
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [stdin]);

  useInput((input, key) => {
    if (isMouseInput(input)) return;
    if (phase === "browser" || phase === "vps" || phase === "tasks" || phase === "resume" || phase === "effort" || phase === "model") return;
    if (phase === "trust") {
      if (key.upArrow || key.downArrow) setTrustIndex((index) => (index === 0 ? 1 : 0));
      else if (key.return) {
        if (trustIndex === 0) void confirmTrust();
        else exit();
      } else if (key.escape) exit();
      else if (key.ctrl && input === "c") idleCtrlC();
      return;
    }
    if (key.ctrl && input === "c") {
      if (pendingRef.current !== null) {
        // Every waiting approval is denied, so the turn cannot go on with a queued one.
        while (pendingRef.current !== null) answer("deny");
        abortRef.current?.abort();
      } else if (busyRef.current) abortRef.current?.abort();
      else idleCtrlC();
      return;
    }
    if (pending !== null) {
      if (key.leftArrow || key.upArrow) setApprovalIndex((index) => Math.max(0, index - 1));
      else if (key.rightArrow || key.downArrow) setApprovalIndex((index) => Math.min(APPROVAL_OPTIONS.length - 1, index + 1));
      else if (key.return) answer(APPROVAL_ANSWERS[approvalIndex] ?? "deny");
      else if (input === "y") answer("once");
      else if (input === "s") answer("session");
      else if (input === "n" || key.escape) answer("deny");
      return;
    }
    // Ctrl+R walks back through this session's prompts. Any other key ends the search and keeps the text.
    if (!(key.ctrl && input === "r") && !key.escape) promptSearchRef.current = null;
    if (key.ctrl && input === "r") {
      stepPromptSearch();
      return;
    }
    if (key.escape && promptSearchRef.current !== null) {
      setInput(promptSearchRef.current.original);
      promptSearchRef.current = null;
      return;
    }
    // Cmd+V on macOS only pastes text, so an image in the clipboard needs Ctrl+V (or Alt+V on Windows).
    if (isImagePasteKey(input, key)) {
      void pasteClipboardImage();
      return;
    }
    if (key.shift && key.tab) {
      cycleMode();
      return;
    }
    const agents = runtime.subagents.list();
    if (agentCursor !== null) {
      if (key.upArrow) {
        setAgentCursor(agentCursor === 0 ? null : agentCursor - 1);
        return;
      }
      if (key.downArrow) {
        setAgentCursor(Math.min(agents.length, agentCursor + 1));
        return;
      }
      if (key.return) {
        showView(agentCursor === 0 ? null : (agents[agentCursor - 1]?.id ?? null));
        return;
      }
      if (key.escape) {
        setAgentCursor(null);
        return;
      }
      if (input === "x") {
        const picked = agents[agentCursor - 1];
        if (picked !== undefined && runtime.subagents.stop(picked.id)) notice(`stopping ${agentTitle(picked)}`);
        return;
      }
      setAgentCursor(null);
    }
    // Shift+Enter (kitty protocol) and Alt+Enter break the line. Terminals that send a plain Enter for
    // Shift+Enter can use a backslash at the end of the line, as in a shell.
    if ((key.return && (key.shift || key.meta)) || SHIFT_ENTER.test(input)) {
      typeText("\n");
      return;
    }
    if (key.return && valueRef.current.endsWith("\\")) {
      setInput(`${valueRef.current.slice(0, -1)}\n`);
      return;
    }
    if (input.includes("\r") || input.includes("\n")) {
      const head = input.split(/[\r\n]/)[0] ?? "";
      if (head !== "") typeText(head);
      void onEnter();
      return;
    }
    if (key.escape && viewingRef.current !== null) {
      if (valueRef.current === "") showView(null);
      else setInput("");
      return;
    }
    if (key.escape) {
      if (busyRef.current) {
        abortRef.current?.abort();
        return;
      }
      setInput("");
      setMenuIndex(0);
      return;
    }
    if (key.return) {
      void onEnter();
      return;
    }
    if (key.backspace || key.delete) {
      setInput(removeLast(valueRef.current));
      setMenuIndex(0);
      return;
    }
    if (key.ctrl && input === "t") {
      if (runtime.tasks.list().length > 0) setPhase("tasks");
      else notice("no background tasks in this session");
      return;
    }
    if (key.pageUp || key.pageDown) {
      scrollBy(key.pageUp ? page() : -page());
      return;
    }
    if (key.home || key.end) {
      setScrollBack(key.home ? limitsRef.current.maxScroll : 0);
      return;
    }
    // Arrows walk the command menu while it is open. Otherwise they scroll the history.
    const openMenu = matchingCommands(valueRef.current);
    if (key.upArrow) {
      if (openMenu.length > 0) setMenuIndex((index) => (index + openMenu.length - 1) % openMenu.length);
      else scrollBy(SCROLL_STEP);
      return;
    }
    if (key.downArrow) {
      if (openMenu.length > 0) setMenuIndex((index) => (index + 1) % openMenu.length);
      // At the end of the history, the arrow steps into the list of conversations.
      else if (scrollBack === 0 && agents.length > 0) {
        const at = agents.findIndex((agent) => agent.id === viewingRef.current);
        setAgentCursor(at + 1);
      } else scrollBy(-SCROLL_STEP);
      return;
    }
    if (input !== "" && !key.ctrl && !key.meta && !key.tab) typeText(input);
  });

  const runningTasks = runtime.tasks.running();
  const agentList = runtime.subagents.list();
  const viewed: Subagent | undefined = viewing === null ? undefined : runtime.subagents.get(viewing);
  const header = items.find((item) => item.kind === "header");
  const history = items.filter((item) => item.kind !== "header").slice(-MAX_ITEMS);
  const turns = turnsOf(history, pending !== null ? "waiting" : busy ? "running" : null);
  const behind = Math.min(scrollBack, limitsRef.current.maxScroll);

  return (
    // The app owns the whole alternate screen: history on top, live area pinned to the bottom.
    <Box flexDirection="column" height={rows} width={columns}>
      <HistoryView scrollBack={scrollBack} onLimits={onLimits}>
        {header === undefined || viewed !== undefined ? null : (
          <MemoHeader logo={logo} path={pathLabel} details={details} modelLine={modelLine} sandbox={runtime.sandboxAvailable} opening={history.length === 0} />
        )}
        {viewed !== undefined ? (
          <AgentTranscript agent={viewed} place={[runtime.root.replace(runtime.userHome, "~"), runtime.git?.branch].filter(Boolean).join(" · ")} model={subagentModelLine(viewed)} />
        ) : (
          <>
            {turns.map((turn, index) => (
              <TurnRail key={turn.key} rail={false} state={turn.state} gap={turn.gap}>
                {historyUnits(turn.items).map((unit) =>
                  unit.kind === "item" ? (
                    <MemoItem key={unit.id} item={unit.item} />
                  ) : (
                    <Box
                      key={unit.id}
                      flexDirection="column"
                      flexShrink={0}
                      ref={(element: DOMElement | null) => {
                        if (element === null) cardRefs.current.delete(unit.id);
                        else cardRefs.current.set(unit.id, element);
                      }}
                    >
                      {unit.kind === "group" ? (
                        <ToolGroupView tools={unit.tools} expanded={expandedTools.has(unit.id)} hovered={hoveredTool === unit.id} />
                      ) : (
                        <ToolCardView tool={unit.tool} expanded={expandedTools.has(unit.id)} hovered={hoveredTool === unit.id} />
                      )}
                    </Box>
                  ),
                )}
                {index === turns.length - 1 && running !== null ? <ToolActivityView activity={running} /> : null}
              </TurnRail>
            ))}
          </>
        )}
      </HistoryView>
      <Box flexDirection="column" flexShrink={0}>
      {behind > 0 ? (
        <Text dimColor>
          ↑ history · {behind} {behind === 1 ? "line" : "lines"} below · end jumps back
        </Text>
      ) : null}
      {phase === "vps" ? (
        <VpsBrowser
          list={vpsList}
          active={sessionVps?.name ?? null}
          onToggle={toggleVps}
          onAdd={addVps}
          onTest={testVps}
          onDelete={deleteVps}
          onClose={() => setPhase("chat")}
        />
      ) : phase === "browser" && browser !== null ? (
        <McpBrowser
          entries={browser.entries}
          loadError={browser.loadError}
          source={browser.source}
          marketplaceUrl={runtime.config.marketplace.url}
          installed={browser.installed}
          errors={browser.errors}
          matches={(entry, query) => searchEntries([entry], query).length === 1}
          onInstall={installEntry}
          onClose={() => setPhase("chat")}
        />
      ) : phase === "model" ? (
        <ModelPicker
          models={runtime.catalog.models}
          current={modelId}
          onCancel={() => setPhase("chat")}
          onPick={(model) => {
            setPhase("chat");
            setModelId(model.id);
            if (!model.efforts.includes(effort)) setEffort(model.defaultEffort);
            notice(`model: ${model.name}`);
          }}
        />
      ) : phase === "resume" ? (
        <SessionPicker
          sessions={resumeList}
          cwd={runtime.root}
          branch={runtime.git?.branch ?? null}
          onPreview={(id) => runtime.sessions.preview(id)}
          onRename={async (id, title) => {
            const renamed = await runtime.sessions.rename(id, title);
            // The open session keeps its meta in memory; without this the next save would bring the old title back.
            if (sessionRef.current?.id === id) sessionRef.current = { ...sessionRef.current, title: renamed.title };
          }}
          onPick={(session) => {
            setPhase("chat");
            if (session !== null) void resumeSession(session.id);
          }}
        />
      ) : phase === "effort" ? (
        <EffortMenu
          levels={findModel(runtime.catalog, modelId)?.efforts ?? [effort]}
          current={effort}
          modelDefault={findModel(runtime.catalog, modelId)?.defaultEffort ?? "medium"}
          onCancel={() => setPhase("chat")}
          onConfirm={(level, persist) => {
            setPhase("chat");
            setEffort(level);
            if (!persist) {
              notice(`effort: ${level} for this session`);
              return;
            }
            setDefaultEffort(runtime.layout.config, level)
              .then(() => notice(`effort: ${level}, saved as the default in config.toml`))
              .catch((error: unknown) => notice(`effort ${level} for this session; could not save the default: ${messageOf(error)}`, "warn"));
          }}
        />
      ) : phase === "tasks" ? (
        <TaskPanel
          tasks={runtime.tasks.list().slice().reverse()}
          onStop={(id) => runtime.tasks.stop(id)}
          onClose={() => setPhase("chat")}
        />
      ) : phase === "trust" ? (
        <TrustDialog cwd={runtime.root.replace(runtime.userHome, "~")} logo={logo} selected={trustIndex} />
      ) : (
        // The running command and any approval sit above the prompt, so the prompt stays on screen during a turn.
        <Box flexDirection="column">
          {pending !== null ? <Approval key={pending.id} request={pending.request} selected={approvalIndex} width={columns} /> : null}
          {menu.length > 0 ? (
            <SlashMenu
              commands={menuWindow.items}
              selected={menuIndex - menuWindow.start}
              position={menuIndex + 1}
              total={menu.length}
              query={value.slice(1)}
            />
          ) : null}
          {viewed !== undefined ? (
            <Prompt
              value={displayText(value, attachmentsRef.current)}
              width={columns}
              placeholder={`message ${agentTitle(viewed)} · esc back to main`}
              mode={mode.label}
              busy={
                viewed.status === "running"
                  ? { startedAt: viewed.startedAt, tokens: viewed.tokens, waiting: false, stoppable: false }
                  : undefined
              }
            />
          ) : (
            <Prompt
              value={displayText(value, attachmentsRef.current)}
              mode={mode.label}
              busy={
                busy
                  ? {
                      startedAt: turnStart ?? Date.now(),
                      tokens: turnTokens,
                      waiting: running === null && progress.block === null,
                      stoppable: true,
                    }
                  : undefined
              }
              hint={exitHint ? "press ctrl+c again to exit" : menu.length > 0 ? MENU_HINT : value === "" ? PROMPT_HINT : undefined}
              placeholder={pending !== null ? "waiting for you" : undefined}
            />
          )}
          <AgentFooter agents={agentList} cursor={agentCursor} mainStartedAt={busy ? (turnStart ?? Date.now()) : null} />
          <TaskChips running={runningTasks} />
        </Box>
      )}
      </Box>
    </Box>
  );
}

function modeFrom(mode: (typeof MODES)[number]): PermissionMode {
  return { approval: mode.approval, readOnly: mode.readOnly };
}

interface BrowserState {
  readonly entries: MarketplaceEntry[] | null;
  readonly loadError: string | null;
  readonly source: "network" | "cache" | null;
  readonly installed: Record<string, McpServerConfig>;
  readonly errors: readonly string[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function itemsFromMessages(messages: readonly Anthropic.MessageParam[], firstId: number): Item[] {
  const items: Item[] = [];
  let id = firstId;
  for (const message of messages) {
    if (message.role === "user" && typeof message.content === "string") {
      items.push({ kind: "user", id: id++, text: message.content });
    } else if (message.role === "user" && Array.isArray(message.content) && message.content.some((block) => block.type === "image")) {
      // Skips the compaction summary, which is merged into the first kept message as a text block.
      const text = message.content
        .flatMap((block) => (block.type === "text" && !block.text.startsWith("<conversation_summary>") ? [block.text] : []))
        .join("");
      items.push({ kind: "user", id: id++, text, images: [...text.matchAll(/\[Image #(\d+)\]/g)].map((match) => Number(match[1])) });
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
      if (text !== "") items.push({ kind: "assistant", id: id++, text });
    }
  }
  return items;
}
