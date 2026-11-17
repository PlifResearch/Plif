import { z } from "zod";
import type { Tool } from "./registry.js";

const STATUSES = ["pending", "in_progress", "done", "blocked"] as const;
type Status = (typeof STATUSES)[number];

const MARK: Record<Status, string> = { pending: "[ ]", in_progress: "[~]", done: "[x]", blocked: "[!]" };
const MAX_STEPS = 20;

interface Step {
  text: string;
  status: Status;
  note: string;
}

interface Plan {
  title: string;
  steps: Step[];
}

// Plans live with the process that made them. A resumed session shows the earlier plan in its transcript, not here.
const plans = new Map<string, Plan>();

const schema = z.object({
  action: z.enum(["create", "update", "show"]).describe(
    "create: creates the plan for the large task. update: changes the status of one step. show: shows the current plan.",
  ),
  title: z.string().describe("Plan title. Required in create. In update and show, use an empty string."),
  steps: z
    .array(z.string())
    .describe("Steps, in execution order, 2 to 20 items. Required in create. In update and show, use an empty list."),
  step: z.number().int().describe("Step number, starting at 1, in update. In create and show, use 0."),
  status: z.enum(STATUSES).describe("New status in update: pending, in_progress, done or blocked. In create and show, use pending."),
  note: z.string().describe("Reason or result of the step in update, in one sentence. In create and show, use an empty string."),
});

export const planTool: Tool<typeof schema> = {
  name: "Plan",
  strict: false,
  description:
    "Plans and tracks large or complex tasks: work in several parts, a fix that spans several files, or a request with dependent steps. Do not use it for short tasks that take a few steps. Only one step is in_progress at a time, and each finished step becomes done with a one-sentence result.",
  schema,
  policy: async () => ({ level: 2, decision: "allow", reason: "plan kept in memory only, no effect outside the session" }),
  async run(input, ctx) {
    if (input.action === "create") {
      if (input.title.trim() === "") throw new Error("create requires a title");
      if (input.steps.length < 2 || input.steps.length > MAX_STEPS) {
        throw new Error(`a plan needs 2 to ${MAX_STEPS} steps; for a short task, do not use Plan`);
      }
      const plan: Plan = {
        title: input.title.trim(),
        steps: input.steps.map((text) => ({ text: text.trim(), status: "pending", note: "" })),
      };
      plans.set(ctx.session, plan);
      return render(plan);
    }

    const plan = plans.get(ctx.session);
    if (plan === undefined) throw new Error("there is no plan in this session; use create before update");
    if (input.action === "show") return render(plan);

    const index = input.step - 1;
    const step = plan.steps[index];
    if (step === undefined) throw new Error(`step ${input.step} does not exist`);
    if (input.status === "in_progress") {
      const busy = plan.steps.findIndex((item, position) => position !== index && item.status === "in_progress");
      if (busy !== -1) throw new Error(`step ${busy + 1} is already in progress; finish or block it first`);
    }
    step.status = input.status;
    step.note = input.note.trim();
    return render(plan);
  },
};

function render(plan: Plan): string {
  const lines = plan.steps.map((step, index) => {
    const note = step.note === "" ? "" : ` (${step.note})`;
    return `${index + 1}. ${MARK[step.status]} ${step.text}${note}`;
  });
  const done = plan.steps.filter((step) => step.status === "done").length;
  return [`Plan: ${plan.title} (${done}/${plan.steps.length} done)`, ...lines].join("\n");
}
