import type Anthropic from "@anthropic-ai/sdk";
import { estimateTokens } from "./output.js";
import type { ModelRequestOptions } from "./model.js";

// instructions: extra guidance for this summary, such as the stdout of a PreCompact hook.
export type Summarize = (messages: readonly Anthropic.MessageParam[], options?: ModelRequestOptions, instructions?: string) => Promise<string>;

const CLEARED_PREFIX = "[tool output cleared to save context";
const MIN_CLEARABLE_CHARS = 200;

// A base64 image would count as millions of characters, so each image is priced as a flat amount.
const IMAGE_TOKENS = 1_600;

export function estimateMessagesTokens(messages: readonly Anthropic.MessageParam[]): number {
  let images = 0;
  const text = messages.map((message) => {
    if (typeof message.content === "string") return message;
    const content = message.content.map((block): Anthropic.ContentBlockParam => {
      // Images returned by a tool sit inside the tool_result, so they are priced the same way.
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        const inner = block.content.map((item) => {
          if (item.type !== "image") return item;
          images++;
          return { type: "text" as const, text: "[image]" };
        });
        return { ...block, content: inner };
      }
      if (block.type !== "image") return block;
      images++;
      return { type: "text", text: "[image]" };
    });
    return { ...message, content };
  });
  return estimateTokens(JSON.stringify(text)) + images * IMAGE_TOKENS;
}

export function isRealUserMessage(message: Anthropic.MessageParam): boolean {
  if (message.role !== "user") return false;
  if (typeof message.content === "string") return true;
  return message.content.every((block) => block.type !== "tool_result");
}

// Replaces the content of old tool results in place. Work happens in batches so
// the prompt prefix changes rarely, which keeps the prompt cache warm between turns.
export function clearOldToolResults(
  messages: Anthropic.MessageParam[],
  keepLast: number,
  batchChars: number,
): number {
  const resultMessages = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "user" && Array.isArray(message.content))
    .filter(({ message }) => (message.content as Anthropic.ContentBlockParam[]).some((block) => block.type === "tool_result"));
  const candidates = resultMessages.slice(0, Math.max(0, resultMessages.length - keepLast));

  let savings = 0;
  for (const { message } of candidates) {
    for (const block of message.content as Anthropic.ContentBlockParam[]) {
      if (block.type === "tool_result" && typeof block.content === "string" && isClearable(block.content)) {
        savings += block.content.length;
      } else if (block.type === "tool_result" && hasImage(block)) {
        savings += IMAGE_TOKENS * 4;
      }
    }
  }
  if (savings < batchChars) return 0;

  let cleared = 0;
  for (const { message } of candidates) {
    for (const block of message.content as Anthropic.ContentBlockParam[]) {
      if (block.type === "tool_result" && typeof block.content === "string" && isClearable(block.content)) {
        block.content = `${CLEARED_PREFIX}: ${block.content.length} characters; run the tool again if you need it]`;
        cleared++;
      } else if (block.type === "tool_result" && hasImage(block)) {
        block.content = `${CLEARED_PREFIX}: an image; read the file again if you need to see it]`;
        cleared++;
      }
    }
  }
  return cleared;
}

function hasImage(block: Anthropic.ToolResultBlockParam): boolean {
  return Array.isArray(block.content) && block.content.some((item) => item.type === "image");
}

function isClearable(content: string): boolean {
  return content.length >= MIN_CLEARABLE_CHARS && !content.startsWith(CLEARED_PREFIX);
}

// Summarizes everything before a real user message and keeps the rest verbatim.
// Returns null when there is no safe cut point, so tool_use/tool_result pairs stay intact.
export async function compactHistory(
  messages: readonly Anthropic.MessageParam[],
  summarize: Summarize,
  keepRecent: number,
): Promise<Anthropic.MessageParam[] | null> {
  const start = Math.max(1, messages.length - keepRecent);
  let cut = -1;
  for (let index = start; index < messages.length; index++) {
    const candidate = messages[index];
    if (candidate !== undefined && isRealUserMessage(candidate)) {
      cut = index;
      break;
    }
  }
  if (cut <= 0) return null;

  const summary = await summarize(messages.slice(0, cut));
  const tail = messages.slice(cut);
  const first = tail[0];
  if (first === undefined) return null;
  const block = `<conversation_summary>\n${summary}\n</conversation_summary>\n\n`;
  const merged: Anthropic.MessageParam =
    typeof first.content === "string"
      ? { role: "user", content: block + first.content }
      : { role: "user", content: [{ type: "text", text: block }, ...first.content] };
  return [merged, ...tail.slice(1)];
}
