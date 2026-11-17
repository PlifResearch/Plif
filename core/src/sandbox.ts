import { existsSync } from "node:fs";
import { execute } from "./exec.js";
import type { SandboxSettings } from "./types.js";

export function sandboxPrefix(root: string, settings: SandboxSettings): string[] {
  const args = [
    "bwrap",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
  ];
  for (const masked of settings.maskPaths) {
    if (existsSync(masked)) args.push("--tmpfs", masked);
  }
  if (!settings.readOnly) {
    for (const dir of [root, ...settings.writableRoots]) {
      if (existsSync(dir)) args.push("--bind", dir, dir);
    }
  }
  if (settings.network === "deny") args.push("--unshare-net");
  args.push("--chdir", root, "--");
  return args;
}

// bubblewrap is Linux only. On Windows there is no system sandbox, so every Bash call asks for approval.
export function sandboxSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux";
}

export async function probeSandbox(root: string, settings: SandboxSettings, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!sandboxSupported(platform)) return false;
  try {
    const [file, ...args] = [...sandboxPrefix(root, settings), "/bin/true"];
    const result = await execute(file ?? "bwrap", args, { cwd: root, timeoutMs: 5000, maxBytes: 4000 });
    return result.code === 0;
  } catch {
    return false;
  }
}
