import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import type { Config } from "./config.js";
import { isOfficialOpenAi } from "./openai-chat.js";
import { windowsCredentialManager } from "./keystore-windows.js";
import { isWindows } from "./platform.js";

// The key is stored in the operating system's keychain, under the name of the environment variable that holds it.
export const KEY_SERVICE = "plif";

export interface KeyStore {
  readonly label: string;
  read(account: string): Promise<string | null>;
  write(account: string, secret: string): Promise<void>;
  remove(account: string): Promise<void>;
}

export interface KeySetup {
  // keyless: the server answered without a key, so none was asked for.
  readonly source: "config" | "env" | "keychain" | "typed" | "keyless";
  // False when the key only lives in this process, because no keychain could store it.
  readonly persisted: boolean;
}

const NAME = /^[A-Za-z0-9_.-]+$/;
const SECRET = /^[A-Za-z0-9_.-]+$/;

export function platformKeyStore(service = KEY_SERVICE, platform: NodeJS.Platform = process.platform): KeyStore | null {
  if (platform === "darwin") return macKeychain(service);
  if (platform === "linux") return secretService(service);
  if (isWindows(platform)) return windowsCredentialManager(service);
  return null;
}

// Null means the key is acceptable. A string says what is wrong with it.
// Servers compatible with OpenAI use keys of their own shape, so `checkPrefix` is off for them.
export function keyProblem(key: string, anthropic: boolean, checkPrefix = true): string | null {
  if (key === "") return "the key is empty";
  if (!SECRET.test(key)) return "the key has characters that API keys do not contain";
  if (!checkPrefix) return null;
  if (key.length < 20) return "the key is too short";
  const prefix = anthropic ? "sk-ant-" : "sk-";
  if (!key.startsWith(prefix)) return `the key should start with ${prefix}`;
  return null;
}

