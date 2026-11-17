import type Anthropic from "@anthropic-ai/sdk";
import type { Summarize } from "./context.js";
import type { ModelClient } from "./model.js";
import { limitOutput } from "./output.js";

const SUMMARY_PROMPT = `You write the memory of a coding-agent session, so the agent can keep working after the older history is removed.
Write a very detailed summary. Its length follows the material: do not cut detail to save space.
Keep, in the order the session happened: the user's goals and every constraint they stated; each decision and its reason;
every file read or changed (full paths and what changed in each); every command run and its outcome; errors and how they were fixed;
open questions, pending work and next steps; and the exact names, values and identifiers the agent will need again.
Drop: raw file contents and long command output (keep a one-line description of each), pleasantries.
Answer in the language the user wrote in.`;

const TRANSCRIPT_CHARS = 400_000;
const TEXT_CHARS = 8_000;
const RESULT_CHARS = 2_000;

export function createSummarizer(model: ModelClient, modelId: string): Summarize {
  return async (messages, options, instructions) => {
    const response = await model.create({
      model: modelId,
      max_tokens: 8_000,
      system: instructions === undefined ? SUMMARY_PROMPT : `${SUMMARY_PROMPT}\n\n<extra_instructions>\n${instructions}\n</extra_instructions>`,
      messages: [{ role: "user", content: limitOutput(serialize(messages), TRANSCRIPT_CHARS) }],
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
    }, options);
    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n")
      .trim();
    if (text === "") throw new Error("the summarizer returned no text");
    return text;
  };
}

export function serialize(messages: readonly Anthropic.MessageParam[]): string {
  return messages.map((message) => `${message.role}:\n${blocksOf(message).join("\n")}`).join("\n\n");
}

function blocksOf(message: Anthropic.MessageParam): string[] {
  if (typeof message.content === "string") return [message.content.slice(0, TEXT_CHARS)];
  return message.content.map((block) => {
    if (block.type === "text") return block.text.slice(0, TEXT_CHARS);
    if (block.type === "tool_use") return `[tool call ${block.name} ${JSON.stringify(block.input).slice(0, RESULT_CHARS)}]`;
    if (block.type === "tool_result") {
      const text = typeof block.content === "string" ? block.content : "(structured content)";
      return `[tool result ${text.slice(0, RESULT_CHARS)}]`;
    }
    return `[${block.type}]`;
  });
}
