import { readFile, writeFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { z } from "zod";
import { DEFAULT_MARKETPLACE_URL } from "./marketplace.js";

const EFFORT = z.enum(["low", "medium", "high", "xhigh", "max"]);
const DEFAULT_MASKS = ["~/.ssh", "~/.aws", "~/.gnupg"];
const COAUTHOR = "PlifResearch <github.com/PlifResearch>";
const OPTIONAL_TEXT = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .optional();

export const ConfigSchema = z.object({
  model: z.string().min(1).default("gpt-6-luna"),
  model_reasoning_effort: EFFORT.default("medium"),
  approval_policy: z.enum(["on-request", "never"]).default("on-request"),
  sandbox_mode: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  sandbox: z
    .object({
      network: z.enum(["allow", "deny"]).default("allow"),
      mask_paths: z.array(z.string()).default(DEFAULT_MASKS),
      writable_roots: z.array(z.string()).default([]),
    })
    .default({ network: "allow", mask_paths: DEFAULT_MASKS, writable_roots: [] }),
  agent: z
    .object({
      max_turns: z.number().int().min(1).max(500).default(40),
      max_total_tokens: z.number().int().min(10_000).default(2_000_000),
    })
    .default({ max_turns: 40, max_total_tokens: 2_000_000 }),
  context: z
    .object({ compact_at_tokens: z.number().int().min(20_000).default(120_000) })
    .default({ compact_at_tokens: 120_000 }),
  provider: z
    .object({
      kind: z.enum(["openai", "anthropic"]).default("openai"),
      base_url: z.url().optional(),
      // Read before the environment variable and the keychain. The file is written with permission 0600.
      api_key: OPTIONAL_TEXT,
      api_key_env: z.string().min(1).optional(),
    })
    .default({ kind: "openai" }),
  // The model of each internal job. Empty uses the model.json choice; main replaces the top-level model.
  models: z
    .object({
      main: OPTIONAL_TEXT,
      classifier: OPTIONAL_TEXT,
      compaction: OPTIONAL_TEXT,
      session_summary: OPTIONAL_TEXT,
      subagent: OPTIONAL_TEXT,
      explore: OPTIONAL_TEXT,
    })
    .default({}),
  git: z.object({ coauthor: z.string().default(COAUTHOR) }).default({ coauthor: COAUTHOR }),
  web: z.object({ allowed_domains: z.array(z.string()).default([]) }).default({ allowed_domains: [] }),
  marketplace: z.object({ url: z.url().default(DEFAULT_MARKETPLACE_URL) }).default({ url: DEFAULT_MARKETPLACE_URL }),
  memory: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  projects: z.record(z.string(), z.object({ trust_level: z.enum(["trusted", "untrusted"]) })).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type TrustLevel = "trusted" | "untrusted";

export function parseConfig(text: string): Config {
  const config = ConfigSchema.parse(parse(text));
  return config.models.main === undefined ? config : { ...config, model: config.models.main };
}

export async function loadConfig(file: string): Promise<Config> {
  return parseConfig(await readFile(file, "utf8"));
}

export function isTrusted(config: Config, project: string): boolean {
  return config.projects[project]?.trust_level === "trusted";
}

export async function setTrust(file: string, project: string, level: TrustLevel): Promise<void> {
  const text = await readFile(file, "utf8");
  const header = `[projects.${JSON.stringify(project)}]`;
  const block = [header, `trust_level = "${level}"`];
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  let next: string;
  if (start === -1) {
    next = `${text.trimEnd()}\n\n${block.join("\n")}\n`;
  } else {
    let end = start + 1;
    while (end < lines.length && !(lines[end] ?? "").trimStart().startsWith("[")) end++;
    next = [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
  }
  parseConfig(next);
  await writeFile(file, next, { encoding: "utf8", mode: 0o600 });
}

// Rewrites the top-level effort line, or adds it before the first section. The rest of the file stays as it is.
export async function setDefaultEffort(file: string, effort: Config["model_reasoning_effort"]): Promise<void> {
  const text = await readFile(file, "utf8").catch(() => "");
  const line = `model_reasoning_effort = "${effort}"  # low, medium, high, xhigh or max`;
  const lines = text.split("\n");
  const firstSection = lines.findIndex((entry) => entry.trimStart().startsWith("["));
  const top = firstSection === -1 ? lines.length : firstSection;
  const at = lines.findIndex((entry, index) => index < top && /^\s*model_reasoning_effort\s*=/.test(entry));
  if (at !== -1) lines[at] = line;
  else {
    const model = lines.findIndex((entry, index) => index < top && /^\s*model\s*=/.test(entry));
    lines.splice(model === -1 ? top : model + 1, 0, line);
  }
  const next = lines.join("\n");
  parseConfig(next);
  await writeFile(file, next, { encoding: "utf8", mode: 0o600 });
}
