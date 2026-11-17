import type { Segment } from "../shell.js";
import { positional, programName } from "./argv.js";

type ArgsCheck = (args: readonly string[]) => boolean;

const forbidPrefix =
  (...prefixes: string[]): ArgsCheck =>
  (args) =>
    !args.some((arg) => prefixes.some((prefix) => arg.startsWith(prefix)));

const READ_PROGRAMS: Record<string, ArgsCheck> = {
  ls: () => true,
  cat: () => true,
  head: () => true,
  tail: () => true,
  wc: () => true,
  stat: () => true,
  pwd: () => true,
  diff: () => true,
  cut: () => true,
  grep: () => true,
  uniq: (args) => positional(args).length <= 1,
  file: forbidPrefix("-C", "--compile"),
  tree: forbidPrefix("-o"),
  sort: forbidPrefix("-o", "--output", "--compress-program"),
  rg: forbidPrefix("--pre"),
  find: forbidPrefix("-exec", "-ok", "-delete", "-fprint", "-fls"),
  cd: (args) => args.length <= 1,
};

const GIT_READ = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "branch"]);
const GIT_BRANCH_READ = new Set(["--list", "-l", "--show-current", "-a", "-r", "-v", "-vv", "--all", "--remotes"]);

export const GIT_NO_EXTERNAL_DIFF = new Set(["diff", "log", "show"]);

function gitAllowed(args: readonly string[]): boolean {
  const [sub, ...rest] = args;
  if (sub === undefined || !GIT_READ.has(sub)) return false;
  if (rest.some((arg) => arg.startsWith("--output") || arg.startsWith("--ext-diff"))) return false;
  if (sub === "branch") return rest.every((arg) => GIT_BRANCH_READ.has(arg));
  return true;
}

export function isReadOnlyCommand(segments: readonly Segment[]): boolean {
  return segments.every((segment) => {
    if (segment.redirects.length > 0) return false;
    if (segment.argv.some((word) => word.includes("$"))) return false;
    const program = programName(segment.argv[0]);
    const args = segment.argv.slice(1);
    if (program === "git") return segments.length === 1 && gitAllowed(args);
    if (!Object.hasOwn(READ_PROGRAMS, program)) return false;
    return READ_PROGRAMS[program]?.(args) ?? false;
  });
}