// Uses the key in config.toml first, then the environment variable, then the keychain. When none has a key and
// `keyOptional` says the server answers without one, nothing is asked. Otherwise `ask` returns the typed key,
// or null when the person cancels.
export async function ensureApiKey(options: {
  readonly envName: string;
  readonly anthropic: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly store: KeyStore | null;
  readonly ask: (problem: string | null) => Promise<string | null>;
  readonly configKey?: string | undefined;
  readonly keyOptional?: () => Promise<boolean>;
  readonly checkPrefix?: boolean;
}): Promise<KeySetup | null> {
  const { envName, env, store } = options;
  if ((options.configKey ?? "") !== "") return { source: "config", persisted: true };
  if ((env[envName] ?? "") !== "") return { source: "env", persisted: store !== null };

  let problem: string | null = null;
  if (store !== null) {
    try {
      const stored = await store.read(envName);
      if (stored !== null && stored !== "") {
        env[envName] = stored;
        return { source: "keychain", persisted: true };
      }
    } catch (error) {
      // An unreachable keychain is not the same as a missing key: the person is told why.
      problem = `could not read the system keychain: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  if (options.keyOptional !== undefined && (await options.keyOptional())) return { source: "keyless", persisted: true };

  for (;;) {
    const typed = await options.ask(problem);
    if (typed === null) return null;
    const key = typed.trim();
    problem = keyProblem(key, options.anthropic, options.checkPrefix ?? true);
    if (problem !== null) continue;

    env[envName] = key;
    if (store === null) return { source: "typed", persisted: false };
    try {
      await store.write(envName, key);
      return { source: "typed", persisted: true };
    } catch {
      return { source: "typed", persisted: false };
    }
  }
}

// The parts of ensureApiKey() that come from [provider]. Only a compatible server other than OpenAI's is probed.
export function providerKeyOptions(provider: Config["provider"], cacheFile: string) {
  const anthropic = provider.kind === "anthropic";
  const compatible = !anthropic && !isOfficialOpenAi(provider.base_url);
  const baseUrl = provider.base_url;
  return {
    envName: provider.api_key_env ?? (anthropic ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"),
    anthropic,
    configKey: provider.api_key,
    checkPrefix: !compatible,
    ...(compatible && baseUrl !== undefined
      ? { keyOptional: async () => (await probeKeyRequired({ baseUrl, cacheFile })) === false }
      : {}),
  };
}

const PROBE_TIMEOUT_MS = 3_000;
const PROBE_TTL_MS = 24 * 60 * 60 * 1000;

interface ProbeCache {
  [baseUrl: string]: { readonly required: boolean; readonly at: number };
}

// Asks GET {baseUrl}/models without a key. True: the server wants a key (401 or 403). False: it answered 200.
// Null: no answer or another status, and the caller keeps asking for the key. Only true and false are cached.
export async function probeKeyRequired(options: {
  readonly baseUrl: string;
  readonly cacheFile?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: number;
}): Promise<boolean | null> {
  const base = options.baseUrl.replace(/\/+$/, "");
  const now = options.now ?? Date.now();
  const cache = options.cacheFile === undefined ? {} : await readProbeCache(options.cacheFile);
  const cached = cache[base];
  if (cached !== undefined && now - cached.at < PROBE_TTL_MS) return cached.required;

  let required: boolean | null;
  try {
    const response = await (options.fetch ?? fetch)(`${base}/models`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
      redirect: "error",
    });
    await response.body?.cancel();
    required = response.status === 200 ? false : response.status === 401 || response.status === 403 ? true : null;
  } catch {
    required = null;
  }
  if (required !== null && options.cacheFile !== undefined) {
    const next: ProbeCache = { ...cache, [base]: { required, at: now } };
    await writeFile(options.cacheFile, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }).catch(() => {});
  }
  return required;
}

async function readProbeCache(file: string): Promise<ProbeCache> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    const entries = Object.entries(value).filter(
      (entry): entry is [string, { required: boolean; at: number }] =>
        typeof entry[1] === "object" && entry[1] !== null && typeof entry[1].required === "boolean" && typeof entry[1].at === "number",
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function macKeychain(service: string): KeyStore {
  return {
    label: "macOS Keychain",
    async read(account) {
      checkName(service, account);
      const result = await run("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
      if (result.code === 44) return null;
      if (result.code !== 0) throw new Error("the keychain did not return the key");
      return result.stdout.replace(/\n$/, "");
    },
    async write(account, secret) {
      checkName(service, account);
      checkSecret(secret);
      // The secret goes through stdin of `security -i`, so it is never in the process arguments.
      const result = await run("security", ["-i"], `add-generic-password -U -s ${service} -a ${account} -w ${secret}\n`);
      if (result.code !== 0) throw new Error("the keychain did not store the key");
    },
    async remove(account) {
      checkName(service, account);
      const result = await run("security", ["delete-generic-password", "-s", service, "-a", account]);
      if (result.code !== 0 && result.code !== 44) throw new Error("the keychain did not remove the key");
    },
  };
}

function secretService(service: string): KeyStore {
  return {
    label: "system keychain (libsecret)",
    async read(account) {
      checkName(service, account);
      const result = await run("secret-tool", ["lookup", "service", service, "account", account]);
      if (result.code === 0 && result.stdout !== "") return result.stdout.replace(/\n$/, "");
      // A lookup that finds nothing prints nothing on stderr. Anything on stderr means the service itself failed.
      if (result.stderr.trim() !== "") throw new Error(result.stderr.trim().split("\n")[0] ?? "service unavailable");
      return null;
    },
    async write(account, secret) {
      checkName(service, account);
      checkSecret(secret);
      const result = await run(
        "secret-tool",
        ["store", "--label", `Plif ${account}`, "service", service, "account", account],
        secret,
      );
      if (result.code !== 0) throw new Error("the secret service did not store the key");
    },
    async remove(account) {
      checkName(service, account);
      const result = await run("secret-tool", ["clear", "service", service, "account", account]);
      if (result.code !== 0) throw new Error("the secret service did not remove the key");
    },
  };
}

function checkName(service: string, account: string): void {
  if (!NAME.test(service) || !NAME.test(account)) throw new Error("invalid keychain name");
}

function checkSecret(secret: string): void {
  if (!SECRET.test(secret)) throw new Error("invalid key characters");
}

// Output is returned only to the caller that parses it. Errors never carry the input back.
function run(
  command: string,
  args: string[],
  input?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
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
    child.stdin.end(input ?? "");
  });
}
