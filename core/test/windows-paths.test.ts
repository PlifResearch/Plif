import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { privateMode } from "../src/fs-atomic.js";
import { homeLayout } from "../src/home.js";
import { memoryDirFor } from "../src/memory.js";
import {
  expandHome,
  fromMsys,
  globPattern,
  isInside,
  isPlifConfig,
  isProtectedRelative,
  pathScope,
  samePath,
  toModelPath,
} from "../src/paths.js";
import { decideBash, decideFileAccess, decideGlob } from "../src/policy/decide.js";
import { hardDenyReason, isSystemPath } from "../src/policy/hard-deny.js";
import { findRepoFile } from "../src/repo.js";
import { safeUserName, scratchBase, scratchUserDir } from "../src/scratch.js";
import { SessionStore } from "../src/session.js";
import type { PolicyContext } from "../src/types.js";

const W = "win32" as const;
const ROOT = "C:\\Users\\Ana\\proj";
const HOME = "C:\\Users\\Ana";
const ctx: PolicyContext = { root: ROOT, home: HOME, scratchRoots: ["C:\\Users\\Ana\\AppData\\Local\\Temp\\plif-Ana\\abc\\s1\\scratchpad"] };

test("Windows: dentro do projeto ignora maiúsculas, mistura de barras e o prefixo \\\\?\\", () => {
  assert.ok(isInside(ROOT, "c:\\users\\ana\\PROJ\\src\\a.ts", W));
  assert.ok(isInside(ROOT, "C:/Users/Ana/proj/src/a.ts", W));
  assert.ok(isInside(ROOT, "\\\\?\\C:\\Users\\Ana\\proj\\src", W));
  assert.ok(isInside(ROOT, ROOT, W));
  assert.ok(!isInside(ROOT, "C:\\Users\\Ana\\proj2\\a", W));
  assert.ok(!isInside(ROOT, "C:\\Users\\Ana\\proj\\..\\segredo", W));
  assert.ok(!isInside(ROOT, "D:\\Users\\Ana\\proj\\a", W), "outra unidade fica fora");
  assert.ok(!isInside(ROOT, "\\\\servidor\\share\\proj", W), "UNC fica fora");
  assert.ok(!isInside(ROOT, "\\\\?\\UNC\\servidor\\share", W));
});

test("Windows: no Linux, a mesma checagem continua diferenciando maiúsculas", () => {
  assert.ok(!isInside("/home/ana/proj", "/home/ana/PROJ/a"));
  assert.ok(isInside("/home/ana/proj", "/home/ana/proj/a"));
});

test("Windows: caminhos protegidos valem em qualquer grafia que o Windows aceita", () => {
  for (const rel of [
    ".SSH\\id_ed25519",
    ".git\\config",
    ".Git.\\config",
    ".git \\HEAD",
    ".git::$INDEX_ALLOCATION\\config",
    "sub/.ENV",
    ".env.local:stream",
    ".GitConfig",
    ".npmrc.",
    ".plif/config.toml",
    "CON",
    "src\\nul.txt",
    "COM1",
    "lpt9.log",
  ]) {
    assert.ok(isProtectedRelative(rel, W), rel);
  }
  for (const rel of ["src\\a.ts", "docs/console.md", "contrib\\x", "connect.ts"]) {
    assert.ok(!isProtectedRelative(rel, W), rel);
  }
  assert.equal(pathScope("C:\\Users\\Ana\\proj\\.SSH\\id_rsa", ROOT, W), "protected");
  assert.equal(pathScope("c:\\users\\ana\\proj\\src\\a.ts", ROOT, W), "inside");
  assert.equal(pathScope("C:\\Windows\\System32", ROOT, W), "outside");
  assert.ok(!isProtectedRelative(".SSH/id", "linux"), "no Linux, .SSH é outra pasta");
});

test("Windows: ~, ~\\ e caminhos do Git Bash", () => {
  assert.equal(expandHome("~\\.plif", HOME, W), "C:\\Users\\Ana\\.plif");
  assert.equal(expandHome("~/.plif", HOME, W), "C:\\Users\\Ana\\.plif");
  assert.equal(expandHome("~\\x", "/home/ana", "linux"), "~\\x");
  assert.equal(fromMsys("/c/Users/Ana", W), "C:\\Users\\Ana");
  assert.equal(fromMsys("/cygdrive/d/x/y", W), "D:\\x\\y");
  assert.equal(fromMsys("/c", W), "C:\\");
  assert.equal(fromMsys("/c/Users", "linux"), "/c/Users");
  assert.equal(fromMsys("/etc/hosts", W), "/etc/hosts");
});

