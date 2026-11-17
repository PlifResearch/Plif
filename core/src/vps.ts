import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeAtomic } from "./fs-atomic.js";
import { expandHome } from "./paths.js";
import { execute } from "./exec.js";
import { type Host, currentHost, findOnPath, isWindows, windowsSystemDir } from "./platform.js";
import { findGitBash } from "./shell.js";

// VPS access is key-based only. The config keeps the path of the key, never its contents, and never a password.
const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*|[0-9.]+|[0-9a-fA-F:]+)$/;

const VPS = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  host: z.string().regex(HOST).max(253),
  user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).default("root"),
  port: z.number().int().min(1).max(65535).default(22),
  keyPath: z.string().min(1),
});

const FILE = z.object({ vps: z.array(VPS).default([]) });

export type Vps = z.infer<typeof VPS>;

export function expandKeyPath(keyPath: string, home: string, platform: NodeJS.Platform = process.platform): string {
  return expandHome(keyPath, home, platform);
}

export async function loadVpsList(file: string): Promise<Vps[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return FILE.parse(JSON.parse(text)).vps;
}

export async function saveVpsList(file: string, list: readonly Vps[]): Promise<void> {
  await writeAtomic(file, `${JSON.stringify({ vps: list }, null, 2)}\n`);
}

// Checks what ssh needs before connecting. ssh itself refuses keys that other users can read.
export async function checkKey(keyPath: string, home: string, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const resolved = expandKeyPath(keyPath, home, platform);
  if (!path.isAbsolute(resolved)) return ["the key path must be absolute or start with ~/"];
  let info;
  try {
    info = await stat(resolved);
  } catch {
    return [`key not found: ${resolved}`];
  }
  if (!info.isFile()) return [`not a file: ${resolved}`];
  // Windows reports synthetic mode bits. OpenSSH checks the key's actual ACL when testConnection runs.
  if (!isWindows(platform) && (info.mode & 0o077) !== 0) return [`the key is readable by others; run chmod 600 ${resolved}`];
  return [];
}

export function sshArgs(vps: Vps, home: string): string[] {
  return [
    "-i",
    expandKeyPath(vps.keyPath, home),
    "-p",
    String(vps.port),
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ConnectTimeout=10",
    // accept-new records a host the first time it is seen and refuses it if the key later changes.
    "-o",
    "StrictHostKeyChecking=accept-new",
    `${vps.user}@${vps.host}`,
  ];
}

export function sshProgram(host: Host = currentHost()): string | null {
  if (!isWindows(host.platform)) return "ssh";
  const system = path.win32.join(windowsSystemDir(host.env), "OpenSSH", "ssh.exe");
  if (host.isFile(system)) return system;
  const onPath = findOnPath("ssh.exe", host);
  if (onPath !== null) return onPath;
  const bash = findGitBash(host);
  if (bash === null) return null;
  const bundled = path.win32.join(path.win32.dirname(bash), "..", "usr", "bin", "ssh.exe");
  return host.isFile(bundled) ? bundled : null;
}

export async function testConnection(vps: Vps, home: string): Promise<{ ok: boolean; message: string }> {
  try {
    const program = sshProgram();
    if (program === null) return { ok: false, message: "ssh is not installed" };
    const result = await execute(program, [...sshArgs(vps, home), "true"], { cwd: process.cwd(), timeoutMs: 20_000, maxBytes: 2_000 });
    if (result.timedOut) return { ok: false, message: "ssh connection timed out" };
    return result.code === 0
      ? { ok: true, message: "connected" }
      : { ok: false, message: result.output.trim().split(/\r?\n/).at(-1) || `ssh exited with ${result.code}` };
  } catch {
    return { ok: false, message: "could not start ssh" };
  }
}

export function commandTemplate(vps: Vps, home: string): string {
  const parts = sshArgs(vps, home).map((part) => (/^[A-Za-z0-9_./:@=+-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`));
  return `ssh ${parts.join(" ")} '<command>'`;
}

// Block added to the system prompt while the VPS is on for this session.
export function vpsBlock(vps: Vps, home: string): string {
  return [
    "<vps>",
    `name: ${vps.name}`,
    `host: ${vps.host} · user: ${vps.user} · port: ${vps.port}`,
    `Run remote commands through Bash with this form: ${commandTemplate(vps, home)}`,
    "Never print the key or read the key file. Each remote command is reviewed by the classifier; a refusal is final for that command.",
    "</vps>",
  ].join("\n");
}

// The classifier needs to know the host is authorized, so the review can allow commands that target it.
export function vpsPolicyLine(vps: Vps): string {
  return `Authorized remote host for this session: ${vps.user}@${vps.host}:${vps.port} (name ${vps.name}, key authentication). Commands that target it are in scope.`;
}


export interface VpsDraftInput {
  readonly name: string;
  readonly host: string;
  readonly user: string;
  readonly port: string;
  readonly keyPath: string;
}

// Validates what the form typed. Errors are short sentences for the screen.
export function vpsFromDraft(draft: VpsDraftInput): Vps {
  const parsed = VPS.safeParse({ ...draft, port: Number(draft.port) });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw new Error(`invalid ${String(field ?? "value")}: check the format`);
  }
  return parsed.data;
}
