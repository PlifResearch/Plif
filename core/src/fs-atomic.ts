import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isWindows } from "./platform.js";

// Unix modes for files only the user may read. Windows has no such modes (Node ignores them in mkdir and keeps only
// the write bit in writeFile), so there the protection comes from the ACL of the user profile.
export function privateMode(mode: number, platform: NodeJS.Platform = process.platform): number | undefined {
  return isWindows(platform) ? undefined : mode;
}

// Writes to a temporary file and renames it, so a crash never leaves half a file behind.
export async function writeAtomic(file: string, text: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: privateMode(0o700, platform) });
  const temp = `${file}.tmp`;
  await writeFile(temp, text, { encoding: "utf8", mode: privateMode(0o600, platform) });
  await renameRetrying(temp, file, platform);
}

// On Windows, an antivirus or the search indexer can hold the target open for a moment and the rename fails.
async function renameRetrying(from: string, to: string, platform: NodeJS.Platform): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const busy = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!isWindows(platform) || !busy || attempt >= 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 20));
    }
  }
}