test("Windows: a pasta da Plif no perfil e no projeto, sem diferenciar maiúsculas", () => {
  assert.ok(isPlifConfig("c:\\users\\ana\\.PLIF\\config.toml", ROOT, HOME, W));
  assert.ok(isPlifConfig("C:\\Users\\Ana\\proj\\.plif.\\x", ROOT, HOME, W));
  assert.ok(!isPlifConfig("C:\\Users\\Ana\\proj\\plif.md", ROOT, HOME, W));
});

test("Windows: política de arquivos", async () => {
  const read = (target: string) => decideFileAccess(target, "read", ctx, W);
  const write = (target: string) => decideFileAccess(target, "write", ctx, W);
  assert.equal((await read("src\\a.ts")).decision, "allow");
  assert.equal((await read("C:/users/ana/proj/src/a.ts")).decision, "allow");
  assert.equal((await read("/c/Users/Ana/proj/src/a.ts")).decision, "allow");
  assert.equal((await read("C:\\Users\\Ana\\.ssh\\id_rsa")).decision, "ask_user");
  assert.equal((await read(".SSH\\id_rsa")).decision, "ask_user");
  assert.equal((await read("\\\\servidor\\share\\x")).decision, "ask_user");
  assert.equal((await read("D:\\dados\\x")).decision, "ask_user");
  assert.equal((await read("..\\outro\\x")).decision, "ask_user");
  const config = await write("~\\.plif\\config.toml");
  assert.equal(config.decision, "deny");
  assert.equal(config.level, 0);
  assert.equal((await write("C:\\USERS\\ANA\\.Plif\\config.toml")).level, 0);
  assert.equal((await write("c:\\users\\ana\\appdata\\local\\temp\\PLIF-ANA\\abc\\s1\\scratchpad\\nota.md")).decision, "allow");
});

test("Windows: padrões de Glob com unidade ou UNC pedem aprovação", async () => {
  for (const pattern of ["C:/Windows/**", "c:**", "\\\\servidor\\share\\**", "\\Windows\\*", "..\\x\\**", "src/../../x"]) {
    assert.equal((await decideGlob(pattern, ".", ctx, W)).decision, "ask_user", pattern);
  }
  assert.equal((await decideGlob("src\\**\\*.ts", ".", ctx, W)).decision, "allow");
  assert.equal((await decideGlob("C:/x/**", ".", { root: "/home/ana/proj", home: "/home/ana" }, "linux")).decision, "allow");
});

test("Windows: nível 0 cobre unidades, pastas do sistema, a pasta do usuário e a pasta da Plif", () => {
  const hard = { root: ROOT, home: HOME, platform: W };
  for (const command of [
    "rm -rf C:/",
    "rm -rf 'C:\\'",
    "rm -rf 'D:\\'",
    "rm -rf C:/Windows",
    "rm -rf 'c:\\windows\\system32'",
    "rm -rf '/c/Program Files'",
    "rm -rf /c/Users",
    "rm -rf /cygdrive/c/ProgramData",
    "rm -rf '%USERPROFILE%'",
    "rm -rf '$env:USERPROFILE'",
    "rm -rf 'C:\\Users\\ana'",
    "rm -rf ..",
    "chmod -R 777 /c/Windows",
    "rm -rf /",
    "rm -rf ~",
    "echo x > 'C:\\Users\\Ana\\.PLIF\\config.toml'",
    "echo x > ~/PLIF~1/config.toml",
    "echo x > .Plif./settings.json",
    "cp a /c/Users/Ana/.plif/config.toml",
  ]) {
    assert.notEqual(hardDenyReason(command, hard), null, command);
  }
  for (const command of ["rm -rf ./build", "rm -rf node_modules", "rm -rf 'C:\\Users\\Ana\\proj\\dist'", "rm -rf /c/Users/Ana/proj/dist"]) {
    assert.equal(hardDenyReason(command, hard), null, command);
  }
  const linux = { root: "/home/ana/proj", home: "/home/ana", platform: "linux" as const };
  assert.equal(hardDenyReason("rm -rf C:/Windows", linux), null, "no Linux, C:/Windows é uma pasta relativa");
  assert.ok(isSystemPath("C:\\Program Files (x86)\\", hard));
  assert.ok(!isSystemPath("C:\\Users\\Ana\\proj", hard));
});

test("Windows: Bash com caminhos do Git Bash e opção com caminho do Windows", async () => {
  const sandboxed: PolicyContext = { ...ctx, sandboxed: true };
  assert.equal((await decideBash("cat /c/Users/Ana/.ssh/config", sandboxed, W)).decision, "ask_user");
  assert.equal((await decideBash("cat 'C:\\Users\\Ana\\.ssh\\config'", sandboxed, W)).decision, "ask_user");
  assert.equal((await decideBash("ls '--color=C:\\x'", sandboxed, W)).decision, "ask_user");
});

