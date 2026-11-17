import { type ChildProcess, spawn } from "node:child_process";
import dns from "node:dns";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex, Readable, Writable } from "node:stream";
import { isPublicAddress } from "../net/address.js";
import { killTree, treeSpawnOptions } from "../exec.js";
import { type Host, currentHost, envValue, isWindows } from "../platform.js";

// Renders a page in a real Chromium-family browser found on the machine, waits real time, and takes screenshots.
// Firefox is not driven: it dropped the DevTools protocol, and WebDriver BiDi would be a second client.

export const MAX_SHOTS = 4;
export const MAX_SHOT_SECONDS = 30;
const VIEWPORT = { width: 1440, height: 900 } as const;
const LOAD_TIMEOUT_MS = 20_000;
const NAVIGATE_TIMEOUT_MS = 30_000;
// A heavy 3D page can hold a screenshot for a long time while the CPU draws the frame. Each one gets this much.
const SHOT_TIMEOUT_MS = 12_000;
const EVALUATE_TIMEOUT_MS = 10_000;
// Past the last requested shot, the whole visit gets this much more before Plif returns what it has.
const VISIT_SLACK_MS = 25_000;
const MAX_HTML_CHARS = 2 * 1024 * 1024;

const LINUX_NAMES = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "microsoft-edge-stable", "microsoft-edge", "brave-browser"];
const LINUX_FIXED = ["/opt/google/chrome/chrome", "/snap/bin/chromium"];
const MAC_APPS: ReadonlyArray<readonly [string, string]> = [
  ["Google Chrome.app", "Google Chrome"],
  ["Chromium.app", "Chromium"],
  ["Microsoft Edge.app", "Microsoft Edge"],
  ["Brave Browser.app", "Brave Browser"],
];
const WINDOWS_APPS = ["Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"];

export interface BrowserHost extends Host {
  readonly listDir: (dir: string) => Promise<readonly string[]>;
  readonly home: string;
}

export function currentBrowserHost(): BrowserHost {
  return { ...currentHost(), home: os.homedir(), listDir: (dir) => readdir(dir).catch(() => []) };
}

// Order: PLIF_BROWSER_PATH, installed browsers, then the Chromium that Playwright downloads to its cache.
export async function findBrowser(host: BrowserHost = currentBrowserHost()): Promise<string | null> {
  const explicit = envValue(host.env, "PLIF_BROWSER_PATH");
  if (explicit !== undefined) return host.isFile(explicit) ? explicit : null;

  for (const candidate of installedCandidates(host)) if (host.isFile(candidate)) return candidate;

  const cache = playwrightCache(host);
  const builds = (await host.listDir(cache))
    .filter((entry) => /^chromium-\d+$/.test(entry))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const build of builds) {
    for (const relative of playwrightBinaries(host.platform)) {
      const candidate = joinFor(host.platform, cache, build, relative);
      if (host.isFile(candidate)) return candidate;
    }
  }
  return null;
}

function installedCandidates(host: BrowserHost): string[] {
  if (isWindows(host.platform)) {
    const roots = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"].map((name) => envValue(host.env, name)).filter((root) => root !== undefined);
    return WINDOWS_APPS.flatMap((app) => roots.map((root) => path.win32.join(root, app)));
  }
  if (host.platform === "darwin") {
    return ["/Applications", path.posix.join(host.home, "Applications")].flatMap((dir) =>
      MAC_APPS.map(([app, binary]) => path.posix.join(dir, app, "Contents", "MacOS", binary)),
    );
  }
  const dirs = (envValue(host.env, "PATH") ?? "").split(":").filter((dir) => path.posix.isAbsolute(dir));
  return [...LINUX_NAMES.flatMap((name) => dirs.map((dir) => path.posix.join(dir, name))), ...LINUX_FIXED];
}

function playwrightCache(host: BrowserHost): string {
  const custom = envValue(host.env, "PLAYWRIGHT_BROWSERS_PATH");
  if (custom !== undefined && custom !== "0") return custom;
  if (isWindows(host.platform)) return path.win32.join(envValue(host.env, "LOCALAPPDATA") ?? path.win32.join(host.home, "AppData", "Local"), "ms-playwright");
  if (host.platform === "darwin") return path.posix.join(host.home, "Library", "Caches", "ms-playwright");
  return path.posix.join(envValue(host.env, "XDG_CACHE_HOME") ?? path.posix.join(host.home, ".cache"), "ms-playwright");
}

