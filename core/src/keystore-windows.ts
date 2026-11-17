import { spawn } from "node:child_process";
import path from "node:path";
import type { KeyStore } from "./api-key.js";
import { windowsSystemDir } from "./platform.js";

export interface CredentialRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type CredentialRunner = (
  command: string,
  args: readonly string[],
  input: string,
  env: NodeJS.ProcessEnv,
) => Promise<CredentialRun>;

const NAME = /^[A-Za-z0-9_.-]+$/;
const SECRET = /^[A-Za-z0-9_.-]+$/;
const NOT_FOUND_EXIT = 3;
// Add-Type compiles the C# below on every run, which takes a few seconds on a cold start.
const TIMEOUT_MS = 30_000;

// Generic credentials of the Windows Credential Manager, through the Win32 API (wincred.h). cmdkey can store a
// credential but never read one back, and it would take the key as a command-line argument.
const CREDENTIAL_TYPE = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class PlifCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr buffer);

  private const uint GENERIC = 1;
  private const uint PERSIST_LOCAL_MACHINE = 2;
  private const int NOT_FOUND = 1168;

  public static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, GENERIC, 0, out pointer)) {
      int error = Marshal.GetLastWin32Error();
      if (error == NOT_FOUND) return null;
      throw new Win32Exception(error);
    }
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      if (credential.CredentialBlobSize == 0) return "";
      return Marshal.PtrToStringUni(credential.CredentialBlob, (int)credential.CredentialBlobSize / 2);
    } finally {
      CredFree(pointer);
    }
  }

  public static void Write(string target, string user, string secret) {
    byte[] bytes = Encoding.Unicode.GetBytes(secret);
    CREDENTIAL credential = new CREDENTIAL();
    credential.Type = GENERIC;
    credential.TargetName = target;
    credential.UserName = user;
    credential.Persist = PERSIST_LOCAL_MACHINE;
    credential.CredentialBlobSize = (uint)bytes.Length;
    credential.CredentialBlob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, credential.CredentialBlob, bytes.Length);
      if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      Marshal.FreeHGlobal(credential.CredentialBlob);
    }
  }

  public static void Delete(string target) {
    if (CredDelete(target, GENERIC, 0)) return;
    int error = Marshal.GetLastWin32Error();
    if (error != NOT_FOUND) throw new Win32Exception(error);
  }
}
`;

// The target and the action come by environment variable and the key by stdin, so nothing the caller passes is
// parsed as PowerShell, and the key never shows in the process arguments.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition @'",
  CREDENTIAL_TYPE.trim(),
  "'@",
  "switch ($env:PLIF_CREDENTIAL_ACTION) {",
  "  'read' {",
  "    $secret = [PlifCredential]::Read($env:PLIF_CREDENTIAL_TARGET)",
  `    if ($null -eq $secret) { exit ${NOT_FOUND_EXIT} }`,
  "    [Console]::Out.Write($secret)",
  "    exit 0",
  "  }",
  "  'write' {",
  "    $secret = [Console]::In.ReadLine()",
  "    [PlifCredential]::Write($env:PLIF_CREDENTIAL_TARGET, $env:PLIF_CREDENTIAL_USER, $secret)",
  "    exit 0",
  "  }",
  "  'delete' {",
  "    [PlifCredential]::Delete($env:PLIF_CREDENTIAL_TARGET)",
  "    exit 0",
  "  }",
  "}",
  "exit 1",
].join("\n");

// By absolute path: on Windows a bare name is also looked up in the working directory, which is the project.
export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(windowsSystemDir(env), "WindowsPowerShell", "v1.0", "powershell.exe");
}

export const POWERSHELL_ARGS: readonly string[] = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
  Buffer.from(SCRIPT, "utf16le").toString("base64"),
];

// Credentials are saved as "<service>:<account>", for example plif:ANTHROPIC_API_KEY, and the store touches no other.
export function windowsCredentialManager(service: string, runner: CredentialRunner = run): KeyStore {
  const call = (action: "read" | "write" | "delete", account: string, input = "") => {
    if (!NAME.test(service) || !NAME.test(account)) throw new Error("invalid keychain name");
    return runner(windowsPowerShell(), POWERSHELL_ARGS, input, {
      ...process.env,
      PLIF_CREDENTIAL_ACTION: action,
      PLIF_CREDENTIAL_TARGET: `${service}:${account}`,
      PLIF_CREDENTIAL_USER: account,
    });
  };
  return {
    label: "Windows Credential Manager",
    async read(account) {
      const result = await call("read", account);
      if (result.code === NOT_FOUND_EXIT) return null;
      // PowerShell reports errors as CLIXML when its streams are redirected, so only the exit code is passed on.
      if (result.code !== 0) throw new Error(`the Credential Manager did not return the key (exit ${result.code ?? "timeout"})`);
      const secret = result.stdout.replace(/\r?\n$/, "");
      return secret === "" ? null : secret;
    },
    async write(account, secret) {
      if (!SECRET.test(secret)) throw new Error("invalid key characters");
      const result = await call("write", account, `${secret}\n`);
      if (result.code !== 0) throw new Error("the Credential Manager did not store the key");
    },
    async remove(account) {
      const result = await call("delete", account);
      if (result.code !== 0) throw new Error("the Credential Manager did not remove the key");
    },
  };
}

// No console window and no detached process group: on Windows, detached opens a new console.
function run(command: string, args: readonly string[], input: string, env: NodeJS.ProcessEnv): Promise<CredentialRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true, timeout: TIMEOUT_MS });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
