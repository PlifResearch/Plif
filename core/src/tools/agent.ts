import { z } from "zod";
import { SUBAGENT_TYPES, subagentLabel } from "../subagents.js";
import type { Tool } from "./registry.js";

const schema = z.object({
  description: z.string().min(1).describe("3 to 6 words about the task. Shown on screen next to the subagent."),
  prompt: z.string().min(1).describe("Full instructions: goal, scope and report format. The subagent cannot see this conversation."),
  subagent_type: z
    .enum(SUBAGENT_TYPES)
    .describe("explore: reading and searching in volume, read only, cheap model. general: multi-step task, may edit files."),
});

export const agentTool: Tool<typeof schema> = {
  name: "Agent",
  strict: false,
  description:
    "Starts a subagent in the background, with isolated context. The call returns at once; the final report arrives later as a notice. Do not wait in a loop: keep going with what does not depend on it.",
  schema,
  policy: () => Promise.resolve({ level: 2 as const, decision: "allow" as const, reason: "subagent with the same permissions as the session" }),
  async run(input, ctx) {
    if (ctx.subagents === undefined) throw new Error("subagents are not available in this context");
    const agent = ctx.subagents.start({ type: input.subagent_type, description: input.description, prompt: input.prompt });
    return `${subagentLabel(agent)} #${agent.id} started in the background: ${input.description}. The report arrives as a notice when it finishes.`;
  },
};