function playwrightBinaries(platform: NodeJS.Platform): string[] {
  if (isWindows(platform)) return ["chrome-win64\\chrome.exe", "chrome-win\\chrome.exe"];
  if (platform === "darwin") {
    return ["chrome-mac-arm64", "chrome-mac-x64", "chrome-mac"].map((dir) => `${dir}/Chromium.app/Contents/MacOS/Chromium`);
  }
  return ["chrome-linux64/chrome", "chrome-linux/chrome"];
}

function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return isWindows(platform) ? path.win32.join(...parts) : path.posix.join(...parts);
}

// The browser reaches the network only through this proxy. It resolves each host once, refuses any
// non-public address, and connects to the address it checked, so DNS rebinding cannot reach the local network.
export interface GuardProxy {
  readonly url: string;
  readonly blocked: string[];
  close(): Promise<void>;
}

export type ResolveHost = (host: string) => Promise<readonly string[]>;

const defaultResolveHost: ResolveHost = async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

export async function publicAddressFor(hostname: string, resolve: ResolveHost = defaultResolveHost): Promise<string> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error(`blocked local address ${host}`);
  if (net.isIP(host) !== 0) {
    if (!isPublicAddress(host)) throw new Error(`blocked private address ${host}`);
    return host;
  }
  const addresses = await resolve(host);
  const first = addresses[0];
  if (first === undefined || addresses.some((address) => !isPublicAddress(address))) throw new Error(`blocked private address for ${host}`);
  return first;
}

export async function startGuardProxy(resolve: ResolveHost = defaultResolveHost): Promise<GuardProxy> {
  const blocked: string[] = [];
  const sockets = new Set<Duplex>();
  const refuse = (host: string, error: unknown): void => {
    if (blocked.length < 20) blocked.push(`${host}: ${error instanceof Error ? error.message : String(error)}`);
  };

  const server = http.createServer((request, response) => {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
      if (target.protocol !== "http:") throw new Error("only http goes through a plain proxy request");
    } catch (error) {
      response.writeHead(400).end();
      refuse(request.url ?? "?", error);
      return;
    }
    publicAddressFor(target.hostname, resolve).then(
      (address) => {
        const upstream = http.request(
          { host: address, port: target.port || 80, method: request.method, path: `${target.pathname}${target.search}`, headers: request.headers, setHost: false },
          (answer) => {
            response.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(response);
          },
        );
        upstream.once("error", () => response.destroy());
        request.pipe(upstream);
      },
      (error: unknown) => {
        refuse(target.hostname, error);
        response.writeHead(403).end();
      },
    );
  });

  server.on("connect", (request: http.IncomingMessage, client: Duplex, head: Buffer) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.once("error", () => client.destroy());
    const match = (request.url ?? "").match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
    if (match === null) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const hostname = match[1] ?? "";
    const port = Number(match[2]);
    publicAddressFor(hostname, resolve).then(
      (address) => {
        const upstream = net.connect(port, address, () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        sockets.add(upstream);
        upstream.once("close", () => sockets.delete(upstream));
        upstream.once("error", () => client.destroy());
      },
      (error: unknown) => {
        refuse(hostname, error);
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      },
    );
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    blocked,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

// The DevTools protocol over a private pipe (fd 3 in, fd 4 out), so no debugging port is open on the machine.
class Cdp {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>();
  private closedError: Error | null = null;

  constructor(
    private readonly input: Writable,
    output: Readable,
  ) {
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => this.receive(chunk));
    output.once("close", () => this.fail(new Error("the browser closed the DevTools pipe")));
    input.once("error", (error) => this.fail(error));
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.closedError !== null) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const message = JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.input.write(`${message}\0`);
    });
  }

  on(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let end = this.buffer.indexOf("\0");
    while (end !== -1) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      end = this.buffer.indexOf("\0");
      let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string }; sessionId?: string };
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error !== undefined) waiter?.reject(new Error(message.error.message ?? "DevTools error"));
        else waiter?.resolve(message.result ?? {});
      } else if (message.method !== undefined) {
        for (const listener of this.listeners) listener(message.method, message.params ?? {}, message.sessionId);
      }
    }
  }

  private fail(error: Error): void {
    if (this.closedError !== null) return;
    this.closedError = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}

