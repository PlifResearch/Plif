import path from "node:path";
import { isPlifConfig, resolveLexical, windowsCanonical } from "../paths.js";
import { isWindows } from "../platform.js";
import { type Segment, parseShell } from "../shell.js";
import { hasLongFlag, hasShortFlag, positional, programName, unwrap } from "./argv.js";

export interface HardDenyContext {
  readonly root: string;
  readonly home: string;
  readonly platform?: NodeJS.Platform;
}

const SYSTEM_ROOTS = new Set([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/opt",
  "/proc",
  "/root",
  "/sbin",
  "/srv",
  "/sys",
  "/usr",
  "/var",
]);
const HOME_ALIASES = new Set(["~", "$HOME", "${HOME}"]);
// Lowercase, as compared on Windows: variables of cmd, PowerShell and Git Bash that name the home or a system folder.
const WINDOWS_ALIASES = new Set([
  "%userprofile%",
  "$env:userprofile",
  "${env:userprofile}",
  "%homedrive%%homepath%",
  "$userprofile",
  "${userprofile}",
  "%systemroot%",
  "$env:systemroot",
  "%windir%",
  "$env:windir",
  "%systemdrive%",
  "$env:systemdrive",
  "%programfiles%",
  "$env:programfiles",
  "%programfiles(x86)%",
  "${env:programfiles(x86)}",
  "%programdata%",
  "$env:programdata",
  "$systemroot",
  "$windir",
  "$systemdrive",
  "$programfiles",
  "$programdata",
]);
// Folders under any drive root. The drive root itself is the empty entry.
const WINDOWS_SYSTEM_DIRS = new Set(["", "windows", "windows\\system32", "program files", "program files (x86)", "programdata", "users"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const WRITE_PROGRAMS = new Set([
  "rm",
  "mv",
  "cp",
  "tee",
  "touch",
  "truncate",
  "sed",
  "dd",
  "chmod",
  "chown",
  "chgrp",
  "ln",
  "install",
  "unlink",
  "rmdir",
  "shred",
]);
const NET_PROGRAMS = new Set(["curl", "wget", "nc", "ncat", "netcat", "scp", "sftp", "rsync", "ftp", "telnet", "socat", "ssh"]);
const SECRET_REFERENCES = [
  /\.ssh\//,
  /id_(rsa|ed25519|ecdsa|dsa)\b/,
  /\.aws\/credentials/,
  /\.gnupg\//,
  /\.kube\/config/,
  /\.npmrc\b/,
  /\.netrc\b/,
  /(^|[\s/@'"=])\.env(\.[\w-]+)?($|[\s'"])/,
];
const FORK_BOMB = ":(){:|:&};:";
const SAFE_DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

// ssh options that take a value in the next word; the first word after them is the host.
const SSH_VALUE_FLAGS = new Set(["-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"]);

// The command a remote shell would run: everything after the host. Null for an interactive login.
export function sshRemoteCommand(argv: readonly string[]): string | null {
  let index = 1;
  while (index < argv.length && (argv[index] ?? "").startsWith("-") && argv[index] !== "--") {
    index += SSH_VALUE_FLAGS.has(argv[index] ?? "") ? 2 : 1;
  }
  if (argv[index] === "--") index++;
  const rest = argv.slice(index + 1);
  return rest.length === 0 ? null : rest.join(" ");
}

// The key that ssh uses to authenticate is not sent as text, so its path is not a credential leak.
// Everything else in an ssh command, including the remote command, is still scanned.
function scanText(command: string, segments: readonly Segment[]): string {
  const isSsh = (segment: Segment) => programName(unwrap(segment.argv)[0]) === "ssh";
  if (!segments.some(isSsh)) return command;
  return segments
    .map((segment) => (isSsh(segment) ? sshWithoutKey(unwrap(segment.argv)) : [...segment.argv, ...segment.redirects]).join(" "))
    .join(" ; ");
}

function sshWithoutKey(argv: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index] ?? "";
    if (word === "-i") {
      index++;
      continue;
    }
    if (word === "-o" && (argv[index + 1] ?? "").startsWith("IdentityFile=")) {
      index++;
      continue;
    }
    if (word.startsWith("-oIdentityFile=") || word.startsWith("IdentityFile=")) continue;
    kept.push(word);
  }
  return kept;
}

export function hardDenyReason(command: string, ctx: HardDenyContext, depth = 0): string | null {
  if (depth > 3) return null;
  if (command.replace(/\s+/g, "").includes(FORK_BOMB)) return "fork bomb";
  if (command.includes("--no-preserve-root")) return "removal of root with --no-preserve-root";
  if (/>\s*\/dev\/(sd|hd|vd|xvd|nvme|disk|mmcblk)/.test(command)) return "direct write to disk";

  const segments = parseShell(command);
  if (segments === null) return rawReason(command, ctx);

  const networked =
    /\/dev\/tcp\//.test(command) || segments.some((segment) => NET_PROGRAMS.has(programName(unwrap(segment.argv)[0])));
  if (networked && SECRET_REFERENCES.some((pattern) => pattern.test(scanText(command, segments)))) {
    return "sending a credential to the network";
  }

  for (const segment of segments) {
    const reason = segmentReason(segment, ctx) ?? innerReason(unwrap(segment.argv), ctx, depth);
    if (reason !== null) return reason;
    const words = unwrap(segment.argv);
    if (programName(words[0]) === "ssh") {
      // A remote command is checked with the same rules as a local one.
      const remote = sshRemoteCommand(words);
      const remoteReason = remote === null ? null : hardDenyReason(remote, ctx, depth + 1);
      if (remoteReason !== null) return `remote command: ${remoteReason}`;
    }
  }
  return null;
}

function segmentReason(segment: Segment, ctx: HardDenyContext): string | null {
  const [head, ...args] = unwrap(segment.argv);
  if (head === undefined) return null;
  const program = programName(head);
  const targets = positional(args);
  const recursive = hasShortFlag(args, "r") || hasShortFlag(args, "R") || hasLongFlag(args, "recursive");

  if (program === "rm" && recursive && targets.some((target) => isSystemPath(target, ctx))) {
    return "recursive removal of a system directory or the home folder";
  }
  if ((program === "chmod" || program === "chown" || program === "chgrp") && recursive) {
    if (targets.some((target) => isSystemPath(target, ctx))) {
      return "recursive permission change on a system directory";
    }
  }
  if (program.startsWith("mkfs") || program === "wipefs") return "disk formatting";
  if (program === "dd" && args.some((arg) => arg.startsWith("of=/dev/") && !SAFE_DEVICES.has(arg.slice(3)))) {
    return "direct write to a device";
  }
  if (WRITE_PROGRAMS.has(program) || segment.redirects.length > 0) {
    const writes = [...targets, ...segment.redirects];
    if (writes.some((target) => isPlifConfigPath(target, ctx))) {
      return "the Plif configuration cannot be changed by the agent";
    }
  }
  return null;
}

function rawReason(command: string, ctx: HardDenyContext): string | null {
  const words = command.split(/\s+/);
  // On Windows a backslash is a separator, so the tokens are also checked with it kept.
  const tokens = [
    ...words.map((token) => token.replace(/["'\\]/g, "")),
    ...(isWindows(ctx.platform) ? words.map((token) => token.replace(/["']/g, "")) : []),
  ];
  const recursive = tokens.some((token) => /^-[A-Za-z]*[rR]/.test(token) || token === "--recursive");
  if (recursive && tokens.some((token) => isSystemPath(token, ctx))) {
    return "recursive removal or change in a system directory";
  }
  if (/\b(mkfs|wipefs)/.test(command)) return "disk formatting";
  if (/of=\/dev\/(?!null\b|stdout\b|stderr\b)/.test(command)) return "direct write to a device";
  return null;
}

function innerReason(argv: readonly string[], ctx: HardDenyContext, depth: number): string | null {
  const program = programName(argv[0]);
  const args = argv.slice(1);
  if (SHELLS.has(program)) {
    const index = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    const inner = index >= 0 ? args[index + 1] : undefined;
    return inner === undefined ? null : hardDenyReason(inner, ctx, depth + 1);
  }
  if (program === "eval" && args.length > 0) return hardDenyReason(args.join(" "), ctx, depth + 1);
  return null;
}

// A system folder or the home folder, as a target of recursive removal or permission change.
// On Windows the Unix list still applies (Git Bash maps / to its own folder), plus drives, system folders and the home.
export function isSystemPath(target: string, ctx: HardDenyContext): boolean {
  let normalized = path.posix.normalize(target).replace(/\/+$/, "");
  if (normalized.endsWith("/*")) normalized = normalized.slice(0, -2);
  if (normalized === "") return true;
  if (HOME_ALIASES.has(normalized) || normalized === ctx.home) return true;
  if (SYSTEM_ROOTS.has(normalized)) return true;
  return isWindows(ctx.platform) && isWindowsSystemPath(target, ctx);
}

function isWindowsSystemPath(target: string, ctx: HardDenyContext): boolean {
  const value = target.replace(/[\\/]\*(\.\*)?$/, "").replace(/^["']|["']$/g, "");
  if (WINDOWS_ALIASES.has(value.replace(/[\\/]+$/, "").toLowerCase())) return true;
  const canonical = windowsCanonical(resolveLexical(value === "" ? "\\" : value, ctx.root, ctx.home, "win32"));
  if (canonical === windowsCanonical(ctx.home) || canonical === windowsCanonical(path.win32.dirname(ctx.home))) return true;
  const drive = /^[a-z]:\\(.*)$/.exec(canonical);
  return drive !== null && WINDOWS_SYSTEM_DIRS.has(drive[1] ?? "");
}

function isPlifConfigPath(target: string, ctx: HardDenyContext): boolean {
  const platform = ctx.platform ?? process.platform;
  // A short 8.3 name such as PLIF~1 can name .plif on Windows without matching it as text.
  const spelled = isWindows(platform) ? target.replace(/(^|[\\/])plif~\d+(?=[\\/]|$)/gi, "$1.plif") : target;
  return isPlifConfig(resolveLexical(spelled, ctx.root, ctx.home, platform), ctx.root, ctx.home, platform);
}
