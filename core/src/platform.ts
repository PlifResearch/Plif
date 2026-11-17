import { statSync } from "node:fs";
import path from "node:path";

// What platform code reads from the machine. Tests pass a fake one to cover Windows on Linux.
export interface Host {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly isFile: (file: string) => boolean;
}

export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

export function currentHost(): Host {
  return { platform: process.platform, env: process.env, isFile };
}

function isFile(file: string): boolean {
  return statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
}

// Windows variable names ignore case, but a copy of process.env (or a test object) does not.
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((entry) => entry.toUpperCase() === name.toUpperCase());
  const value = key === undefined ? undefined : env[key];
  return value === "" ? undefined : value;
}

export function windowsSystemDir(env: NodeJS.ProcessEnv): string {
  return path.win32.join(envValue(env, "SystemRoot") ?? "C:\\Windows", "System32");
}

// On Windows, spawning a bare name also searches the working directory, which is the project. A repository
// could ship its own git.exe there. This lookup only takes absolute PATH entries.
export function findOnPath(program: string, host: Host, skip: (dir: string) => boolean = () => false): string | null {
  for (const dir of pathEntries(host)) {
    if (skip(dir)) continue;
    const candidate = path.win32.join(dir, program);
    if (host.isFile(candidate)) return candidate;
  }
  return null;
}

function pathEntries(host: Host): string[] {
  return (envValue(host.env, "PATH") ?? "")
    .split(";")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry !== "" && path.win32.isAbsolute(entry));
}