export interface Shot {
  readonly atSeconds: number;
  readonly jpeg: Buffer;
}

export interface RenderedPage {
  readonly browser: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly html: string;
  readonly shots: readonly Shot[];
  readonly blocked: readonly string[];
  readonly loaded: boolean;
  // What went short: screenshots that timed out, the load event that never came, the time budget.
  readonly notes: readonly string[];
  readonly loadMs: number;
}

export interface RenderOptions {
  // Seconds after the load event, in increasing order.
  readonly shots: readonly number[];
  // Navigations of the page itself may only go to these hosts, besides the requested one.
  readonly acceptHost: (host: string) => boolean;
  readonly browserPath?: string;
  readonly signal?: AbortSignal;
}

export async function renderPage(input: string, options: RenderOptions): Promise<RenderedPage> {
  const browser = options.browserPath ?? (await findBrowser());
  if (browser === null) {
    throw new Error("no Chromium-family browser found (Chrome, Chromium, Edge or Brave). Install one or set PLIF_BROWSER_PATH");
  }
  const requested = new URL(input);
  const proxy = await startGuardProxy();
  const profile = await mkdtemp(path.join(os.tmpdir(), "plif-browser-"));
  let child: ChildProcess | null = null;
  try {
    child = spawn(browser, chromeArgs(profile, proxy.url), {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      ...treeSpawnOptions(process.platform),
    });
    const stderr: string[] = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.join("").length < 4000) stderr.push(chunk);
    });
    const exited = new Promise<never>((_, reject) => {
      child?.once("error", (error) => reject(new Error(`could not start ${browser}: ${error.message}`)));
      child?.once("exit", (code) => reject(new Error(`the browser exited (code ${code ?? "?"}): ${lastLine(stderr.join(""))}`)));
    });
    exited.catch(() => undefined);
    const stdio = child.stdio as unknown as [null, null, Readable, Writable, Readable];
    const cdp = new Cdp(stdio[3], stdio[4]);
    const aborted = abortPromise(options.signal);
    const race = <T>(work: Promise<T>): Promise<T> => Promise.race([work, exited, aborted]);

    const page = await race(drive(cdp, requested, options, race));
    await Promise.race([cdp.send("Browser.close").catch(() => undefined), delay(2000)]);
    await Promise.race([exited.catch(() => undefined), delay(2000)]);
    return { ...page, browser, blocked: [...proxy.blocked] };
  } finally {
    if (child?.pid !== undefined && child.exitCode === null) {
      try {
        killTree(child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    await proxy.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}

async function drive(
  cdp: Cdp,
  requested: URL,
  options: RenderOptions,
  race: <T>(work: Promise<T>) => Promise<T>,
): Promise<Omit<RenderedPage, "browser" | "blocked">> {
  const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
  const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  const call = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId);

  // The main frame of a page target carries the target id.
  let mainFrame = targetId;
  let refusedNavigation: string | null = null;
  let loadFired = false;
  let onLoad: () => void = () => undefined;
  const loaded = new Promise<void>((resolve) => {
    onLoad = resolve;
  });
  cdp.on((method, params, from) => {
    if (from !== sessionId) return;
    if (method === "Page.loadEventFired") {
      loadFired = true;
      onLoad();
    } else if (method === "Page.javascriptDialogOpening") {
      void call("Page.handleJavaScriptDialog", { accept: false }).catch(() => undefined);
    } else if (method === "Fetch.requestPaused") {
      const requestId = String(params["requestId"]);
      const url = String((params["request"] as { url?: string } | undefined)?.url ?? "");
      const isMain = params["frameId"] === mainFrame;
      let host = "";
      try {
        host = new URL(url).host;
      } catch {
        host = "";
      }
      if (isMain && host !== "" && host !== requested.host && !options.acceptHost(host)) {
        refusedNavigation ??= host;
        void call("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
      } else {
        void call("Fetch.continueRequest", { requestId }).catch(() => undefined);
      }
    }
  });

  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => undefined);
  await call("Fetch.enable", { patterns: [{ resourceType: "Document", requestStage: "Request" }] });

  const navigation = (await within(call("Page.navigate", { url: requested.href }), NAVIGATE_TIMEOUT_MS)) as { frameId?: string; errorText?: string } | null;
  if (navigation === null) throw new Error(`the page did not answer in ${NAVIGATE_TIMEOUT_MS / 1000}s`);
  mainFrame = navigation.frameId ?? mainFrame;
  if (navigation.errorText !== undefined && navigation.errorText !== "") {
    if (refusedNavigation !== null) throw new Error(`redirect to ${refusedNavigation} was not approved`);
    throw new Error(`the browser could not open the page: ${navigation.errorText}`);
  }
  const notes: string[] = [];
  const visitStart = Date.now();
  await race(Promise.race([loaded, delay(LOAD_TIMEOUT_MS)]));
  const start = Date.now();
  if (!loadFired) notes.push(`the load event did not come in ${LOAD_TIMEOUT_MS / 1000}s; the shots count from then`);
  const deadline = start + Math.max(0, ...options.shots) * 1000 + VISIT_SLACK_MS;

  const shots: Shot[] = [];
  for (const seconds of options.shots) {
    const wait = start + seconds * 1000 - Date.now();
    if (wait > 0) await race(delay(wait));
    if (Date.now() > deadline) {
      notes.push(`the visit ran out of time before the ${seconds}s shot`);
      break;
    }
    const taken = await race(within(call("Page.captureScreenshot", { format: "jpeg", quality: 80, optimizeForSpeed: true }), SHOT_TIMEOUT_MS));
    if (taken === null) {
      notes.push(`the ${seconds}s shot took over ${SHOT_TIMEOUT_MS / 1000}s (the page keeps the browser busy drawing) and was skipped`);
      continue;
    }
    shots.push({ atSeconds: seconds, jpeg: Buffer.from(String((taken as { data?: string }).data ?? ""), "base64") });
  }

  const evaluated = ((await race(
    within(
      call("Runtime.evaluate", {
        expression: "({ html: document.documentElement.outerHTML, title: document.title, url: location.href })",
        returnByValue: true,
      }),
      EVALUATE_TIMEOUT_MS,
    ),
  )) ?? {}) as { result?: { value?: { html?: string; title?: string; url?: string } } };
  if (evaluated.result === undefined) notes.push("the page did not give its text in time");
  const value = evaluated.result?.value ?? {};
  const finalUrl = value.url ?? requested.href;
  const finalHost = safeHost(finalUrl);
  if (finalHost !== null && finalHost !== requested.host && !options.acceptHost(finalHost)) {
    throw new Error(`redirect to ${finalHost} was not approved`);
  }
  if (refusedNavigation !== null && shots.length === 0) throw new Error(`redirect to ${refusedNavigation} was not approved`);
  return { finalUrl, title: value.title ?? "", html: (value.html ?? "").slice(0, MAX_HTML_CHARS), shots, loaded: loadFired, notes, loadMs: start - visitStart };
}

export function chromeArgs(profile: string, proxyUrl: string): string[] {
  return [
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
    `--proxy-server=${proxyUrl}`,
    // Without this, Chrome sends localhost straight past the proxy.
    "--proxy-bypass-list=<-loopback>",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--mute-audio",
    // Chrome no longer falls back to software WebGL by itself. Without it, 3D sites (three.js, WebGL loaders) never finish loading.
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--hide-scrollbars",
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    "about:blank",
  ];
}

function safeHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : null;
  } catch {
    return null;
  }
}

// The value, or null when it takes longer than ms. The late answer is dropped.
function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([work, delay(ms).then(() => null)]);
}

// Unref'd, so a timer left behind by a lost race does not hold the process open.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function abortPromise(signal: AbortSignal | undefined): Promise<never> {
  const promise = new Promise<never>((_, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) reject(new Error("stopped"));
    signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
  });
  promise.catch(() => undefined);
  return promise;
}

function lastLine(text: string): string {
  return (
    text
      .trim()
      .split("\n")
      .filter((line) => line.trim() !== "")
      .at(-1) ?? "no output"
  );
}
