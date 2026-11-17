import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { privateMode } from "./fs-atomic.js";
import { pathApi, projectKey } from "./paths.js";
import { isWindows } from "./platform.js";

// Working files live in the system temp folder, under a per-user name, like Claude Code does with /tmp/claude-<uid>.
// Each project and session gets its own folder, so a session's files never mix with another's.
const KEEP_DAYS = 30;

// Windows has no uid, so the folder takes the user name there.
export function scratchUserDir(platform: NodeJS.Platform = process.platform, tmp = tempDir(platform), user = userName(platform)): string {
  return pathApi(platform).join(tmp, `plif-${user}`);
}

// TEMP on Windows often holds a short 8.3 name (C:\Users\RUNNER~1). The policy compares real paths, so the long form is used.
function tempDir(platform: NodeJS.Platform): string {
  const tmp = os.tmpdir();
  if (!isWindows(platform)) return tmp;
  try {
    return realpathSync.native(tmp);
  } catch {
    return tmp;
  }
}

function userName(platform: NodeJS.Platform): string {
  if (!isWindows(platform)) return String(process.getuid?.() ?? "user");
  let name: string;
  try {
    name = os.userInfo().username;
  } catch {
    name = process.env.USERNAME ?? "";
  }
  return safeUserName(name);
}

export function safeUserName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe === "" ? "user" : safe;
}

export function scratchBase(projectRoot: string, platform: NodeJS.Platform = process.platform, userDir = scratchUserDir(platform)): string {
  const project = createHash("sha256").update(projectKey(projectRoot, platform)).digest("hex").slice(0, 12);
  return pathApi(platform).join(userDir, project);
}

// Images pasted before the session exists wait here, then move into the session on the first send.
export function stagingDir(projectRoot: string): string {
  return path.join(scratchBase(projectRoot), "staging");
}

export interface SessionScratch {
  readonly scratchpad: string;
  readonly images: string;
}

export function sessionScratch(projectRoot: string, sessionId: string): SessionScratch {
  const scratchpad = path.join(scratchBase(projectRoot), sessionId, "scratchpad");
  return { scratchpad, images: path.join(scratchpad, "images") };
}

export interface SessionFolders {
  readonly dir: string;
  // Deliverables: documents, pages and reports the person is meant to open.
  readonly artifacts: string;
  // Session memory, written by the agent and read back when the session resumes.
  readonly memory: string;
}

export function sessionFolders(sessionsDir: string, sessionId: string): SessionFolders {
  const dir = path.join(sessionsDir, sessionId);
  return { dir, artifacts: path.join(dir, "artifacts"), memory: path.join(dir, "Plif.md") };
}

export async function ensureDirs(...dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) await mkdir(dir, { recursive: true, mode: privateMode(0o700) });
}

// Removes the project folders untouched for 30 days, from the folder Plif owns in the temp dir.
export async function cleanOldScratch(userDir = scratchUserDir(), now = Date.now()): Promise<number> {
  const entries = await readdir(userDir).catch(() => [] as string[]);
  let removed = 0;
  for (const entry of entries) {
    const dir = path.join(userDir, entry);
    const info = await stat(dir).catch(() => null);
    if (info === null || now - info.mtimeMs < KEEP_DAYS * 86_400_000) continue;
    await rm(dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

export interface SessionRoots {
  // Where the file tools may read and write without asking: the scratchpad, the artifacts and the session memory file.
  readonly policy: readonly string[];
  // Folders the sandbox may write to. The session folder itself is never writable, since it holds the transcript.
  readonly sandbox: readonly string[];
}

export function sessionRoots(projectRoot: string, sessionsDir: string, sessionId: string): SessionRoots {
  const scratch = sessionScratch(projectRoot, sessionId);
  const folders = sessionFolders(sessionsDir, sessionId);
  return {
    policy: [scratch.scratchpad, folders.artifacts, folders.memory],
    sandbox: [scratch.scratchpad, folders.artifacts],
  };
}
