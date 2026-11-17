import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Windows has no executable symlink in the PATH, so the command is a plif.cmd launcher, plus a sh one for Git Bash.
// %APPDATA%\npm is where npm puts its own launchers, and the Node installer adds it to the PATH.
export function windowsLaunchers(target, env, home, nodeProgram = process.execPath) {
  const win = path.win32;
  const entries = (env.PATH ?? env.Path ?? "").split(";").map((entry) => normalizeDir(entry));
  const candidates = [env.APPDATA ? win.join(env.APPDATA, "npm") : null, win.join(home, ".local", "bin")].filter(Boolean);
  const dir = candidates.find((candidate) => entries.includes(normalizeDir(candidate))) ?? win.join(home, ".local", "bin");
  const posixPath = (file) => file.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/${drive.toLowerCase()}/`).replace(/\\/g, "/");
  const shQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
  const cmdQuote = (value) => `"${value.replace(/%/g, "%%")}"`;
  return {
    dir,
    onPath: entries.includes(normalizeDir(dir)),
    files: [
      { file: win.join(dir, "plif.cmd"), text: `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${cmdQuote(nodeProgram)} ${cmdQuote(target)} %*\r\n` },
      { file: win.join(dir, "plif"), text: `#!/bin/sh\nexec ${shQuote(posixPath(nodeProgram))} ${shQuote(posixPath(target))} "$@"\n` },
    ],
  };
}

function normalizeDir(dir) {
  return path.win32.normalize(dir.trim().replace(/^"(.*)"$/, "$1")).replace(/\\+$/, "").toLowerCase();
}

function linkWindows(target) {
  const plan = windowsLaunchers(target, process.env, homedir());
  mkdirSync(plan.dir, { recursive: true });
  for (const { file, text } of plan.files) {
    let current = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      // no launcher yet
    }
    if (current !== text) writeFileSync(file, text, "utf8");
  }
  console.log(`plif -> ${target} (${path.win32.join(plan.dir, "plif.cmd")})`);
  if (!plan.onPath) console.log(`add ${plan.dir} to your user PATH so the plif command works in new terminals`);
}

function linkUnix(target) {
  const binDir = path.join(homedir(), ".local", "bin");
  const link = path.join(binDir, "plif");

  chmodSync(target, 0o755);
  mkdirSync(binDir, { recursive: true });

  try {
    const current = lstatSync(link);
    if (current.isSymbolicLink() && readlinkSync(link) === target) {
      console.log(`plif já aponta para ${target}`);
      return;
    }
    rmSync(link, { force: true });
  } catch {
    // o link ainda não existe
  }

  symlinkSync(target, link);
  console.log(`plif -> ${target}`);
}

// Runs only as a script, so the tests can import windowsLaunchers.
const invoked = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]).toLowerCase();
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const target = path.join(root, "dist", "core", "src", "cli.js");
  if (process.platform === "win32") linkWindows(target);
  else linkUnix(target);
}
