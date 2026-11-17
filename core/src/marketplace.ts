import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "./mcp.js";

export const DEFAULT_MARKETPLACE_URL = "https://raw.githubusercontent.com/PlifResearch/Marketplace/main/marketplace.json";
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;

const ENTRY = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(300),
  homepage: z.string().optional(),
  repository: z.string(),
  transport: z.literal("stdio"),
  install: z.object({ command: z.string().min(1), args: z.array(z.string()) }),
  env: z
    .array(z.object({ name: z.string().regex(/^[A-Z][A-Z0-9_]*$/), description: z.string().max(200), secret: z.boolean().optional() }))
    .default([]),
  maintainer: z.string(),
  trust: z.enum(["community", "verified"]),
});

const MARKETPLACE = z.object({ version: z.literal(1), entries: z.array(ENTRY) });

export type MarketplaceEntry = z.infer<typeof ENTRY>;

export function parseMarketplace(text: string): MarketplaceEntry[] {
  return MARKETPLACE.parse(JSON.parse(text)).entries;
}

// The catalogue is cached for an hour. A failed download falls back to the last good copy.
export async function loadMarketplace(
  url: string,
  cacheFile: string,
  options: { readonly fetch?: typeof fetch; readonly now?: () => number } = {},
): Promise<{ readonly entries: MarketplaceEntry[]; readonly source: "network" | "cache" }> {
  const now = options.now ?? Date.now;
  const cached = await readCache(cacheFile);
  if (cached !== null && now() - cached.at < CACHE_TTL_MS) return { entries: parseMarketplace(cached.text), source: "cache" };

  try {
    const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("marketplace file too large");
    const entries = parseMarketplace(text);
    await writeCache(cacheFile, { at: now(), text });
    return { entries, source: "network" };
  } catch (error) {
    if (cached !== null) return { entries: parseMarketplace(cached.text), source: "cache" };
    throw new Error(`could not load the marketplace: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function searchEntries(entries: readonly MarketplaceEntry[], query: string): MarketplaceEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [...entries];
  return entries.filter((entry) => {
    const haystack = `${entry.id} ${entry.name} ${entry.description} ${entry.maintainer}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

// Environment values are never written to disk: each one points at the variable of the same name.
export function serverFromEntry(entry: MarketplaceEntry): McpServer {
  return {
    command: entry.install.command,
    args: entry.install.args,
    env: Object.fromEntries(entry.env.map((variable) => [variable.name, `$${variable.name}`])),
    allow: [],
    trust: entry.trust,
  };
}

// Writes the server into the user's mcp.json, keeping the other servers as they are.
export async function installServer(file: string, id: string, server: McpServer): Promise<void> {
  const current = await readJson(file);
  const servers = (current.servers ?? {}) as Record<string, unknown>;
  servers[id] = server;
  await writeAtomic(file, `${JSON.stringify({ ...current, servers }, null, 2)}\n`);
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function readCache(file: string): Promise<{ at: number; text: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { at: number; text: string };
    return typeof parsed.at === "number" && typeof parsed.text === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(file: string, value: { at: number; text: string }): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeAtomic(file, JSON.stringify(value));
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
  await rename(temp, file);
}
