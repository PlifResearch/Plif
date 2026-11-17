import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { privateMode } from "./fs-atomic.js";
import type { PlifHome } from "./home.js";
import { projectKey } from "./paths.js";
import { maskSecrets } from "./secrets.js";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const INDEX_FILE = "MEMORY.md";
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25 * 1024;
const INSTRUCTION_MAX_BYTES = 256 * 1024;

export interface TopicMeta {
  readonly file: string;
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
  readonly modified: string;
}

export interface TopicInput {
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
  readonly body: string;
}

export interface InstructionFile {
  readonly source: string;
  readonly text: string;
}

export function memoryDirFor(home: PlifHome, root: string, platform: NodeJS.Platform = process.platform): string {
  const key = createHash("sha256").update(projectKey(root, platform)).digest("hex").slice(0, 16);
  return path.join(home.projects, key, "memory");
}

export async function ensureMemoryDir(dir: string, root: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: privateMode(0o700) });
  await writeFile(path.join(dir, "..", "project.txt"), `${root}\n`, { encoding: "utf8", mode: privateMode(0o600) });
}

export function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug === "" ? "memoria" : slug;
}

export function topicFile(name: string): string {
  return `${slugify(name)}.md`;
}

export function renderTopic(input: TopicInput, modified: string): string {
  const name = oneLine(input.name);
  const description = oneLine(input.description);
  return `---\nname: ${name}\ndescription: ${description}\ntype: ${input.type}\nmodified: ${modified}\n---\n\n${maskSecrets(input.body.trim())}\n`;
}

export function parseTopic(text: string): (Omit<TopicMeta, "file"> & { readonly body: string }) | null {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (match === null) return null;
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const type = fields.get("type") ?? "";
  if (!(MEMORY_TYPES as readonly string[]).includes(type)) return null;
  return {
    name: fields.get("name") ?? "",
    description: fields.get("description") ?? "",
    type: type as MemoryType,
    modified: fields.get("modified") ?? "",
    body: (match[2] ?? "").trim(),
  };
}

export async function listTopics(dir: string): Promise<TopicMeta[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter(
    (file) => file.endsWith(".md") && file !== INDEX_FILE,
  );
  const topics: TopicMeta[] = [];
  for (const file of files.sort()) {
    const parsed = parseTopic(await readFile(path.join(dir, file), "utf8").catch(() => ""));
    if (parsed !== null) {
      topics.push({ file, name: parsed.name, description: parsed.description, type: parsed.type, modified: parsed.modified });
    }
  }
  return topics;
}

export async function readIndex(dir: string): Promise<{ text: string; truncated: boolean }> {
  const raw = (await readFile(path.join(dir, INDEX_FILE), "utf8").catch(() => "")).replace(/\n$/, "");
  const lines = raw === "" ? [] : raw.split("\n");
  let kept = lines.slice(0, INDEX_MAX_LINES).join("\n");
  if (Buffer.byteLength(kept) > INDEX_MAX_BYTES) {
    kept = Buffer.from(kept).subarray(0, INDEX_MAX_BYTES).toString("utf8");
  }
  return {
    text: kept.trim(),
    truncated: lines.length > INDEX_MAX_LINES || Buffer.byteLength(raw) > INDEX_MAX_BYTES,
  };
}

export async function readTopic(dir: string, file: string): Promise<string> {
  return readFile(path.join(dir, path.basename(file)), "utf8");
}

export async function writeTopic(dir: string, input: TopicInput, now = new Date()): Promise<TopicMeta> {
  const file = topicFile(input.name);
  const modified = now.toISOString();
  const index = await readFile(path.join(dir, INDEX_FILE), "utf8").catch(() => "");
  const entry = `- [${oneLine(input.name)}](${file}): ${oneLine(input.description)}`;
  const lines = index.split("\n").filter((line) => line.trim() !== "" && !line.includes(`](${file})`));
  lines.push(entry);
  const nextIndex = `${lines.join("\n")}\n`;
  if (nextIndex.split("\n").length - 1 > INDEX_MAX_LINES || Buffer.byteLength(nextIndex) > INDEX_MAX_BYTES) {
    throw new Error("MEMORY.md would exceed the limit of 200 lines or 25 KB; consolidate or delete old entries first");
  }
  await writeFile(path.join(dir, file), renderTopic(input, modified), { encoding: "utf8", mode: privateMode(0o600) });
  await writeFile(path.join(dir, INDEX_FILE), nextIndex, { encoding: "utf8", mode: privateMode(0o600) });
  return { file, name: oneLine(input.name), description: oneLine(input.description), type: input.type, modified };
}

export async function deleteTopic(dir: string, file: string): Promise<void> {
  const safe = path.basename(file);
  await rm(path.join(dir, safe), { force: true });
  const index = await readFile(path.join(dir, INDEX_FILE), "utf8").catch(() => "");
  const lines = index.split("\n").filter((line) => line.trim() !== "" && !line.includes(`](${safe})`));
  await writeFile(path.join(dir, INDEX_FILE), lines.length > 0 ? `${lines.join("\n")}\n` : "", {
    encoding: "utf8",
    mode: privateMode(0o600),
  });
}

export async function loadInstructions(home: PlifHome, root: string): Promise<InstructionFile[]> {
  // Instructions.md is the user's global file. PLIF.md is still read when that one does not exist yet.
  const userFile = existsSync(home.instructions) ? home.instructions : path.join(home.root, "PLIF.md");
  const candidates = [
    { source: `user (~/.plif/${path.basename(userFile)})`, file: userFile },
    { source: "project (PLIF.md)", file: path.join(root, "PLIF.md") },
    { source: "project (AGENTS.md)", file: path.join(root, "AGENTS.md") },
  ];
  const found: InstructionFile[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate.file)) continue;
    const bytes = await readFile(candidate.file);
    if (bytes.length > INSTRUCTION_MAX_BYTES) {
      throw new Error(`instructions in ${candidate.file} exceed the 256 KiB limit; shrink the file before starting the session`);
    }
    const text = bytes.toString("utf8").trim();
    if (text !== "") found.push({ source: candidate.source, text });
  }
  return found;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
