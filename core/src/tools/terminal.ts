import { z } from "zod";
import { programName } from "../policy/argv.js";
import { decideBash } from "../policy/decide.js";
import { parseShell } from "../shell.js";
import {
  DEFAULT_POLL_WAIT_MS,
  DEFAULT_START_WAIT_MS,
  DEFAULT_WRITE_WAIT_MS,
  MAX_POLL_WAIT_MS,
  MAX_WAIT_MS,
  MIN_WAIT_MS,
  type TerminalResult,
} from "../terminals.js";
import type { PolicyContext, Verdict } from "../types.js";
import { commandArgv } from "./bash.js";
import type { Tool } from "./registry.js";

// Programs whose input is itself commands. What the agent types into them is judged like a new command.
const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh", "ash", "ssh", "docker", "podman", "kubectl", "nix-shell", "su"]);
const INTERPRETERS = new Set([
  "python",
  "python3",
  "node",
  "deno",
  "bun",
  "irb",
  "ruby",
  "perl",
  "php",
  "lua",
  "R",
  "julia",
  "ghci",
  "psql",
  "mysql",
  "sqlite3",
  "redis-cli",
  "mongosh",
  "mongo",
  "iex",
  "erl",
  "scala",
  "clojure",
]);

const schema = z.object({
  action: z.enum(["start", "write", "stop", "list"]).describe("start runs a command in a terminal; write types into a running session (empty input only reads); stop ends a session; list shows the sessions."),
  command: z.string().min(1).optional().describe("start: the shell command, run from the project root."),
  description: z.string().max(200).optional().describe("start: one line explaining the goal. Shown in the approval prompt."),
  session: z.number().int().positive().optional().describe("write and stop: the session number that start returned."),
  input: z
    .string()
    .optional()
    .describe('write: the characters to type. End a line with "\\n". Control keys as escapes: "\\u0003" Ctrl+C, "\\u0004" Ctrl+D, "\\u001b" Esc. Empty or omitted only reads new output.'),
  wait_ms: z
    .number()
    .int()
    .min(MIN_WAIT_MS)
    .max(MAX_POLL_WAIT_MS)
    .optional()
    .describe(`How long to wait for output before answering. start: default ${DEFAULT_START_WAIT_MS}, up to ${MAX_WAIT_MS}. write: default ${DEFAULT_WRITE_WAIT_MS}; an empty read waits ${DEFAULT_POLL_WAIT_MS} by default, up to ${MAX_POLL_WAIT_MS}. A program that ends sooner answers at once.`),
  tty: z.boolean().optional().describe("start: run in a pseudo-terminal (default true). false uses plain pipes."),
});

function lastProgram(command: string): string {
  const segments = parseShell(command);
  const last = segments?.at(-1);
  return last === undefined ? "" : programName(last.argv[0]);
}

// Control characters and escape sequences of keys (arrows, function keys), with no printable text between them.
const CONTROL_ONLY = /^(?:\u001b\[[0-9;]*[A-Za-z~]|\u001bO[A-Za-z]|[\u0000-\u001f\u007f])+$/;

// What typing into a running session may do depends on the program behind it.
async function writePolicy(session: number | undefined, input: string, ctx: PolicyContext): Promise<Verdict> {
  if (session === undefined) return { level: 2, decision: "deny", reason: "write needs the session number" };
  const terminal = ctx.terminals?.get(session);
  if (terminal === undefined) return { level: 2, decision: "allow", reason: "reading a session that no longer exists reports it" };
  // Control keys (Ctrl+C, Ctrl+D, Esc, arrows) and plain reads change nothing by themselves.
  if (input === "" || CONTROL_ONLY.test(input)) {
    return { level: 2, decision: "allow", reason: "reading or a control key" };
  }
  const line = input.replace(/\r?\n$/, "");
  if (SHELLS.has(terminal.program)) {
    const verdict = await decideBash(line, ctx);
    return { ...verdict, reason: `typed into ${terminal.program} (session ${session}): ${verdict.reason}` };
  }
  if (INTERPRETERS.has(terminal.program)) {
    return { level: 3, decision: "ask_user", reason: `code typed into ${terminal.program} (session ${session}): ${line.slice(0, 200)}` };
  }
  return { level: 2, decision: "allow", reason: `answer typed into ${terminal.program || "the program"} (session ${session})` };
}

export const terminalTool: Tool<typeof schema> = {
  name: "Terminal",
  strict: false,
  description:
    "Runs a command in an interactive terminal and keeps it open. Use it for programs that ask questions, prompt for confirmation, run a REPL or a dev server you need to talk to, or when you must send Ctrl+C. start returns the output when the command ends within wait_ms; otherwise it returns a session number, and write sends input to it and returns only the new output. For a command that just runs and ends, use Bash.",
  schema,
  async policy(input, ctx) {
    if (input.action === "list") return { level: 2, decision: "allow", reason: "list terminal sessions" };
    if (input.action === "stop") return { level: 2, decision: "allow", reason: `stop terminal session ${input.session ?? "?"}` };
    if (input.action === "write") return writePolicy(input.session, input.input ?? "", ctx);
    if (input.command === undefined) return { level: 2, decision: "deny", reason: "start needs a command" };
    return decideBash(input.command, ctx);
  },
  async run(input, ctx) {
    const terminals = ctx.terminals;
    if (terminals === undefined) throw new Error("terminals are not available in this session");
    if (input.action === "list") {
      const sessions = terminals.list().map((session) => ({
        session: session.id,
        status: session.status,
        command: session.command,
        seconds: Math.round((Date.now() - session.startedAt) / 1000),
      }));
      return JSON.stringify({ sessions });
    }
    if (input.action === "stop") {
      if (input.session === undefined) throw new Error("stop needs the session number");
      if (!terminals.stop(input.session)) throw new Error(`terminal session ${input.session} is not running`);
      return JSON.stringify(view(await terminals.write(input.session, "", MIN_WAIT_MS)));
    }
    if (input.action === "write") {
      if (input.session === undefined) throw new Error("write needs the session number");
      const text = input.input ?? "";
      return JSON.stringify(view(await terminals.write(input.session, text, input.wait_ms ?? (text === "" ? DEFAULT_POLL_WAIT_MS : DEFAULT_WRITE_WAIT_MS))));
    }
    if (input.command === undefined) throw new Error("start needs a command");
    const result = await terminals.start({
      command: input.command,
      description: input.description ?? "",
      program: lastProgram(input.command),
      argv: commandArgv(input.command, ctx),
      cwd: ctx.root,
      tty: input.tty ?? true,
      waitMs: input.wait_ms ?? DEFAULT_START_WAIT_MS,
    });
    return JSON.stringify(view(result));
  },
};

function view(result: TerminalResult): Record<string, unknown> {
  return {
    session: result.session,
    status: result.status,
    ...(result.exitCode === null ? {} : { exit_code: result.exitCode }),
    ...(result.status === "running" ? { hint: `still running: Terminal write with session ${result.session} to send input or read more` } : {}),
    waited_ms: result.waitedMs,
    output: result.output,
    ...(result.note === undefined ? {} : { note: result.note }),
  };
}
