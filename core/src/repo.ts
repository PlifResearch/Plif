import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function findRepoFile(relative: string, start = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  while (!existsSync(path.join(dir, relative))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`repository file not found: ${relative}`);
    dir = parent;
  }
  return path.join(dir, relative);
}
