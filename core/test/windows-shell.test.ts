import assert from "node:assert/strict";
import { test } from "node:test";
import { taskkillArgv, treeSpawnOptions } from "../src/exec.js";
import { gitProgram } from "../src/git.js";
import { type Host, envValue, findOnPath, isWindows } from "../src/platform.js";
import { probeSandbox, sandboxSupported } from "../src/sandbox.js";
import { findGitBash, parseShell, shellFor } from "../src/shell.js";
import { BackgroundTasks, type Task } from "../src/tasks.js";
import { buildArgv } from "../src/tools/bash.js";
import { sshProgram } from "../src/vps.js";

const PROGRAM_FILES_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

function windows(env: NodeJS.ProcessEnv, files: readonly string[]): Host {
  const known = new Set(files.map((file) => file.toLowerCase()));
  return { platform: "win32", env, isFile: (file) => known.has(file.toLowerCase()) };
}

test("Git Bash: PLIF_GIT_BASH_PATH vem antes de tudo", () => {
  const host = windows({ PLIF_GIT_BASH_PATH: "D:\\tools\\Git\\bin\\bash.exe" }, ["D:\\tools\\Git\\bin\\bash.exe", PROGRAM_FILES_BASH]);
  assert.equal(findGitBash(host), "D:\\tools\\Git\\bin\\bash.exe");
});

test("Git Bash: PLIF_GIT_BASH_PATH inválida é erro, sem procurar em outro lugar", () => {
  assert.throws(() => findGitBash(windows({ PLIF_GIT_BASH_PATH: "D:\\nada\\bash.exe" }, [PROGRAM_FILES_BASH])), /PLIF_GIT_BASH_PATH/);
  assert.throws(() => findGitBash(windows({ PLIF_GIT_BASH_PATH: "bash.exe" }, ["bash.exe"])), /absolute path/);
});

