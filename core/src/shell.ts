import path from "node:path";
import { type Host, envValue, findOnPath, isWindows } from "./platform.js";

export interface Segment {
  readonly argv: readonly string[];
  readonly redirects: readonly string[];
}

export function parseShell(command: string): Segment[] | null {
  const segments: Segment[] = [];
  let argv: string[] = [];
  let redirects: string[] = [];
  let word = "";
  let inWord = false;
  let pendingRedirect = false;
  let failed = false;
  let quote: "'" | '"' | null = null;

  const add = (ch: string) => {
    word += ch;
    inWord = true;
  };
  const endWord = () => {
    if (!inWord) return;
    if (pendingRedirect) redirects.push(word);
    else argv.push(word);
    pendingRedirect = false;
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (pendingRedirect) failed = true;
    if (argv.length > 0 || redirects.length > 0) segments.push({ argv, redirects });
    argv = [];
    redirects = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? "";
    const next = command[i + 1];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else add(ch);
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "`" || (ch === "$" && next === "(")) return null;
      else if (ch === "\\" && next !== undefined && '"\\$`'.includes(next)) {
        add(next);
        i++;
      } else add(ch);
      continue;
    }
    if (ch === "`" || (ch === "$" && next === "(")) return null;
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === "\\") {
      if (next !== undefined) {
        add(next);
        i++;
      } else add(ch);
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    if (ch === "\n" || ch === ";") {
      endSegment();
      continue;
    }
    if (ch === "|") {
      endSegment();
      if (next === "|") i++;
      continue;
    }
    if (ch === "&") {
      if (next === ">") {
        endWord();
        pendingRedirect = true;
        i++;
        if (command[i + 1] === ">") i++;
      } else {
        endSegment();
        if (next === "&") i++;
      }
      continue;
    }
    if (ch === ">" || ch === "<") {
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      }
      endWord();
      pendingRedirect = true;
      if (next === ch) i++;
      if (command[i + 1] === "&") i++;
      continue;
    }
    add(ch);
  }

  if (quote !== null) return null;
  endSegment();
  return failed ? null : segments;
}

const GIT_BASH_HELP =
  "Install Git for Windows (https://git-scm.com/downloads/win) or set PLIF_GIT_BASH_PATH to the full path of its bash.exe.";

// The bash.exe in System32 or WindowsApps is WSL: it runs Linux and does not see Windows paths the same way.
function isWslDir(dir: string): boolean {
  const lower = path.win32.normalize(dir).toLowerCase().replace(/\\+$/, "");
  return lower.endsWith("\\system32") || lower.includes("\\windowsapps");
}

export function findGitBash(host: Host): string | null {
  const override = envValue(host.env, "PLIF_GIT_BASH_PATH");
  if (override !== undefined) {
    if (!path.win32.isAbsolute(override) || !host.isFile(override)) {
      throw new Error(`PLIF_GIT_BASH_PATH is ${override}, which is not the absolute path of a file. ${GIT_BASH_HELP}`);
    }
    return override;
  }
  const win = path.win32;
  const installs = [...new Set([
    envValue(host.env, "ProgramW6432"),
    envValue(host.env, "ProgramFiles"),
    "C:\\Program Files",
  ].filter((dir): dir is string => dir !== undefined))].map((dir) => win.join(dir, "Git", "bin", "bash.exe"));
  const localAppData = envValue(host.env, "LOCALAPPDATA");
  if (localAppData !== undefined) installs.push(win.join(localAppData, "Programs", "Git", "bin", "bash.exe"));
  const installed = installs.find((file) => host.isFile(file));
  if (installed !== undefined) return installed;

  const bash = findOnPath("bash.exe", host, isWslDir);
  if (bash !== null) return bash;
  // git.exe sits in Git\cmd or Git\bin, and bash.exe in Git\bin.
  const gitExe = findOnPath("git.exe", host, isWslDir);
  if (gitExe === null) return null;
  for (const candidate of [win.join(win.dirname(gitExe), "bash.exe"), win.join(win.dirname(gitExe), "..", "bin", "bash.exe")]) {
    if (host.isFile(candidate)) return candidate;
  }
  return null;
}

// The program that runs a command line: /bin/sh on Unix, Git Bash on Windows, so the parser and the policy apply to both.
export function shellFor(host: Host): string {
  if (!isWindows(host.platform)) return "/bin/sh";
  const bash = findGitBash(host);
  if (bash === null) throw new Error(`Git Bash not found. ${GIT_BASH_HELP}`);
  return bash;
}
