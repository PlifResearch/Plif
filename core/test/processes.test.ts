import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { execute } from "../src/exec.js";
import { currentHost } from "../src/platform.js";
import { findRepoFile } from "../src/repo.js";
import { shellFor } from "../src/shell.js";
import { BackgroundTasks } from "../src/tasks.js";

// The descendant keeps writing after the parent dies unless the entire process tree is stopped.
const LEAF = `const fs = require('node:fs');
const file = process.argv[1];
const write = () => fs.writeFileSync(file, String(Date.now()));
write(); console.log('descendant ready'); setInterval(write, 40);`;
const PARENT = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(LEAF)}, process.argv[1]], { stdio: 'inherit' });`;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Git Bash launcher preserves spaces, quotes and shell metacharacters in paths and arguments", async (t) => {
  const script = await import(pathToFileURL(findRepoFile("scripts/link-dev.mjs")).href) as {
    windowsLaunchers: (target: string, env: NodeJS.ProcessEnv, home: string, nodeProgram: string) => { files: Array<{ file: string; text: string }> };
  };
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "plif-launcher-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "cli $PLIF_MISSING `whoami` 'quoted'.mjs");
  await writeFile(target, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const launcher = script.windowsLaunchers(target, {}, dir, process.execPath).files.find((file) => !file.file.endsWith(".cmd"));
  assert.ok(launcher);
  const file = path.join(dir, "launcher.sh");
  await writeFile(file, launcher.text);
  const args = ["space and $literal", "a'b", "`whoami`"];
  const result = await execute(shellFor(currentHost()), [file.replace(/\\/g, "/"), ...args], { cwd: dir, timeoutMs: 5_000, maxBytes: 1_000 });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(result.output), args);
});

test("execute: timeout stops the shell's descendants on the current OS", { timeout: 10_000 }, async (t) => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "plif-exec-tree-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const heartbeat = path.join(dir, "heartbeat");
  const result = await execute(process.execPath, ["-e", PARENT, heartbeat], { cwd: dir, timeoutMs: 2_000, maxBytes: 1_000 });
  assert.equal(result.timedOut, true);
  assert.match(result.output, /descendant ready/);
  const stopped = await readFile(heartbeat, "utf8");
  await delay(200);
  assert.equal(await readFile(heartbeat, "utf8"), stopped);
});

test("Monitor: stopping a task stops its descendants on the current OS", { timeout: 10_000 }, async (t) => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "plif-monitor-tree-")));
  const tasks = new BackgroundTasks();
  t.after(() => tasks.stopAll());
  t.after(() => rm(dir, { recursive: true, force: true }));
  const heartbeat = path.join(dir, "heartbeat");
  const task = tasks.start({ file: process.execPath, args: ["-e", PARENT, heartbeat], command: "test descendant", description: "test", cwd: dir, env: process.env });
  const deadline = Date.now() + 5_000;
  while (!task.tail.includes("descendant ready") && Date.now() < deadline) await delay(20);
  assert.match(task.tail, /descendant ready/);
  const finished = new Promise<void>((resolve) => {
    const off = tasks.subscribe((event) => {
      if (event.kind === "finished" && event.task.id === task.id) {
        off();
        resolve();
      }
    });
  });
  assert.equal(tasks.stop(task.id), true);
  await finished;
  assert.equal(task.status, "stopped");
  const stopped = await readFile(heartbeat, "utf8");
  await delay(200);
  assert.equal(await readFile(heartbeat, "utf8"), stopped);
});
