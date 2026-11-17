import { readFile } from "node:fs/promises";
import { loadInstructions, readIndex } from "./memory.js";
import type { Runtime } from "./runtime.js";
import { sessionFolders, sessionScratch } from "./scratch.js";
import { skillsBlock } from "./skills.js";

// The system prompt of a session: the base prompt plus what belongs to this project and this session.
// extra goes right after the base prompt (the interface puts the VPS block there).
export async function buildSessionSystem(runtime: Runtime, sessionId: string, extra: readonly string[] = []): Promise<string> {
  const parts = [runtime.baseSystem, ...extra];
  const skillText = skillsBlock(runtime.skills);
  if (skillText !== "") parts.push(skillText);
  if (runtime.git !== null) {
    const changed = runtime.git.changes.slice(0, 20);
    const state = changed.length === 0 ? "working tree clean" : `changes (${runtime.git.changes.length}):\n${changed.join("\n")}`;
    parts.push(`<git>\nbranch: ${runtime.git.branch}\n${state}\n</git>`);
  }
  const folders = sessionFolders(runtime.layout.sessions, sessionId);
  const memory = await readFile(folders.memory, "utf8").catch(() => "");
  parts.push(
    `<scratchpad>\nScratch folder for this session: ${sessionScratch(runtime.root, sessionId).scratchpad}. Use it for temporary files instead of /tmp.\nArtifacts (documents, pages and reports the person will open) go in: ${folders.artifacts}.\nYou can read and write in these folders without asking for approval.\n</scratchpad>`,
  );
  parts.push(
    `<session_memory>\nFile: ${folders.memory}. Update it with Write or Edit when something must survive a /clear or a resume.\n${memory.trim() === "" ? "(empty)" : memory.trim()}\n</session_memory>`,
  );
  const instructions = await loadInstructions(runtime.layout, runtime.root);
  if (instructions.length > 0) {
    parts.push(`<instructions>\n${instructions.map((item) => `## ${item.source}\n${item.text}`).join("\n\n")}\n</instructions>`);
  }
  if (runtime.config.memory.enabled) {
    const index = await readIndex(runtime.memoryDir);
    const body = index.text === "" ? "(no memory saved yet)" : index.text;
    parts.push(`<memory>\nFolder: ${runtime.memoryDir}\n${body}\n</memory>`);
  }
  return parts.join("\n\n");
}
