import type Anthropic from "@anthropic-ai/sdk";
import type { AgentEvents } from "./agent.js";
import { type Catalog, findModel } from "./catalog.js";
import { limitOutput } from "./output.js";
import type { RegisteredTool } from "./tools/registry.js";

export const SUBAGENT_TYPES = ["general", "explore"] as const;
export type SubagentType = (typeof SUBAGENT_TYPES)[number];
export type SubagentStatus = "running" | "done" | "failed" | "stopped";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// What the screen shows of a subagent. The API history lives in messages.
export type TranscriptEntry =
  | { readonly kind: "user"; readonly text: string; readonly from: "main" | "user" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly summary: string; readonly ok: boolean }
  | { readonly kind: "notice"; readonly text: string; readonly tone: "dim" | "error" };

export interface Subagent {
  readonly id: number;
  readonly type: SubagentType;
  readonly description: string;
  // Start of the current run. A message from the person after the end starts a new run.
  startedAt: number;
  endedAt: number | null;
  status: SubagentStatus;
  tokens: number;
  current: ToolActivity | null;
  report: string;
  error: string | null;
  readonly transcript: TranscriptEntry[];
  readonly messages: Anthropic.MessageParam[];
}

export interface SubagentSpec {
  readonly type: SubagentType;
  readonly description: string;
  readonly prompt: string;
}

export interface SubagentRun {
  readonly signal: AbortSignal;
  readonly events: AgentEvents;
  readonly drainNotices: () => readonly string[];
}

export type SubagentRunner = (agent: Subagent, run: SubagentRun) => Promise<string>;

export interface SubagentEvent {
  readonly kind: "started" | "updated" | "finished";
  readonly agent: Subagent;
}

// What the Agent tool sees: it starts a subagent and gets its record back at once.
export interface SubagentLauncher {
  start(spec: SubagentSpec): Subagent;
}

const MAX_RUNNING = 4;
const REPORT_CHARS = 16_000;
const SUMMARY_CHARS = 100;
const GENERAL_MODEL = "claude-sonnet-5-5";
const EXPLORE_TOOLS = new Set(["Read", "Glob", "Grep", "Bash", "Git", "WebSearch", "WebFetch", "WebView"]);
// Depth 1: a subagent never gets Agent. Monitor and Plan belong to the main conversation.
const MAIN_ONLY_TOOLS = new Set(["Agent", "Monitor", "Plan"]);

export class Subagents {
  private readonly agents = new Map<number, Subagent>();
  private readonly runners = new Map<number, SubagentRunner>();
  private readonly controllers = new Map<number, AbortController>();
  private readonly inboxes = new Map<number, string[]>();
  private readonly listeners = new Set<(event: SubagentEvent) => void>();
  private nextId = 1;

  start(spec: SubagentSpec, runner: SubagentRunner): Subagent {
    if (this.running().length >= MAX_RUNNING) {
      throw new Error(`${MAX_RUNNING} subagents are already running; wait for one to finish`);
    }
    const agent: Subagent = {
      id: this.nextId++,
      type: spec.type,
      description: spec.description,
      startedAt: Date.now(),
      endedAt: null,
      status: "running",
      tokens: 0,
      current: null,
      report: "",
      error: null,
      transcript: [{ kind: "user", text: spec.prompt, from: "main" }],
      messages: [{ role: "user", content: spec.prompt }],
    };
    this.agents.set(agent.id, agent);
    this.runners.set(agent.id, runner);
    this.inboxes.set(agent.id, []);
    this.run(agent);
    this.emit({ kind: "started", agent });
    return agent;
  }

  // A message from the person. A running subagent reads it before its next request; a finished one runs again.
  send(id: number, text: string): boolean {
    const agent = this.agents.get(id);
    if (agent === undefined) return false;
    agent.transcript.push({ kind: "user", text, from: "user" });
    if (agent.status === "running") {
      this.inboxes.get(id)?.push(text);
      this.touch(agent);
      return true;
    }
    agent.messages.push({ role: "user", content: text });
    this.run(agent);
    this.emit({ kind: "started", agent });
    return true;
  }

