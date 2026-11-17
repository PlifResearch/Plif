import { type ChildProcess, spawn } from "node:child_process";
import { killTree, treeSpawnOptions } from "./exec.js";
import { isWindows } from "./platform.js";

export type TaskStatus = "running" | "done" | "failed" | "stopped";

export interface Task {
  readonly id: number;
  readonly command: string;
  readonly description: string;
  readonly startedAt: number;
  endedAt: number | null;
  status: TaskStatus;
  exitCode: number | null;
  // The end of the output. Only the newest characters are kept, so a chatty command cannot fill the memory.
  tail: string;
}

export interface TaskEvent {
  readonly kind: "started" | "finished";
  readonly task: Task;
}

export interface StartOptions {
  readonly command: string;
  readonly description: string;
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

const TAIL_CHARS = 16_000;
const MAX_RUNNING = 8;
const MAX_RUN_MS = 30 * 60_000;
const KILL_AFTER_MS = 3_000;

export class BackgroundTasks {
  private readonly tasks = new Map<number, Task>();
  private readonly children = new Map<number, ChildProcess>();
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private nextId = 1;

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly kill: typeof killTree = killTree,
  ) {}

  start(options: StartOptions): Task {
    if (this.running().length >= MAX_RUNNING) {
      throw new Error(`there are already ${MAX_RUNNING} background tasks; stop one first`);
    }
    const task: Task = {
      id: this.nextId++,
      command: options.command,
      description: options.description,
      startedAt: Date.now(),
      endedAt: null,
      status: "running",
      exitCode: null,
      tail: "",
    };
    this.tasks.set(task.id, task);

    const child = spawn(options.file, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      ...treeSpawnOptions(this.platform),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.set(task.id, child);
    const collect = (chunk: Buffer) => {
      task.tail = (task.tail + chunk.toString("utf8")).slice(-TAIL_CHARS);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const limit = setTimeout(() => this.stop(task.id), MAX_RUN_MS);
    child.once("error", (error) => {
      clearTimeout(limit);
      task.tail += `\n${error.message}`;
      this.finish(task, null, "failed");
    });
    child.once("close", (code) => {
      clearTimeout(limit);
      this.finish(task, code, code === 0 ? "done" : "failed");
    });

    this.emit({ kind: "started", task });
    return task;
  }

  // Stops the whole process tree, so the shell and what it started end together. Windows has no graceful
  // signal for console programs, so taskkill forces at once and there is nothing to escalate.
  stop(id: number): boolean {
    const task = this.tasks.get(id);
    const child = this.children.get(id);
    if (task === undefined || task.status !== "running" || child?.pid === undefined) return false;
    task.status = "stopped";
    const pid = child.pid;
    try {
      this.kill(pid, "SIGTERM", this.platform);
    } catch {
      return true;
    }
    if (isWindows(this.platform)) return true;
    const force = setTimeout(() => {
      try {
        this.kill(pid, "SIGKILL", this.platform);
      } catch {
        // The group is already gone.
      }
    }, KILL_AFTER_MS);
    child.once("close", () => clearTimeout(force));
    return true;
  }

  stopAll(): void {
    for (const task of this.running()) this.stop(task.id);
  }

  get(id: number): Task | undefined {
    return this.tasks.get(id);
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  running(): Task[] {
    return this.list().filter((task) => task.status === "running");
  }

  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private finish(task: Task, code: number | null, status: "done" | "failed"): void {
    if (task.status === "running") task.status = status;
    task.exitCode = code;
    task.endedAt ??= Date.now();
    this.children.delete(task.id);
    this.emit({ kind: "finished", task });
  }

  private emit(event: TaskEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export function elapsedMs(task: Task, now = Date.now()): number {
  return Math.max(0, (task.endedAt ?? now) - task.startedAt);
}

export function describeTask(task: Task, now = Date.now()): string {
  const seconds = Math.round(elapsedMs(task, now) / 1000);
  const exit = task.exitCode === null ? "" : ` · exit ${task.exitCode}`;
  return `#${task.id} ${task.status} · ${seconds}s${exit} · ${task.command}`;
}

// The notice names the task and its outcome. The output stays out of it: the agent reads it with Monitor read.
export function completionNotice(task: Task): string {
  const seconds = Math.round(elapsedMs(task) / 1000);
  const exit = task.exitCode === null ? "" : ` code="${task.exitCode}"`;
  return `<task id="${task.id}" status="${task.status}"${exit} duration="${seconds}s">${task.command}</task>\nRead the output with Monitor (action read) if you need it.`;
}
