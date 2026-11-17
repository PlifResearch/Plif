import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { maskSecrets } from "./secrets.js";
import type { EventLog } from "./types.js";

export class DecisionLog implements EventLog {
  constructor(private readonly dir: string) {}

  async record(entry: Record<string, unknown>): Promise<void> {
    const now = new Date();
    await mkdir(this.dir, { recursive: true });
    const line = maskSecrets(JSON.stringify({ time: now.toISOString(), ...entry }));
    await appendFile(path.join(this.dir, `${now.toISOString().slice(0, 10)}.jsonl`), `${line}\n`, "utf8");
  }
}