  stop(id: number): boolean {
    const agent = this.agents.get(id);
    const controller = this.controllers.get(id);
    if (agent === undefined || agent.status !== "running" || controller === undefined) return false;
    agent.status = "stopped";
    controller.abort();
    return true;
  }

  stopAll(): void {
    for (const agent of this.running()) this.stop(agent.id);
  }

  get(id: number): Subagent | undefined {
    return this.agents.get(id);
  }

  list(): Subagent[] {
    return [...this.agents.values()];
  }

  running(): Subagent[] {
    return this.list().filter((agent) => agent.status === "running");
  }

  subscribe(listener: (event: SubagentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private run(agent: Subagent): void {
    const runner = this.runners.get(agent.id);
    const inbox = this.inboxes.get(agent.id);
    if (runner === undefined || inbox === undefined) return;
    const controller = new AbortController();
    this.controllers.set(agent.id, controller);
    agent.status = "running";
    agent.startedAt = Date.now();
    agent.endedAt = null;
    agent.current = null;
    agent.error = null;
    const summaries = new Map<string, string>();
    const events: AgentEvents = {
      onText: (text) => {
        agent.transcript.push({ kind: "text", text });
        this.touch(agent);
      },
      onNotice: (text) => {
        agent.transcript.push({ kind: "notice", text, tone: "dim" });
        this.touch(agent);
      },
      onToolStart: (use) => {
        const summary = summarizeInput(use.input);
        summaries.set(use.id, summary);
        agent.current = toolActivity(use.name, use.input, summary);
        this.touch(agent);
      },
      onToolEnd: (use) => {
        agent.current = null;
        agent.transcript.push({ kind: "tool", name: use.name, summary: summaries.get(use.id) ?? "", ok: use.ok });
        this.touch(agent);
      },
      onUsage: (usage) => {
        agent.tokens += usage.input_tokens + usage.output_tokens;
        this.touch(agent);
      },
    };

    runner(agent, { signal: controller.signal, events, drainNotices: () => inbox.splice(0) }).then(
      (report) => {
        agent.report = report;
        // A message that arrived after the last request would be lost, so it starts one more round.
        if (inbox.length > 0 && agent.status === "running") {
          agent.messages.push({ role: "user", content: inbox.splice(0).join("\n\n") });
          this.run(agent);
          return;
        }
        this.finish(agent, agent.status === "stopped" ? "stopped" : "done");
      },
      (error: unknown) => {
        if (agent.status === "stopped") {
          agent.transcript.push({ kind: "notice", text: "stopped by the user", tone: "dim" });
          this.finish(agent, "stopped");
          return;
        }
        agent.error = error instanceof Error ? error.message : String(error);
        agent.transcript.push({ kind: "notice", text: agent.error, tone: "error" });
        this.finish(agent, "failed");
      },
    );
  }

  private finish(agent: Subagent, status: Exclude<SubagentStatus, "running">): void {
    agent.status = status;
    agent.current = null;
    agent.endedAt = Date.now();
    this.controllers.delete(agent.id);
    this.emit({ kind: "finished", agent });
  }

  private touch(agent: Subagent): void {
    this.emit({ kind: "updated", agent });
  }

  private emit(event: SubagentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export function subagentLabel(agent: Pick<Subagent, "type">): string {
  return agent.type === "explore" ? "explore" : "delegate";
}

export function elapsedOf(agent: Subagent, now = Date.now()): number {
  return Math.max(0, (agent.endedAt ?? now) - agent.startedAt);
}

export function subagentTools(all: readonly RegisteredTool[], type: SubagentType): RegisteredTool[] {
  return all.filter((tool) => (type === "explore" ? EXPLORE_TOOLS.has(tool.name) : !MAIN_ONLY_TOOLS.has(tool.name)));
}

// Explore reads in volume, so it takes the cheap model of the catalog. General takes Sonnet when the catalog has it.
// `configured` holds the [models] subagent and explore ids from config.toml; an empty one keeps the choice below.
export function subagentModel(
  catalog: Catalog,
  type: SubagentType,
  sessionModel: string,
  configured: { readonly subagent?: string; readonly explore?: string } = {},
): { id: string; effort: Effort } {
  const fallback = type === "explore" ? catalog.classifier : findModel(catalog, GENERAL_MODEL) !== undefined ? GENERAL_MODEL : sessionModel;
  const id = (type === "explore" ? configured.explore : configured.subagent) ?? fallback;
  const entry = findModel(catalog, id);
  const effort: Effort = type === "explore" && entry?.efforts.includes("low") === true ? "low" : (entry?.defaultEffort ?? "medium");
  return { id, effort };
}

export function subagentRoleBlock(type: SubagentType): string {
  const lines = [
    "<subagent>",
    "You are a Plif subagent. The main agent delegated a task to you: the first user message is that delegation.",
    "You cannot see the main conversation. The person can follow your work and send messages; treat them as coming from the user.",
    "Your last message goes back to the main agent as a report. Write it in full: what you found, what you did, file paths, and what is still open.",
    "Do not create other subagents.",
  ];
  if (type === "explore") lines.push("Exploration mode, read only: do not create, edit or delete files.");
  lines.push("</subagent>");
  return lines.join("\n");
}

// The notice that wakes the main conversation. The report goes in it, since the internal history never returns.
export function subagentNotice(agent: Subagent): string {
  const seconds = Math.round(elapsedOf(agent) / 1000);
  const body = agent.status === "failed" ? `error: ${agent.error ?? "unknown"}` : limitOutput(agent.report.trim() || "(no report)", REPORT_CHARS);
  return `<subagent id="${agent.id}" type="${agent.type}" status="${agent.status}" duration="${seconds}s">${agent.description}</subagent>\n<report>\n${body}\n</report>\nReview the report before you use its findings.`;
}

// A tool that is running now. The screen shows it in the history, apart from the status line.
export interface ToolActivity {
  readonly name: string;
  readonly summary: string;
  readonly description: string | null;
  readonly command: string | null;
  readonly startedAt: number;
}

export function toolActivity(name: string, input: unknown, summary = summarizeInput(input)): ToolActivity {
  const record = (input ?? {}) as Record<string, unknown>;
  const text = (key: string) => {
    const value = record[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  return { name, summary, description: text("description"), command: text("command"), startedAt: Date.now() };
}

export function summarizeInput(input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  const picked =
    record["command"] ?? record["file_path"] ?? record["pattern"] ?? record["query"] ?? record["url"] ?? record["description"] ?? record["action"];
  const text = typeof picked === "string" ? picked : JSON.stringify(input);
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}...` : text;
}

const VERBS: Record<string, readonly [string, string]> = {
  Read: ["read 1 file", "read {n} files"],
  Glob: ["listed 1 file pattern", "listed {n} file patterns"],
  Grep: ["ran 1 code search", "ran {n} code searches"],
  Bash: ["ran 1 command", "ran {n} commands"],
  Git: ["checked Git 1 time", "checked Git {n} times"],
  Write: ["wrote 1 file", "wrote {n} files"],
  Edit: ["edited 1 file", "edited {n} files"],
  WebSearch: ["ran 1 web search", "ran {n} web searches"],
  WebFetch: ["opened 1 page", "opened {n} pages"],
  WebView: ["viewed 1 page in the browser", "viewed {n} pages in the browser"],
  Memory: ["used memory 1 time", "used memory {n} times"],
};

// "Read 3 files, listed 2 file patterns and ran 1 command", in the order the tools first ran.
export function describeToolRun(entries: readonly { readonly name: string; readonly ok: boolean }[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  const parts = [...counts].map(([name, count]) => {
    const verb = VERBS[name];
    if (verb === undefined) return `used ${name} ${count === 1 ? "1 time" : `${count} times`}`;
    return count === 1 ? verb[0] : verb[1].replace("{n}", String(count));
  });
  const failed = entries.filter((entry) => !entry.ok).length;
  const joined = parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  const text = joined.charAt(0).toUpperCase() + joined.slice(1);
  return failed === 0 ? text : `${text} (${failed} failed)`;
}
