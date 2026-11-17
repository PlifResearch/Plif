import { spawn } from "node:child_process";
import path from "node:path";
import { isWindows, windowsSystemDir } from "./platform.js";

export interface ExecOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly platform?: NodeJS.Platform;
}

export interface ExecResult {
  readonly code: number | null;
  readonly output: string;
  readonly timedOut: boolean;
}

// On Unix the child leads its own process group, so killTree reaches what it started. On Windows a detached
// child opens a console window of its own, and taskkill /T follows the tree without a group.
export function treeSpawnOptions(platform: NodeJS.Platform): { readonly detached: boolean; readonly windowsHide: true } {
  return { detached: !isWindows(platform), windowsHide: true };
}

export function taskkillArgv(pid: number, env: NodeJS.ProcessEnv): string[] {
  return [path.win32.join(windowsSystemDir(env), "taskkill.exe"), "/pid", String(pid), "/T", "/F"];
}

// Ends the process and its children. On Unix it throws when the group is already gone. On Windows taskkill
// always forces, so the signal only matters on Unix.
export function killTree(pid: number, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  if (!isWindows(platform)) {
    process.kill(-pid, signal);
    return;
  }
  const [file, ...args] = taskkillArgv(pid, process.env);
  const killer = spawn(file ?? "taskkill.exe", args, { stdio: "ignore", windowsHide: true });
  killer.once("error", () => undefined);
}

export function execute(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
  const platform = options.platform ?? process.platform;
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      ...treeSpawnOptions(platform),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let truncated = false;
    let timedOut = false;

    const collect = (chunk: Buffer) => {
      if (output.length >= options.maxBytes) {
        truncated = true;
        return;
      }
      output += chunk.toString("utf8");
      if (output.length > options.maxBytes) {
        output = output.slice(0, options.maxBytes);
        truncated = true;
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          killTree(child.pid, "SIGKILL", platform);
        } catch {
          return;
        }
      }
    }, options.timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: truncated ? `${output}\n[output cut]` : output, timedOut });
    });
  });
}
