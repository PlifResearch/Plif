import path from "node:path";
import { z } from "zod";
import { commitArgs, git, type GitResult } from "../git.js";
import { resolveReal } from "../paths.js";
import { decideFileAccess } from "../policy/decide.js";
import type { PolicyContext, Verdict } from "../types.js";
import type { Tool } from "./registry.js";

// Every field is required, so the tool adds nothing to the optional-parameter budget of strict schemas.
const schema = z.object({
  action: z.enum(["status", "diff", "log", "commit"]).describe("status, diff and log only read. commit needs approval."),
  path: z.string().describe("Diff only: file or folder relative to the project. Empty string shows everything."),
  staged: z.boolean().describe("Diff only: true shows staged changes, false shows unstaged changes."),
  count: z.number().int().min(1).max(50).describe("Log only: number of commits, from 1 to 50. Use 10 when unsure."),
  message: z.string().describe("Commit only: one short imperative line. Empty string for other actions."),
  paths: z.array(z.string()).describe("Commit only: files to commit, relative to the project. Empty array for other actions."),
});

type Input = z.infer<typeof schema>;

export const gitTool: Tool<typeof schema> = {
  name: "Git",
  description:
    "Reads the repository state (status, diff, log) and creates a commit for the given files. Commits always wait for the user's approval.",
  schema,
  async policy(input, ctx): Promise<Verdict> {
    if (input.action === "status" || input.action === "log") {
      return { level: 1, decision: "allow", reason: `git ${input.action}` };
    }
    if (input.action === "diff") {
      if (input.path === "") return { level: 1, decision: "allow", reason: "git diff" };
      return decideFileAccess(input.path, "read", ctx);
    }
    if (input.message.trim() === "" || input.paths.length === 0) {
      return { level: 2, decision: "deny", reason: "commit needs a message and at least one file" };
    }
    if (input.message.includes("\n")) {
      return { level: 2, decision: "deny", reason: "commit message must be one line" };
    }
    for (const file of input.paths) {
      if (!(await insideRoot(file, ctx))) {
        return { level: 2, decision: "deny", reason: "commit only takes files inside the project" };
      }
      const verdict = await decideFileAccess(file, "write", ctx);
      if (verdict.decision !== "allow") return verdict;
    }
    return {
      level: 3,
      decision: "ask_user",
      reason: `commit of ${input.paths.length} file(s): ${input.message}`,
    };
  },
  async run(input: Input, ctx) {
    switch (input.action) {
      case "status":
        return text(await git(ctx.root, ["status", "--porcelain=v1", "--branch"]), "clean working tree");
      case "diff": {
        const args = ["diff", "--no-ext-diff", "--no-color"];
        if (input.staged) args.push("--cached");
        if (input.path !== "") args.push("--", input.path);
        return text(await git(ctx.root, args), "no changes");
      }
      case "log":
        return text(await git(ctx.root, ["log", "--oneline", "--no-color", "-n", String(input.count)]), "no commits");
      case "commit": {
        const relative = await Promise.all(
          input.paths.map(async (file) => path.relative(ctx.root, await resolveReal(file, ctx.root, ctx.home))),
        );
        const add = await git(ctx.root, ["add", "--", ...relative]);
        if (!add.ok) throw new Error(add.stderr.trim());
        const commit = await git(ctx.root, commitArgs(input.message, relative, ctx.coauthor ?? null));
        if (!commit.ok) throw new Error(commit.stderr.trim() || "commit failed");
        const head = await git(ctx.root, ["log", "-1", "--format=%h %s"]);
        return `committed ${head.stdout.trim()}`;
      }
    }
  },
};

async function insideRoot(file: string, ctx: PolicyContext): Promise<boolean> {
  const relative = path.relative(ctx.root, await resolveReal(file, ctx.root, ctx.home));
  return relative !== "" && relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative);
}

function text(result: GitResult, empty: string): string {
  if (!result.ok) throw new Error(result.stderr.trim() || "git failed");
  return result.stdout.trim() || empty;
}
