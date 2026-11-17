import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { privateMode } from "./fs-atomic.js";
import { samePath } from "./paths.js";
import { maskSecrets } from "./secrets.js";

const META = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  model: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  title: z.string(),
  // The Git branch when the session started. Sessions from before this field have none.
  branch: z.string().optional(),
  // The VPS switched on in this session. Only the name, address, user, port and key path are stored, never the key.
  vps: z
    .object({ name: z.string(), host: z.string(), user: z.string(), port: z.number(), keyPath: z.string() })
    .nullable()
    .optional(),
});

export type SessionMeta = z.infer<typeof META>;
export type SessionVps = NonNullable<SessionMeta["vps"]>;
// Bytes on disk for meta.json and transcript.jsonl together. Not stored in meta.json.
export type SessionEntry = SessionMeta & { readonly bytes: number };

export class SessionStore {
  constructor(
    private readonly dir: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async create(cwd: string, model: string, branch?: string): Promise<SessionMeta> {
    const now = new Date().toISOString();
    const meta: SessionMeta = { id: randomUUID(), cwd, model, createdAt: now, updatedAt: now, title: "", ...(branch ? { branch } : {}) };
    await mkdir(path.join(this.dir, meta.id), { recursive: true, mode: privateMode(0o700, this.platform) });
    await this.writeMeta(meta);
    return meta;
  }

  async append(meta: SessionMeta, message: Anthropic.MessageParam): Promise<SessionMeta> {
    const line = JSON.stringify(maskMessage(message));
    await appendFile(path.join(this.dir, meta.id, "transcript.jsonl"), `${line}\n`, { encoding: "utf8", mode: privateMode(0o600, this.platform) });
    const next: SessionMeta = {
      ...meta,
      updatedAt: new Date().toISOString(),
      title: meta.title === "" ? titleOf(message) : meta.title,
    };
    await this.writeMeta(next);
    return next;
  }

  async setVps(meta: SessionMeta, vps: SessionVps | null): Promise<SessionMeta> {
    const next: SessionMeta = { ...meta, vps, updatedAt: new Date().toISOString() };
    await this.writeMeta(next);
    return next;
  }

  // A new title from the person. updatedAt stays, so renaming does not move the session to the top of the list.
  async rename(id: string, title: string): Promise<SessionMeta> {
    const next: SessionMeta = { ...(await this.readMeta(id)), title: title.replace(/\s+/g, " ").trim().slice(0, 80) };
    await this.writeMeta(next);
    return next;
  }

  // The last exchanges of a session, as short text, for the preview in the picker.
  async preview(id: string, limit = 8): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
    const text = await readFile(path.join(this.dir, id, "transcript.jsonl"), "utf8").catch(() => "");
    const entries: Array<{ role: "user" | "assistant"; text: string }> = [];
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const message = JSON.parse(line) as Anthropic.MessageParam;
      const body =
        typeof message.content === "string"
          ? message.content
          : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
      const clean = body.replace(/\s+/g, " ").trim();
      if (message.role !== "user" && message.role !== "assistant") continue;
      if (clean === "" || clean.startsWith("<conversation_summary>")) continue;
      entries.push({ role: message.role, text: clean });
    }
    return entries.slice(-limit);
  }

  async load(prefix: string): Promise<{ meta: SessionMeta; messages: Anthropic.MessageParam[] }> {
    const matches = (await this.list()).filter((meta) => meta.id.startsWith(prefix));
    if (matches.length === 0) throw new Error("session not found");
    if (matches.length > 1) throw new Error("the prefix matches more than one session");
    const meta = matches[0];
    if (meta === undefined) throw new Error("session not found");
    const text = await readFile(path.join(this.dir, meta.id, "transcript.jsonl"), "utf8").catch(() => "");
    const messages = text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Anthropic.MessageParam);
    return { meta, messages };
  }

  async list(cwd?: string): Promise<SessionEntry[]> {
    const folders = await readdir(this.dir).catch(() => [] as string[]);
    const entries = await Promise.all(folders.map((id) => this.readEntry(id).catch(() => null)));
    return entries
      .filter((entry): entry is SessionEntry => entry !== null && (cwd === undefined || samePath(entry.cwd, cwd, this.platform)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async readEntry(id: string): Promise<SessionEntry> {
    const dir = path.join(this.dir, id);
    const meta = META.parse(JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")));
    const sizes = await Promise.all(
      ["meta.json", "transcript.jsonl"].map((name) => stat(path.join(dir, name)).then((info) => info.size, () => 0)),
    );
    return { ...meta, bytes: sizes.reduce((total, size) => total + size, 0) };
  }

  private async readMeta(id: string): Promise<SessionMeta> {
    return META.parse(JSON.parse(await readFile(path.join(this.dir, id, "meta.json"), "utf8")));
  }

  private async writeMeta(meta: SessionMeta): Promise<void> {
    // META.parse drops the fields that only exist in memory, such as bytes from list().
    await writeFile(path.join(this.dir, meta.id, "meta.json"), `${JSON.stringify(META.parse(meta), null, 2)}\n`, {
      encoding: "utf8",
      mode: privateMode(0o600, this.platform),
    });
  }
}

// Image data is base64, and a random run of it can match a secret pattern. Only text is masked.
function maskMessage(message: Anthropic.MessageParam): object {
  if (typeof message.content === "string") return { ...message, content: maskSecrets(message.content) };
  return {
    ...message,
    content: message.content.map((block): Anthropic.ContentBlockParam => {
      if (block.type === "image") return block;
      return JSON.parse(maskSecrets(JSON.stringify(block))) as Anthropic.ContentBlockParam;
    }),
  };
}

function titleOf(message: Anthropic.MessageParam): string {
  if (message.role !== "user") return "";
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
  return text.replace(/\s+/g, " ").trim().slice(0, 60);
}
