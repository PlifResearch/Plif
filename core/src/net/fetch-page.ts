import dns from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { isPublicAddress } from "./address.js";

export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const ACCEPTED_TYPES = ["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "application/json"];
export const USER_AGENT = "Plif/0.1 (+https://github.com/PlifResearch)";

export interface Resolve {
  (host: string): Promise<readonly string[]>;
}

export interface Send {
  (url: URL, signal: AbortSignal): Promise<Response>;
}

export interface PageOptions {
  readonly send?: Send;
  readonly resolve?: Resolve;
  // Redirects to another host are followed only when this accepts that host.
  readonly acceptRedirectHost?: (host: string) => boolean;
}

export interface FetchedPage {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly contentType: string;
  readonly body: string;
  readonly truncated: boolean;
}

export function parseWebUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https URLs are allowed");
  if (url.username !== "" || url.password !== "") throw new Error("URLs with user and password are not allowed");
  return url;
}

// Resolves the host once per connection, refuses any non-public address, and connects to the validated one.
function validatingLookup(
  host: string,
  options: { all?: boolean },
  callback: (error: Error | null, address?: unknown, family?: number) => void,
): void {
  dns.lookup(host, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (addresses.some((entry) => !isPublicAddress(entry.address))) {
      return callback(new Error(`blocked private address for ${host}`));
    }
    if (options.all === true) return callback(null, addresses);
    const first = addresses[0];
    if (first === undefined) return callback(new Error(`no address for ${host}`));
    return callback(null, first.address, first.family);
  });
}

const dispatcher = new Agent({ connect: { lookup: validatingLookup as never } });

const defaultSend: Send = (url, signal) =>
  undiciFetch(url, {
    dispatcher,
    redirect: "manual",
    signal,
    headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1" },
  }) as unknown as Promise<Response>;

const defaultResolve: Resolve = async (host) => {
  const entries = await dns.promises.lookup(host, { all: true, verbatim: true });
  return entries.map((entry) => entry.address);
};

export async function fetchPage(input: string, options: PageOptions = {}): Promise<FetchedPage> {
  const send = options.send ?? defaultSend;
  const resolve = options.resolve ?? defaultResolve;
  const requested = parseWebUrl(input);
  let url = requested;

  for (let hop = 0; ; hop++) {
    if (hop > 0 && url.host !== requested.host && !(options.acceptRedirectHost?.(url.host) ?? false)) {
      throw new Error(`redirect to ${url.host} was not approved`);
    }
    await assertPublicHost(url.hostname, resolve);
    const response = await send(url, AbortSignal.timeout(REQUEST_TIMEOUT_MS));

    const location = response.headers.get("location");
    if (REDIRECT_CODES.has(response.status) && location !== null) {
      if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
      url = parseWebUrl(new URL(location, url).href);
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ACCEPTED_TYPES.includes(contentType)) throw new Error(`unsupported content type: ${contentType || "unknown"}`);
    const { text, truncated } = await readLimited(response);
    return { requestedUrl: input, finalUrl: url.href, contentType, body: text, truncated };
  }
}

async function assertPublicHost(hostname: string, resolve: Resolve): Promise<void> {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error("blocked local address");
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(literal) || literal.includes(":")) {
    if (!isPublicAddress(literal)) throw new Error("blocked private address");
    return;
  }
  const addresses = await resolve(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new Error(`blocked private address for ${hostname}`);
  }
}

async function readLimited(response: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = MAX_PAGE_BYTES - size;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      size = MAX_PAGE_BYTES;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}
