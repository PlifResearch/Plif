import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { type Host, currentHost, findOnPath, isWindows } from "./platform.js";
import { findGitBash } from "./shell.js";

const run = promisify(execFile);
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitSnapshot {
  readonly branch: string;
  readonly changes: readonly string[];
}

// On Windows git runs by its absolute path: a bare name would also find a git.exe in the project folder.
// Without git.exe on the PATH, the copy next to Git Bash (Git\bin\git.exe) serves.
export function gitProgram(host: Host = currentHost()): string | null {
  if (!isWindows(host.platform)) return "git";
  const onPath = findOnPath("git.exe", host);
  if (onPath !== null) return onPath;
  const bash = findGitBash(host);
  const sibling = bash === null ? null : path.win32.join(path.win32.dirname(bash), "git.exe");
  return sibling !== null && host.isFile(sibling) ? sibling : null;
}

// Runs git without a shell. Read commands disable the repository settings that could run external programs.
export async function git(root: string, args: readonly string[]): Promise<GitResult> {
  try {
    const program = gitProgram();
    if (program === null) throw new Error("git not found. Install Git for Windows (https://git-scm.com/downloads/win).");
    const { stdout, stderr } = await run(program, ["-c", "core.pager=cat", "-c", "core.fsmonitor=false", ...args], {
      cwd: root,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" },
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: failure.stdout ?? "", stderr: failure.stderr || failure.message || "git failed" };
  }
}

export async function gitSnapshot(root: string): Promise<GitSnapshot | null> {
  const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") return null;
  const branch = (await git(root, ["branch", "--show-current"])).stdout.trim() || "(detached)";
  const status = await git(root, ["status", "--porcelain=v1"]);
  const changes = status.stdout.split("\n").filter((line) => line !== "");
  return { branch, changes };
}

// --only commits just the named paths, even when other files are staged.
export function commitArgs(message: string, paths: readonly string[], coauthor: string | null): string[] {
  const args = ["commit", "--only", "-m", message];
  if (coauthor !== null) args.push("-m", `Co-authored-by: ${coauthor}`);
  return [...args, "--", ...paths];
}
