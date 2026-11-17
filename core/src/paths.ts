import { realpath } from "node:fs/promises";
import path from "node:path";
import { isWindows } from "./platform.js";

const PROTECTED_DIRS = new Set([".git", ".claude", ".plif", ".ssh", ".gnupg", ".aws"]);
const PROTECTED_FILES = new Set([
  ".mcp.json",
  ".gitconfig",
  ".npmrc",
  ".netrc",
  ".bashrc",
  ".zshrc",
  ".profile",
  ".bash_profile",
]);
// Windows opens these names as devices in any folder, with or without an extension. Reading CON waits on the console.
const WINDOWS_DEVICES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/;

export type PathScope = "inside" | "outside" | "protected";
export type PathApi = path.PlatformPath;

export function pathApi(platform: NodeJS.Platform = process.platform): PathApi {
  return isWindows(platform) ? path.win32 : path.posix;
}

export function expandHome(target: string, home: string, platform: NodeJS.Platform = process.platform): string {
  if (target === "~") return home;
  if (target.startsWith("~/") || (isWindows(platform) && target.startsWith("~\\"))) {
    return pathApi(platform).join(home, target.slice(2));
  }
  return target;
}

// The shell on Windows is Git Bash, where /c/Users and /cygdrive/c/Users name C:\Users.
export function fromMsys(target: string, platform: NodeJS.Platform = process.platform): string {
  if (!isWindows(platform)) return target;
  const match = /^(?:\/cygdrive)?\/([a-zA-Z])(?:\/(.*))?$/.exec(target);
  if (match === null) return target;
  return `${(match[1] ?? "").toUpperCase()}:\\${(match[2] ?? "").replace(/\//g, "\\")}`;
}

export function resolveLexical(target: string, root: string, home: string, platform: NodeJS.Platform = process.platform): string {
  return pathApi(platform).resolve(root, fromMsys(expandHome(target, home, platform), platform));
}

export function resolveReal(target: string, root: string, home: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  return realpathLenient(resolveLexical(target, root, home, platform), pathApi(platform));
}

async function realpathLenient(target: string, p: PathApi): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return p.join(await realpath(current), ...missing.reverse());
    } catch {
      const parent = p.dirname(current);
      if (parent === current) return target;
      missing.push(p.basename(current));
      current = parent;
    }
  }
}

// How Windows reads a path: no case, either slash, no \\?\ prefix, no trailing dots or spaces in a name
// and no stream suffix (file::$DATA is the file). Comparisons run on this form, so a spelling Windows
// accepts can never land outside a check that its plain form would hit.
export function windowsCanonical(target: string): string {
  const value = target
    .replace(/\//g, "\\")
    .replace(/^\\\\[?.]\\UNC\\/i, "\\\\")
    .replace(/^(?:\\\\[?.]\\|\\\?\?\\)(?=[a-z]:)/i, "");
  const root = path.win32.parse(value).root;
  const parts = value.slice(root.length).split("\\").map(windowsName);
  const normal = path.win32.normalize(root + parts.join("\\"));
  const trimmed = normal.length > root.length ? normal.replace(/\\+$/, "") : normal;
  return trimmed.toLowerCase();
}

function windowsName(part: string): string {
  if (part === "." || part === "..") return part;
  const name = (part.split(":")[0] ?? "").replace(/[. ]+$/, "");
  return name === "" ? "." : name;
}

function comparable(target: string, platform: NodeJS.Platform): string {
  return isWindows(platform) ? windowsCanonical(target) : target;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return comparable(a, platform) === comparable(b, platform);
}

// The key for folders derived from a project path, so C:\Proj and c:\proj share one folder on Windows.
export function projectKey(root: string, platform: NodeJS.Platform = process.platform): string {
  return comparable(root, platform);
}

export function isInside(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = pathApi(platform);
  const rel = p.relative(comparable(root, platform), comparable(target, platform));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

export function isProtectedRelative(rel: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!isWindows(platform)) {
    // macOS volumes ignore case by default, so .SSH opens .ssh there; the names are compared in lower case.
    const fold = platform === "darwin" ? (part: string) => part.toLowerCase() : (part: string) => part;
    const parts = rel
      .split("/")
      .filter((part) => part !== "")
      .map(fold);
    const last = parts.at(-1) ?? "";
    return parts.some((part) => PROTECTED_DIRS.has(part) || part.startsWith(".env")) || PROTECTED_FILES.has(last);
  }
  const parts = rel
    .split(/[\\/]/)
    .map((part) => windowsName(part).toLowerCase())
    .filter((part) => part !== "" && part !== ".");
  const last = parts.at(-1) ?? "";
  return (
    parts.some(
      (part) =>
        PROTECTED_DIRS.has(part) || part.startsWith(".env") || WINDOWS_DEVICES.test((part.split(".")[0] ?? "").trimEnd()),
    ) || PROTECTED_FILES.has(last)
  );
}

export function pathScope(real: string, root: string, platform: NodeJS.Platform = process.platform): PathScope {
  if (!isInside(root, real, platform)) return "outside";
  const rel = pathApi(platform).relative(comparable(root, platform), comparable(real, platform));
  return isProtectedRelative(rel, platform) ? "protected" : "inside";
}

export function isPlifConfig(real: string, root: string, home: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = pathApi(platform);
  return [p.join(root, ".plif"), p.join(home, ".plif")].some((dir) => isInside(dir, real, platform));
}

// Paths shown to the model use / on every platform.
export function toModelPath(rel: string, platform: NodeJS.Platform = process.platform): string {
  return isWindows(platform) ? rel.replace(/\\/g, "/") : rel;
}

// fast-glob reads \ as an escape. On Windows it is read as a folder separator, as in the paths themselves.
export function globPattern(pattern: string, platform: NodeJS.Platform = process.platform): string {
  return isWindows(platform) ? pattern.replace(/\\/g, "/") : pattern;
}
