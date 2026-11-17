import { z } from "zod";
import { execute } from "../exec.js";
import { GIT_NO_EXTERNAL_DIFF, isReadOnlyCommand } from "../policy/allowlist.js";
import { programName } from "../policy/argv.js";
import { gitProgram } from "../git.js";
import { type Host, currentHost, isWindows } from "../platform.js";
import { decideBash } from "../policy/decide.js";
import { collapseRepeats, stripAnsi } from "../output.js";
import { sandboxPrefix } from "../sandbox.js";
import { type Segment, parseShell, shellFor } from "../shell.js";
import type { ToolContext } from "../types.js";
import type { Tool } from "./registry.js";

export function sandboxHint(output: string, settings: { readonly readOnly: boolean; readonly network: "allow" | "deny" } | null): string {
  if (settings === null) return "";
  if (settings.network === "deny" && /could not resolve host|network is unreachable|temporary failure in name resolution/i.test(output)) {
    return "\n[sandbox] network blocked: sandbox.network is set to deny in config.toml";
  }
  if (settings.readOnly && /read-only file system|permission denied/i.test(output)) {
    return "\n[sandbox] read-only: sandbox_mode is set to read-only in config.toml";
  }
  return "";
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 30_000;

const schema = z.object({
  command: z.string().min(1).describe("Shell command, run from the project root."),
  description: z.string().min(1).max(200).describe("One line explaining the goal. Shown in the approval prompt."),
  timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe("Maximum time in milliseconds."),
});

// On Windows /dev/null is not a folder name git can rely on. NUL is a reserved name, so no folder can take it.
function noHooksPath(platform: NodeJS.Platform): string {
  return isWindows(platform) ? "NUL" : "/dev/null";
}

export function buildArgv(command: string, segments: readonly Segment[] | null, readOnly: boolean, host: Host = currentHost()): string[] {
  const single = segments?.length === 1 ? segments[0] : undefined;
  const git = single !== undefined && readOnly && programName(single.argv[0]) === "git" ? gitProgram(host) : null;
  if (single !== undefined && git !== null) {
    const [sub, ...rest] = single.argv.slice(1);
    const extra = sub !== undefined && GIT_NO_EXTERNAL_DIFF.has(sub) ? ["--no-ext-diff"] : [];
    const settings = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${noHooksPath(host.platform)}`, "-c", "core.pager=cat"];
    return [git, ...settings, ...(sub === undefined ? [] : [sub]), ...extra, ...rest];
  }
  return [shellFor(host), "-c", command];
}

// The argv that runs a command: sandbox first when it is on, the command itself last.
export function commandArgv(command: string, ctx: ToolContext, host: Host = currentHost()): string[] {
  const segments = parseShell(command);
  const readOnly = segments !== null && isReadOnlyCommand(segments);
  const argv = buildArgv(command, segments, readOnly, host);
  const settings = ctx.sandbox === null ? null : { ...ctx.sandbox, readOnly: ctx.mode.readOnly };
  return settings === null ? argv : [...sandboxPrefix(ctx.root, settings), ...argv];
}

export const bashTool: Tool<typeof schema> = {
  name: "Bash",
  description:
    "Runs a shell command from the project root, for builds, tests and read-only Git commands. To read or search files, prefer Read and Glob.",
  schema,
  policy: (input, ctx) => decideBash(input.command, ctx),
  async run(input, ctx) {
    const [file, ...args] = commandArgv(input.command, ctx);
    const settings = ctx.sandbox === null ? null : { ...ctx.sandbox, readOnly: ctx.mode.readOnly };
    if (file === undefined) throw new Error("empty command");

    const result = await execute(file, args, {
      cwd: ctx.root,
      env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
      maxBytes: MAX_OUTPUT_BYTES,
    });
    const status = result.timedOut ? "timed out" : `exit code ${result.code ?? "unknown"}`;
    const output = collapseRepeats(stripAnsi(result.output));
    return `${status}\n${output}${sandboxHint(result.output, settings)}`.trimEnd();
  },
};
