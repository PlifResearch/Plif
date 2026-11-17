import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { killTree, treeSpawnOptions } from "./exec.js";
import { collapseRepeats, limitOutput, stripAnsi } from "./output.js";
import { type Host, currentHost, envValue, isWindows } from "./platform.js";

// Interactive terminals for the agent: a command runs in a pseudo-terminal, Plif waits a short time, and either the
// command has finished (exit code and output) or the agent gets a session number to write to and read from later.
// Same idea as Codex's exec_command and write_stdin; the code here is Plif's own.

export const DEFAULT_START_WAIT_MS = 10_000;
export const DEFAULT_WRITE_WAIT_MS = 1_000;
export const DEFAULT_POLL_WAIT_MS = 5_000;
export const MIN_WAIT_MS = 250;
export const MAX_WAIT_MS = 30_000;
export const MAX_POLL_WAIT_MS = 120_000;
const MAX_SESSIONS = 16;
const MAX_BUFFER_CHARS = 1024 * 1024;
const MAX_RESULT_CHARS = 12_000;
const KILL_AFTER_MS = 2_000;
const COLUMNS = 160;
const ROWS = 50;
// Programs drawn for a person (colours, cursor moves, pagers) are told the terminal is plain, so the output reads as text.
const PLAIN_TERMINAL_ENV: Record<string, string> = {
  TERM: "dumb",
  NO_COLOR: "1",
  COLORTERM: "",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GH_PAGER: "cat",
  PYTHON_BASIC_REPL: "1",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  COLUMNS: String(COLUMNS),
  LINES: String(ROWS),
};

export type TerminalStatus = "running" | "exited" | "stopped";

export interface TerminalSession {
  readonly id: number;
  readonly command: string;
  readonly description: string;
  readonly program: string;
  readonly tty: boolean;
  readonly startedAt: number;
  lastUsed: number;
  status: TerminalStatus;
  exitCode: number | null;
}

export interface TerminalResult {
  readonly session: number;
  readonly status: TerminalStatus;
  readonly exitCode: number | null;
  readonly output: string;
  readonly waitedMs: number;
  readonly note?: string;
}

interface Live {
  readonly session: TerminalSession;
  readonly child: ChildProcess;
  // Output not yet handed to the agent.
  unread: string;
  readonly closed: Promise<void>;
}

export interface StartRequest {
  readonly command: string;
  readonly description: string;
  readonly program: string;
  // The argv that runs the command, sandbox included (from the Bash tool's commandArgv).
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly tty: boolean;
  readonly waitMs: number;
}

export class Terminals {
  private readonly live = new Map<number, Live>();
  private nextId = 1;

  constructor(private readonly host: Host = currentHost()) {}

  // The pseudo-terminal comes from `script` (util-linux on Linux, BSD on macOS), so no native module is needed.
  // Without it (Windows, or a system without script), the command runs on plain pipes and the result says so.
  ptyAvailable(): boolean {
    return !isWindows(this.host.platform) && this.findScript() !== null;
  }