test("Windows: saída para o modelo usa / e padrões aceitam \\ como separador", () => {
  assert.equal(toModelPath("src\\tools\\a.ts", W), "src/tools/a.ts");
  assert.equal(toModelPath("src/a\\b.ts", "linux"), "src/a\\b.ts");
  assert.equal(globPattern("src\\**\\*.ts", W), "src/**/*.ts");
  assert.equal(globPattern("src\\{a,b}\\*.ts", W), "src/{a,b}/*.ts");
  assert.equal(globPattern("src\\**", "linux"), "src\\**");
});

test("Windows: pasta temporária com o nome do usuário, e o mesmo projeto em qualquer grafia", () => {
  assert.equal(scratchUserDir(W, "C:\\Temp", safeUserName("Ana Maria")), "C:\\Temp\\plif-Ana_Maria");
  assert.equal(safeUserName(""), "user");
  assert.equal(safeUserName("DOMÍNIO\\joão"), "DOM_NIO_jo_o");
  assert.equal(scratchBase("C:\\Proj", W, "C:\\Temp\\plif-a"), scratchBase("c:\\proj\\", W, "C:\\Temp\\plif-a"));
  assert.notEqual(scratchBase("/home/a/Proj", "linux", "/tmp/plif-1"), scratchBase("/home/a/proj", "linux", "/tmp/plif-1"));
  if (process.getuid !== undefined) assert.equal(path.basename(scratchUserDir("linux", "/tmp")), `plif-${process.getuid()}`);
  const home = homeLayout("C:\\Users\\Ana\\.plif");
  assert.equal(memoryDirFor(home, "C:\\Proj", W), memoryDirFor(home, "c:\\PROJ", W));
});

test("Windows: permissões Unix ficam de fora sem erro", async () => {
  assert.equal(privateMode(0o600, W), undefined);
  assert.equal(privateMode(0o700, "linux"), 0o700);
  assert.equal(privateMode(0o600, "darwin"), 0o600);
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "plif-win-store-")));
  const store = new SessionStore(dir, W);
  await store.create("C:\\Users\\Ana\\Proj", "modelo");
  assert.equal((await store.list("c:\\users\\ana\\proj")).length, 1);
  assert.equal((await new SessionStore(dir, "linux").list("c:\\users\\ana\\proj")).length, 0);
});

test("Windows: instalação cria plif.cmd numa pasta do PATH ou diz qual acrescentar", async () => {
  const script = (await import(pathToFileURL(findRepoFile("scripts/link-dev.mjs")).href)) as {
    windowsLaunchers: (
      target: string,
      env: Record<string, string>,
      home: string,
      nodeProgram?: string,
    ) => { dir: string; onPath: boolean; files: Array<{ file: string; text: string }> };
  };
  const target = "C:\\Users\\Ana\\Plif\\dist\\core\\src\\cli.js";
  const nodeProgram = "C:\\Program Files\\nodejs\\node.exe";
  const npm = script.windowsLaunchers(
    target,
    { Path: "C:\\Windows;c:\\users\\ana\\appdata\\roaming\\npm\\", APPDATA: "C:\\Users\\Ana\\AppData\\Roaming" },
    HOME,
    nodeProgram,
  );
  assert.equal(npm.dir, "C:\\Users\\Ana\\AppData\\Roaming\\npm");
  assert.equal(npm.onPath, true);
  const cmd = npm.files.find((entry) => entry.file.endsWith("plif.cmd"));
  assert.equal(cmd?.text, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${nodeProgram}" "${target}" %*\r\n`);
  assert.ok(npm.files.some((entry) => entry.text.includes("exec '/c/Program Files/nodejs/node.exe' '/c/Users/Ana/Plif/dist/core/src/cli.js' \"$@\"")));

  const missing = script.windowsLaunchers(target, { PATH: "C:\\Windows" }, HOME);
  assert.equal(missing.dir, "C:\\Users\\Ana\\.local\\bin");
  assert.equal(missing.onPath, false);
  const special = script.windowsLaunchers("C:\\Users\\%NAME%!\\Plif\\cli.js", {}, HOME, nodeProgram);
  assert.ok(special.files.find((entry) => entry.file.endsWith(".cmd"))?.text.includes("\\%%NAME%%!\\"));
});

test("Windows: samePath compara como o sistema de arquivos de cada plataforma", () => {
  assert.ok(samePath("C:\\A\\b", "c:/a/B/", W));
  assert.ok(!samePath("/a/b", "/a/B", "linux"));
});

test("macOS compara nomes protegidos sem diferenciar maiúsculas; .aws é protegida em toda plataforma", () => {
  assert.equal(isProtectedRelative(".SSH/id_ed25519", "darwin"), true);
  assert.equal(isProtectedRelative("config/.Env.local", "darwin"), true);
  assert.equal(isProtectedRelative(".SSH/id_ed25519", "linux"), false);
  for (const platform of ["linux", "darwin", "win32"] as const) {
    assert.equal(isProtectedRelative(".aws/credentials", platform), true, platform);
  }
});
