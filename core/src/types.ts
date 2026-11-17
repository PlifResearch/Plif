import type { Terminals } from "./terminals.js";
import type { SubagentLauncher } from "./subagents.js";
import type { BackgroundTasks } from "./tasks.js";
export type Level = 0 | 1 | 2 | 3;
export type Decision = "allow" | "ask_user" | "deny";

export interface Verdict {
  readonly level: Level;
  readonly decision: Decision;
  readonly reason: string;
}

export interface ApprovalRequest {
  readonly tool: string;
  readonly summary: string;
  readonly reason: string;
  // Set when a subagent asks: the title of the subagent, shown beside the question.
  readonly from?: string;
}

// "session" approves this action and every later action with the same signature in the session.
export type ApprovalAnswer = "once" | "session" | "deny";

export interface Approver {
  ask(request: ApprovalRequest): Promise<ApprovalAnswer>;
}

export interface EventLog {
  record(entry: Record<string, unknown>): Promise<void>;
}

export interface SandboxSettings {
  readonly readOnly: boolean;
  readonly network: "allow" | "deny";
  readonly maskPaths: readonly string[];
  readonly writableRoots: readonly string[];
}

// "on-request": the classifier decides first and the user only sees what it cannot allow.
// "ask": every action outside the policy goes to the user, and the classifier is not consulted.
export interface PermissionMode {
  approval: "on-request" | "ask" | "never";
  readOnly: boolean;
}

export interface PolicyContext {
  readonly root: string;
  // Temp and session folders the file tools may use without asking (scratchpad, artifacts, session memory).
  readonly scratchRoots?: readonly string[];
  readonly home: string;
  readonly sandboxed?: boolean;
  readonly readOnly?: boolean;
  readonly webDomains?: readonly string[];
  readonly terminals?: Terminals;
}

export interface ToolContext {
  readonly root: string;
  readonly tasks?: BackgroundTasks;
  readonly terminals?: Terminals;
  readonly subagents?: SubagentLauncher;
  readonly scratchRoots?: readonly string[];
  readonly home: string;
  readonly session: string;
  readonly sandbox: SandboxSettings | null;
  readonly mode: PermissionMode;
  readonly memoryDir?: string;
  readonly webDomains?: readonly string[];
  readonly coauthor?: string | null;
  readonly readFiles: Set<string>;
  // Signatures of actions the user approved for the whole session. The App makes one per session.
  readonly sessionApprovals?: Set<string>;
  readonly approver: Approver;
  readonly log: EventLog;
}

export function policyContextOf(ctx: ToolContext): PolicyContext {
  return {
    root: ctx.root,
    scratchRoots: ctx.scratchRoots,
    home: ctx.home,
    sandboxed: ctx.sandbox !== null,
    readOnly: ctx.mode.readOnly,
    webDomains: ctx.webDomains,
    terminals: ctx.terminals,
  };
}