  async start(request: StartRequest): Promise<TerminalResult> {
    const pruned = this.prune();
    const [file, ...args] = request.argv;
    if (file === undefined) throw new Error("empty command");
    const script = request.tty ? this.findScript() : null;
    const spawnFile = script ?? file;
    const spawnArgs = script === null ? args : scriptArgs(this.host.platform, [file, ...args]);
    const session: TerminalSession = {
      id: this.nextId++,
      command: request.command,
      description: request.description,
      program: request.program,
      tty: script !== null,
      startedAt: Date.now(),
      lastUsed: Date.now(),
      status: "running",
      exitCode: null,
    };
    const child = spawn(spawnFile, spawnArgs, {
      cwd: request.cwd,
      env: { ...process.env, ...PLAIN_TERMINAL_ENV },
      ...treeSpawnOptions(this.host.platform),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let finish: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry: Live = { session, child, unread: "", closed };
    const collect = (chunk: Buffer) => {
      entry.unread = (entry.unread + chunk.toString("utf8")).slice(-MAX_BUFFER_CHARS);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.stdin?.on("error", () => undefined);
    child.once("error", (error) => {
      entry.unread += `\n${error.message}`;
      if (session.status === "running") session.status = "exited";
      finish();
    });
    child.once("close", (code) => {
      if (session.status === "running") session.status = "exited";
      session.exitCode = code;
      finish();
    });
    this.live.set(session.id, entry);
    const notes = [
      ...(request.tty && script === null ? ["no pseudo-terminal on this system: the command runs on plain pipes"] : []),
      ...(pruned === null ? [] : [pruned]),
    ];
    return this.collect(entry, clampWait(request.waitMs, MAX_WAIT_MS), notes.join("; ") || undefined);
  }

  // Writes the characters (an empty string only reads) and returns what the program printed since the last read.
  async write(id: number, input: string, waitMs: number): Promise<TerminalResult> {
    const entry = this.live.get(id);
    if (entry === undefined) throw new Error(`no terminal session ${id}; start one with action start`);
    entry.session.lastUsed = Date.now();
    if (input !== "") {
      if (entry.session.status !== "running") throw new Error(`terminal session ${id} has already ended (exit ${entry.session.exitCode ?? "unknown"})`);
      if (!entry.session.tty && input === "\u0003") {
        this.stop(id);
      } else {
        entry.child.stdin?.write(input);
      }
    }
    return this.collect(entry, clampWait(waitMs, input === "" ? MAX_POLL_WAIT_MS : MAX_WAIT_MS));
  }

  stop(id: number): boolean {
    const entry = this.live.get(id);
    if (entry === undefined || entry.session.status !== "running" || entry.child.pid === undefined) return false;
    entry.session.status = "stopped";
    const pid = entry.child.pid;
    try {
      killTree(pid, "SIGTERM", this.host.platform);
    } catch {
      return true;
    }
    if (!isWindows(this.host.platform)) {
      const force = setTimeout(() => {
        try {
          killTree(pid, "SIGKILL", this.host.platform);
        } catch {
          // Already gone.
        }
      }, KILL_AFTER_MS);
      force.unref();
    }
    return true;
  }

  stopAll(): void {
    for (const id of this.live.keys()) this.stop(id);
  }

  get(id: number): TerminalSession | undefined {
    return this.live.get(id)?.session;
  }

  list(): TerminalSession[] {
    return [...this.live.values()].map((entry) => entry.session);
  }

  // Waits until the deadline or until the program ends, whichever comes first, then hands over the unread output.
  private async collect(entry: Live, waitMs: number, note?: string): Promise<TerminalResult> {
    const started = Date.now();
    if (entry.session.status === "running") {
      await Promise.race([entry.closed, new Promise<void>((resolve) => setTimeout(resolve, waitMs).unref())]);
    }
    const raw = entry.unread;
    entry.unread = "";
    const output = limitOutput(collapseRepeats(stripAnsi(raw.replace(/\r\n/g, "\n"))).trimEnd(), MAX_RESULT_CHARS);
    if (entry.session.status !== "running") this.live.delete(entry.session.id);
    return {
      session: entry.session.id,
      status: entry.session.status,
      exitCode: entry.session.exitCode,
      output,
      waitedMs: Date.now() - started,
      ...(note === undefined ? {} : { note }),
    };
  }

  // At the limit, the least recently used session is stopped to make room, as in Codex.
  private prune(): string | null {
    const running = [...this.live.values()].filter((entry) => entry.session.status === "running");
    if (running.length < MAX_SESSIONS) return null;
    const oldest = running.sort((a, b) => a.session.lastUsed - b.session.lastUsed)[0];
    if (oldest === undefined) return null;
    this.stop(oldest.session.id);
    this.live.delete(oldest.session.id);
    return `terminal session ${oldest.session.id} (${oldest.session.command}) was stopped to stay under ${MAX_SESSIONS} sessions`;
  }

  private findScript(): string | null {
    for (const dir of (envValue(this.host.env, "PATH") ?? "").split(path.delimiter)) {
      if (dir === "" || !path.isAbsolute(dir)) continue;
      const candidate = path.join(dir, "script");
      if (this.host.isFile(candidate)) return candidate;
    }
    return null;
  }
}

function clampWait(ms: number, max: number): number {
  return Math.min(Math.max(ms, MIN_WAIT_MS), max);
}

// `script` runs the command inside a new pseudo-terminal and copies its output, without a log file.
// The terminal size is set first, so programs that read it lay their output out for 160 columns.
export function scriptArgs(platform: NodeJS.Platform, argv: readonly string[]): string[] {
  const command = `stty cols ${COLUMNS} rows ${ROWS} 2>/dev/null; exec ${argv.map(shellQuote).join(" ")}`;
  if (platform === "darwin") return ["-q", "/dev/null", "/bin/sh", "-c", command];
  return ["-q", "-f", "-e", "-E", "never", "-c", command, "/dev/null"];
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_\-./=:,@%+]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
