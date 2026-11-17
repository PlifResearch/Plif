import { z } from "zod";
import { type Task, describeTask } from "../tasks.js";
import { decideBash } from "../policy/decide.js";
import { limitOutput } from "../output.js";
import { commandArgv } from "./bash.js";
import type { Tool } from "./registry.js";

const schema = z.object({
  action: z.enum(["start", "read", "stop", "list"]).describe(
    "start: runs the command in the background and notifies you when it finishes. read: status and end of a task's output. stop: stops a task. list: lists the session's tasks.",
  ),
  command: z.string().describe("Shell command, from the project root. Required in start; empty string otherwise."),
  description: z.string().describe("One line with the goal. Required in start; empty string otherwise."),
  task: z.number().int().describe("Task number in read and stop. Use 0 otherwise."),
});

export const monitorTool: Tool<typeof schema> = {
  name: "Monitor",
  strict: false,
  description:
    "Runs long commands (builds, test suites, a test server) in the background without blocking the conversation. You get a notice when the task finishes. Do not poll in a loop: use read only when you need the output.",
  schema,
  policy: (input, ctx) =>
    input.action === "start"
      ? decideBash(input.command, ctx)
      : Promise.resolve({ level: 2 as const, decision: "allow" as const, reason: "read or stop of a session task" }),
  async run(input, ctx) {
    const tasks = ctx.tasks;
    if (tasks === undefined) throw new Error("background tasks are not available in this session");

    if (input.action === "list") {
      const all = tasks.list();
      return all.length === 0 ? "(no tasks in this session)" : all.map((task) => describeTask(task)).join("\n");
    }
    if (input.action === "start") {
      if (input.command.trim() === "") throw new Error("start exige command");
      const [file, ...args] = commandArgv(input.command, ctx);
      if (file === undefined) throw new Error("empty command");
      const task = tasks.start({
        command: input.command,
        description: input.description,
        file,
        args,
        cwd: ctx.root,
        env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
      });
      return `task #${task.id} started in the background: ${input.description}. You get a notice when it finishes.`;
    }

    const task: Task | undefined = tasks.get(input.task);
    if (task === undefined) throw new Error(`task ${input.task} does not exist`);
    if (input.action === "stop") {
      return tasks.stop(task.id) ? `task #${task.id} stopped` : `task #${task.id} had already finished`;
    }
    return `${describeTask(task)}\n${limitOutput(task.tail, 8_000)}`.trimEnd();
  },
};
