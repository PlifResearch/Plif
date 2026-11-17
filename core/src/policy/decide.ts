import { stat } from "node:fs/promises";
import { isInside, isPlifConfig, pathScope, resolveReal } from "../paths.js";
import { isWindows } from "../platform.js";
import { containsSecret } from "../secrets.js";
import { parseShell } from "../shell.js";
import type { PolicyContext, Verdict } from "../types.js";
import { isReadOnlyCommand } from "./allowlist.js";
import { programName } from "./argv.js";
import { hardDenyReason } from "./hard-deny.js";

const allow = (level: 1 | 2, reason: string): Verdict => ({ level, decision: "allow", reason });
const ask = (reason: string): Verdict => ({ level: 3, decision: "ask_user", reason });
const deny = (level: 0 | 2, reason: string): Verdict => ({ level, decision: "deny", reason });

export async function decideBash(command: string, ctx: PolicyContext, platform: NodeJS.Platform = process.platform): Promise<Verdict> {
  const denied = hardDenyReason(command, { root: ctx.root, home: ctx.home, platform });
  if (denied !== null) return deny(0, denied);
  if (containsSecret(command)) return ask("the command contains something that looks like a secret");

  const segments = parseShell(command);
  if (segments === null) return ask("command Plif cannot parse safely");

  const readOnlyCommand = isReadOnlyCommand(segments);
  if (ctx.readOnly === true && !readOnlyCommand) return deny(2, "read-only mode: the command changes the project");
  if (ctx.sandboxed !== true) return ask("no sandbox available: the command needs approval");

  for (const segment of segments) {
    for (const word of [...segment.argv.slice(1), ...segment.redirects]) {
      if (word.startsWith("-")) {
        if ((isWindows(platform) ? /[\/\\~$%]|[a-zA-Z]:/ : /[\/~$]/).test(word)) return ask(`option with a path or variable: ${word}`);
        continue;
      }
      const real = await resolveReal(word, ctx.root, ctx.home, platform);
      const scope = pathScope(real, ctx.root, platform);
      if (scope !== "inside" && !inScratch(real, ctx, platform)) {
        return ask(`argument points to path ${label(scope)}: ${word}`);
      }
    }
  }

  for (const segment of segments) {
    if (await searchesDirectories(segment.argv, ctx, platform)) {
      return ask("recursive search may read protected files; name specific files or use Grep");
    }
  }

  if (readOnlyCommand) return allow(1, "read allowed by the allowlist");
  return ask("command outside the read allowlist");
}

async function searchesDirectories(argv: readonly string[], ctx: PolicyContext, platform: NodeJS.Platform): Promise<boolean> {
  const program = programName(argv[0]);
  const args = argv.slice(1);
  if (program !== "grep" && program !== "rg") return false;
  const recursive = program === "rg" || args.some((arg) => /^-[A-Za-z]*[rR]/.test(arg) || arg === "--recursive");
  if (!recursive) return false;

  const explicitPattern = args.some((arg) => arg === "-e" || arg === "-f" || arg.startsWith("--regexp") || arg.startsWith("--file"));
  const words = args.filter((arg) => !arg.startsWith("-"));
  const targets = explicitPattern ? words : words.slice(1);
  if (targets.length === 0) return true;
  for (const target of targets) {
    const info = await stat(await resolveReal(target, ctx.root, ctx.home, platform)).catch(() => null);
    if (info === null || info.isDirectory()) return true;
  }
  return false;
}

export async function decideFileAccess(
  target: string,
  mode: "read" | "write",
  ctx: PolicyContext,
  platform: NodeJS.Platform = process.platform,
): Promise<Verdict> {
  if (mode === "write" && ctx.readOnly === true) return deny(2, "read-only mode");
  const real = await resolveReal(target, ctx.root, ctx.home, platform);
  if (mode === "write" && isPlifConfig(real, ctx.root, ctx.home, platform)) {
    return deny(0, "the Plif configuration cannot be changed by the agent");
  }
  const scope = pathScope(real, ctx.root, platform);
  if (scope === "inside") return allow(2, mode === "read" ? "read inside the project" : "write inside the project");
  if (inScratch(real, ctx, platform)) return allow(2, "scratch, artifact or session memory");
  return ask(`path ${label(scope)}: ${real}`);
}

export async function decideGlob(
  pattern: string,
  base: string,
  ctx: PolicyContext,
  platform: NodeJS.Platform = process.platform,
): Promise<Verdict> {
  if (pattern.startsWith("/") || pattern.startsWith("~") || pattern.split(/[\\/]/).includes("..")) {
    return ask("pattern leaves the project directory");
  }
  // A drive letter or a leading \ (root of the drive, UNC share) leaves the project on Windows.
  if (isWindows(platform) && (/^[a-zA-Z]:/.test(pattern) || pattern.startsWith("\\"))) {
    return ask("pattern leaves the project directory");
  }
  return decideFileAccess(base, "read", ctx, platform);
}

// The scratchpad, the artifacts and the session memory are the session's own files, so they need no approval.
function inScratch(real: string, ctx: PolicyContext, platform: NodeJS.Platform): boolean {
  return (ctx.scratchRoots ?? []).some((root) => isInside(root, real, platform));
}

function label(scope: "inside" | "outside" | "protected"): string {
  return scope === "outside" ? "outside the project" : "protected";
}