test("Git Bash: instalação padrão e depois a instalação por usuário", () => {
  assert.equal(findGitBash(windows({}, [PROGRAM_FILES_BASH])), PROGRAM_FILES_BASH);
  const user = "C:\\Users\\ana\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
  assert.equal(findGitBash(windows({ LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local" }, [user])), user);
});

test("Git Bash: a instalação acompanha ProgramFiles em outra unidade", () => {
  const bash = "D:\\Applications\\Git\\bin\\bash.exe";
  assert.equal(findGitBash(windows({ ProgramFiles: "D:\\Applications" }, [bash])), bash);
});

test("Git Bash: no PATH, ignora o bash do WSL e entradas relativas", () => {
  const env = { Path: "C:\\Windows\\System32;.;C:\\Users\\ana\\AppData\\Local\\Microsoft\\WindowsApps;D:\\Git\\bin" };
  const files = ["C:\\Windows\\System32\\bash.exe", ".\\bash.exe", "C:\\Users\\ana\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe", "D:\\Git\\bin\\bash.exe"];
  assert.equal(findGitBash(windows(env, files)), "D:\\Git\\bin\\bash.exe");
  assert.equal(findGitBash(windows({ PATH: "C:\\Windows\\System32;." }, files)), null);
});

test("Git Bash: deduz o bash.exe a partir do git.exe em Git\\cmd", () => {
  const host = windows({ PATH: "E:\\Git\\cmd" }, ["E:\\Git\\cmd\\git.exe", "E:\\Git\\bin\\bash.exe"]);
  assert.equal(findGitBash(host), "E:\\Git\\bin\\bash.exe");
});

test("shellFor: /bin/sh fora do Windows; no Windows sem Git Bash, erro que explica como instalar", () => {
  assert.equal(shellFor({ platform: "linux", env: { PLIF_GIT_BASH_PATH: "D:\\x" }, isFile: () => false }), "/bin/sh");
  assert.equal(shellFor({ platform: "darwin", env: {}, isFile: () => false }), "/bin/sh");
  assert.throws(() => shellFor(windows({}, [])), /Git Bash not found.*Git for Windows.*PLIF_GIT_BASH_PATH/);
});

test("envValue ignora maiúsculas e trata vazio como ausente", () => {
  assert.equal(envValue({ Path: "C:\\a" }, "PATH"), "C:\\a");
  assert.equal(envValue({ LOCALAPPDATA: "" }, "LOCALAPPDATA"), undefined);
  assert.equal(findOnPath("git.exe", windows({ PATH: '"C:\\Git\\cmd"' }, ["C:\\Git\\cmd\\git.exe"])), "C:\\Git\\cmd\\git.exe");
});

test("Bash no Windows roda o comando pelo Git Bash", () => {
  const host = windows({}, [PROGRAM_FILES_BASH]);
  const command = "npm test && echo ok";
  assert.deepEqual(buildArgv(command, parseShell(command), false, host), [PROGRAM_FILES_BASH, "-c", command]);
});

test("git só leitura no Windows usa o git.exe absoluto e desliga os hooks com NUL", () => {
  const host = windows({ PATH: "C:\\Git\\cmd" }, [PROGRAM_FILES_BASH, "C:\\Git\\cmd\\git.exe"]);
  const argv = buildArgv("git status", parseShell("git status"), true, host);
  assert.equal(argv[0], "C:\\Git\\cmd\\git.exe");
  assert.ok(argv.includes("core.hooksPath=NUL"));
  const linux = buildArgv("git status", parseShell("git status"), true, { platform: "linux", env: {}, isFile: () => false });
  assert.equal(linux[0], "git");
  assert.ok(linux.includes("core.hooksPath=/dev/null"));
});

test("gitProgram no Windows: PATH, depois o git.exe ao lado do Git Bash, nunca o nome solto", () => {
  assert.equal(gitProgram(windows({ PATH: "C:\\Git\\cmd" }, ["C:\\Git\\cmd\\git.exe"])), "C:\\Git\\cmd\\git.exe");
  assert.equal(gitProgram(windows({}, [PROGRAM_FILES_BASH, "C:\\Program Files\\Git\\bin\\git.exe"])), "C:\\Program Files\\Git\\bin\\git.exe");
  assert.equal(gitProgram(windows({ PATH: "." }, [".\\git.exe"])), null);
  assert.equal(gitProgram({ platform: "linux", env: {}, isFile: () => false }), "git");
});

test("SSH no Windows usa OpenSSH do sistema, PATH absoluto ou a cópia do Git", () => {
  const system = "D:\\Win\\System32\\OpenSSH\\ssh.exe";
  assert.equal(sshProgram(windows({ SystemRoot: "D:\\Win", PATH: "E:\\SSH" }, [system, "E:\\SSH\\ssh.exe"])), system);
  assert.equal(sshProgram(windows({ PATH: "E:\\SSH" }, ["E:\\SSH\\ssh.exe"])), "E:\\SSH\\ssh.exe");
  const bundled = "C:\\Program Files\\Git\\usr\\bin\\ssh.exe";
  assert.equal(sshProgram(windows({}, [PROGRAM_FILES_BASH, bundled])), bundled);
  assert.equal(sshProgram(windows({ PATH: "." }, ["ssh.exe"])), null);
});

test("processos filhos: grupo próprio no Unix, sem console novo no Windows", () => {
  assert.deepEqual(treeSpawnOptions("linux"), { detached: true, windowsHide: true });
  assert.deepEqual(treeSpawnOptions("win32"), { detached: false, windowsHide: true });
  assert.deepEqual(taskkillArgv(42, { SystemRoot: "D:\\Win" }), ["D:\\Win\\System32\\taskkill.exe", "/pid", "42", "/T", "/F"]);
  assert.equal(taskkillArgv(7, {})[0], "C:\\Windows\\System32\\taskkill.exe");
});

test("sandbox: indisponível no Windows sem tentar o bwrap", async () => {
  assert.equal(sandboxSupported("win32"), false);
  assert.equal(sandboxSupported("linux"), true);
  assert.equal(sandboxSupported("darwin"), false);
  const settings = { readOnly: false, network: "allow" as const, maskPaths: [], writableRoots: [] };
  assert.equal(await probeSandbox("C:\\nao-existe", settings, "win32"), false);
});

test("tarefa no Windows para a árvore uma vez só, sem escalar para SIGKILL", { skip: isWindows() && "usa /bin/sh" }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: [number, NodeJS.Signals, NodeJS.Platform | undefined][] = [];
  const tasks = new BackgroundTasks("win32", (pid, signal, platform) => {
    calls.push([pid, signal, platform]);
    process.kill(pid, "SIGKILL");
  });
  const started = tasks.start({ command: "sleep 30", description: "teste", file: "/bin/sh", args: ["-c", "exec sleep 30"], cwd: process.cwd(), env: process.env });
  assert.equal(tasks.stop(started.id), true);
  const done = await new Promise<Task>((resolve) => {
    const off = tasks.subscribe((event) => {
      if (event.kind === "finished") {
        off();
        resolve(event.task);
      }
    });
  });
  t.mock.timers.tick(10_000);
  assert.equal(done.status, "stopped");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[2], "win32");
});
