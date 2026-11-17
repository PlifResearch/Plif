import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { privateMode } from "./fs-atomic.js";
import { PROMPTS_DIR } from "./prompts.js";
import { CONFIG_TEMPLATE, MODEL_TEMPLATE } from "./templates.js";

export interface PlifHome {
  readonly root: string;
  readonly config: string;
  readonly models: string;
  readonly instructions: string;
  readonly sessions: string;
  readonly projects: string;
  readonly logs: string;
}

export function plifHomeDir(): string {
  return process.env.PLIF_HOME ?? path.join(homedir(), ".plif");
}

export function homeLayout(root: string): PlifHome {
  return {
    root,
    config: path.join(root, "config.toml"),
    models: path.join(root, "model.json"),
    instructions: path.join(root, "Instructions.md"),
    sessions: path.join(root, "sessions"),
    projects: path.join(root, "projects"),
    logs: path.join(root, "logs"),
  };
}

export async function ensureHome(layout: PlifHome, platform: NodeJS.Platform = process.platform): Promise<void> {
  for (const dir of [layout.root, layout.sessions, layout.projects, layout.logs]) {
    await mkdir(dir, { recursive: true, mode: privateMode(0o700, platform) });
  }
  const file = { encoding: "utf8", mode: privateMode(0o600, platform) } as const;
  if (!existsSync(layout.config)) await writeFile(layout.config, CONFIG_TEMPLATE, file);
  if (!existsSync(layout.models)) await writeFile(layout.models, MODEL_TEMPLATE, file);
  // The default personal instructions ship with Plif. A file the user already has, under either name, is kept.
  const personal = path.join(layout.root, "PLIF.md");
  if (!existsSync(layout.instructions) && !existsSync(personal)) {
    await copyFile(path.join(PROMPTS_DIR, "PLIF.md"), personal);
  }
}
