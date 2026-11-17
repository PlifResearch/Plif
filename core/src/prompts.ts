import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROMPTS_DIR = findPromptsDir(path.dirname(fileURLToPath(import.meta.url)));

function findPromptsDir(start: string): string {
  let dir = start;
  while (!existsSync(path.join(dir, "prompts"))) {
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start, "../../../prompts");
    dir = parent;
  }
  return path.join(dir, "prompts");
}

async function readPrompt(name: string): Promise<string> {
  const text = await readFile(path.join(PROMPTS_DIR, name), "utf8");
  return text.replace(/^<!--[\s\S]*?-->\s*/, "").trim();
}

export function loadClassifierPrompt(): Promise<string> {
  return readPrompt("classifier.md");
}

export async function readProjectPolicy(root: string): Promise<string> {
  try {
    return (await readFile(path.join(root, ".plif", "policy.md"), "utf8")).trim();
  } catch {
    return "";
  }
}

export async function loadSystemPrompt(available: readonly string[]): Promise<string> {
  const system = await readPrompt("system.md");
  const tools = (await readPrompt("tools.md")).replace(/<tool name="([^"]+)">[\s\S]*?<\/tool>/g, (block: string, name: string) =>
    available.includes(name) ? block : "",
  );
  return `${system}\n\n${tools}`;
}
