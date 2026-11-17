import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "./tools/registry.js";
import type { Verdict } from "./types.js";

// Format from Anthropic's Agent Skills: a folder with SKILL.md, a YAML header with name and description.
// https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview

const NAME = /^[a-z0-9-]{1,64}$/;
const RESERVED = ["anthropic", "claude"];
const MAX_DESCRIPTION = 1024;
const MAX_LISTED_FILES = 50;

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly folder: string;
  readonly source: "user" | "project";
}

export interface SkillLoad {
  readonly skills: Skill[];
  readonly errors: string[];
}

export function parseSkillFile(text: string): { readonly name: string; readonly description: string; readonly body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (match === null) throw new Error("SKILL.md needs a header between --- lines");
  const header = new Map<string, string>();
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const field = line.match(/^([a-z-]+):\s*(.*)$/);
    if (field !== null) header.set(field[1] ?? "", stripQuotes((field[2] ?? "").trim()));
  }
  const name = header.get("name") ?? "";
  const description = header.get("description") ?? "";
  if (!NAME.test(name)) throw new Error("name must use lowercase letters, digits and hyphens (up to 64)");
  if (RESERVED.some((word) => name.includes(word))) throw new Error(`name cannot contain: ${RESERVED.join(", ")}`);
  if (description === "" || description.length > MAX_DESCRIPTION) throw new Error(`description must have 1 to ${MAX_DESCRIPTION} characters`);
  if (/<[a-z/][^>]*>/i.test(description)) throw new Error("description cannot contain XML tags");
  return { name, description, body: (match[2] ?? "").trim() };
}

function stripQuotes(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

export async function readDisabledSkills(file: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { disabled?: unknown };
    return Array.isArray(parsed.disabled) ? parsed.disabled.filter((item): item is string => typeof item === "string") : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function loadSkills(sources: ReadonlyArray<{ readonly dir: string; readonly source: "user" | "project" }>, disabled: readonly string[]): Promise<SkillLoad> {
  const skills: Skill[] = [];
  const errors: string[] = [];
  for (const { dir, source } of sources) {
    for (const entry of await listFolders(dir)) {
      const folder = path.join(dir, entry);
      try {
        const parsed = parseSkillFile(await readFile(path.join(folder, "SKILL.md"), "utf8"));
        if (disabled.includes(parsed.name)) continue;
        if (skills.some((skill) => skill.name === parsed.name)) {
          errors.push(`skill ${parsed.name} in ${folder} repeats a name already loaded`);
          continue;
        }
        skills.push({ name: parsed.name, description: parsed.description, folder, source });
      } catch (error) {
        errors.push(`skill ${entry}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { skills, errors };
}

async function listFolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    const folders: string[] = [];
    for (const entry of entries.sort()) {
      // Symbolic links are skipped so that a skill cannot point the loader outside its folder.
      const info = await lstat(path.join(dir, entry));
      if (info.isDirectory()) folders.push(entry);
    }
    return folders;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// Level 1 of progressive disclosure: names and descriptions only. The body loads when the model asks for it.
export function skillsBlock(skills: readonly Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  return `<skills>\nUse the Skill tool with a skill name when a skill matches the task.\n${lines.join("\n")}\n</skills>`;
}

const schema = z.object({
  name: z.string().min(1).describe("Name of one of the skills listed in the system prompt."),
});

export function skillTool(skills: readonly Skill[]): Tool<typeof schema> {
  return {
    name: "Skill",
    description: "Loads the instructions of a skill listed in the system prompt, and the names of the files that come with it.",
    schema,
    async policy(input): Promise<Verdict> {
      if (!skills.some((skill) => skill.name === input.name)) {
        return { level: 2, decision: "deny", reason: `unknown skill: ${input.name}` };
      }
      return { level: 1, decision: "allow", reason: `load skill ${input.name}` };
    },
    async run(input) {
      const skill = skills.find((item) => item.name === input.name);
      if (skill === undefined) throw new Error(`unknown skill: ${input.name}`);
      const parsed = parseSkillFile(await readFile(path.join(skill.folder, "SKILL.md"), "utf8"));
      const files = await listFiles(skill.folder);
      return JSON.stringify({
        name: skill.name,
        folder: skill.folder,
        instructions: parsed.body,
        files,
      });
    },
  };
}

async function listFiles(folder: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir)).sort()) {
      if (found.length >= MAX_LISTED_FILES) return;
      const full = path.join(dir, entry);
      const info = await lstat(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(full, `${prefix}${entry}/`);
      else if (entry !== "SKILL.md") found.push(`${prefix}${entry}`);
    }
  };
  await walk(folder, "");
  return found;
}
