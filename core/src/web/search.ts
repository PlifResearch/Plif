import { decodeEntities, htmlToText } from "../net/html.js";
import { USER_AGENT } from "../net/fetch-page.js";

export const SCOPES = ["web", "wikipedia", "papers", "code", "qa", "discussions"] as const;
export type Scope = (typeof SCOPES)[number];

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly source: string;
}

export interface SearchOutcome {
  readonly scope: Scope;
  readonly query: string;
  readonly provider: string;
  readonly results: readonly SearchResult[];
  readonly fetchedAt: string;
}

export class ProviderError extends Error {}

const MAX_RESULTS = 10;
const MIN_INTERVAL_MS = 2_000;
const CACHE_TTL_MS = 15 * 60 * 1000;

type Fetcher = typeof fetch;

export interface SearchOptions {
  readonly fetch?: Fetcher;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const lastRequest = new Map<string, number>();
const cache = new Map<string, { readonly at: number; readonly outcome: SearchOutcome }>();

export async function search(scope: Scope, query: string, options: SearchOptions = {}): Promise<SearchOutcome> {
  const now = options.now ?? Date.now;
  const key = `${scope}\n${query}`;
  const cached = cache.get(key);
  if (cached !== undefined && now() - cached.at < CACHE_TTL_MS) return cached.outcome;

  const providers = PROVIDERS[scope];
  let lastError: unknown = null;
  for (const provider of providers) {
    try {
      const found = await provider.run(query, options);
      const outcome: SearchOutcome = {
        scope,
        query,
        provider: provider.name,
        results: found.slice(0, MAX_RESULTS),
        fetchedAt: new Date(now()).toISOString(),
      };
      cache.set(key, { at: now(), outcome });
      return outcome;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new ProviderError("no provider answered");
}

interface Provider {
  readonly name: string;
  run(query: string, options: SearchOptions): Promise<readonly SearchResult[]>;
}

const PROVIDERS: Record<Scope, readonly Provider[]> = {
  web: [
    { name: "duckduckgo", run: duckDuckGo },
    { name: "duckduckgo-lite", run: duckDuckGoLite },
  ],
  wikipedia: [
    { name: "wikipedia-pt", run: (query, options) => wikipedia("pt", query, options) },
    { name: "wikipedia-en", run: (query, options) => wikipedia("en", query, options) },
  ],
  papers: [{ name: "arxiv", run: arxiv }],
  code: [{ name: "github", run: github }],
  qa: [{ name: "stackexchange", run: stackExchange }],
  discussions: [{ name: "hackernews", run: hackerNews }],
};

async function get(host: string, url: string, options: SearchOptions, accept = "*/*"): Promise<string> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const last = lastRequest.get(host) ?? 0;
  const wait = last + MIN_INTERVAL_MS - now();
  if (wait > 0) await sleep(wait);
  lastRequest.set(host, now());

  const send = options.fetch ?? fetch;
  const response = await send(url, {
    headers: { "user-agent": USER_AGENT, accept },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new ProviderError(`${host} answered HTTP ${response.status}`);
  return response.text();
}

async function duckDuckGo(query: string, options: SearchOptions): Promise<readonly SearchResult[]> {
  const html = await get("html.duckduckgo.com", `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, options, "text/html");
  if (html.includes("anomaly")) throw new ProviderError("duckduckgo blocked this request; try again later");
  const results = parseDuckDuckGo(html);
  // Zero parsed results usually means the markup changed, so Lite gets a chance before "nothing found".
  if (results.length === 0) throw new ProviderError("duckduckgo html returned no parsable results");
  return results;
}

async function duckDuckGoLite(query: string, options: SearchOptions): Promise<readonly SearchResult[]> {
  const html = await get("lite.duckduckgo.com", `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, options, "text/html");
  if (html.includes("anomaly")) throw new ProviderError("duckduckgo lite blocked this request; try again later");
  return parseDuckDuckGoLite(html);
}

// Lite is a table: the `result-link` anchor, then the `result-snippet` cell, before the next anchor.
export function parseDuckDuckGoLite(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const block of html.split(/(?=<a[^>]*class=['"]result-link['"])/).slice(1)) {
    const anchor = block.match(/^<a[^>]*>[\s\S]*?<\/a>/);
    if (anchor === null) continue;
    const href = decodeEntities(anchor[0].match(/href=['"]([^'"]+)['"]/)?.[1] ?? "");
    if (href.includes("duckduckgo.com/y.js")) continue;
    const url = unwrapDuckDuckGo(href);
    if (url === null) continue;
    const snippet = clean(block.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/)?.[1] ?? "");
    results.push({ title: clean(anchor[0]), url, snippet, source: "duckduckgo-lite" });
  }
  return results;
}

// Each result sits in its own container. Ads point at duckduckgo.com/y.js and are dropped.
export function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const block of html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1)) {
    const anchor = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*>[\s\S]*?<\/a>/);
    if (anchor === null) continue;
    const href = anchor[0].match(/href="([^"]+)"/)?.[1] ?? "";
    if (href.includes("duckduckgo.com/y.js")) continue;
    const url = unwrapDuckDuckGo(href);
    if (url === null) continue;
    const title = clean(anchor[0]);
    const snippet = clean(block.match(/result__snippet[^>]*>([\s\S]*?)<\/(?:a|div)>/)?.[1] ?? "");
    results.push({ title, url, snippet, source: "duckduckgo" });
  }
  return results;
}

function unwrapDuckDuckGo(href: string): string | null {
  const absolute = href.startsWith("//") ? `https:${href}` : href;
  const target = absolute.match(/[?&]uddg=([^&]+)/)?.[1];
  const url = target !== undefined ? decodeURIComponent(target) : absolute;
  return /^https?:\/\//.test(url) ? url : null;
}

async function wikipedia(lang: "pt" | "en", query: string, options: SearchOptions): Promise<readonly SearchResult[]> {
  const host = `${lang}.wikipedia.org`;
  const body = await get(
    host,
    `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${MAX_RESULTS}&format=json&utf8=1`,
    options,
    "application/json",
  );
  return parseWikipedia(body, lang);
}

export function parseWikipedia(body: string, lang: "pt" | "en"): SearchResult[] {
  const hits = (JSON.parse(body) as { query?: { search?: Array<{ title: string; snippet: string }> } }).query?.search ?? [];
  return hits.map((hit) => ({
    title: hit.title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`,
    snippet: clean(hit.snippet),
    source: `wikipedia-${lang}`,
  }));
}

async function arxiv(query: string, options: SearchOptions): Promise<readonly SearchResult[]> {
  const xml = await get(
    "export.arxiv.org",
    `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${MAX_RESULTS}`,
    options,
    "application/atom+xml",
  );
  return parseArxiv(xml);
}

export function parseArxiv(xml: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const entry of xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []) {
    const title = clean(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const url = clean(entry.match(/<id>([\s\S]*?)<\/id>/)?.[1] ?? "");
    const snippet = clean(entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? "");
    if (url !== "") results.push({ title, url, snippet, source: "arxiv" });
  }
  return results;
}

async function github(query: string, options: SearchOptions): Promise<readonly SearchResult[]> {
  const body = await get(
    "api.github.com",
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${MAX_RESULTS}&sort=stars`,
    options,
    "application/vnd.github+json",
  );
  const items = (JSON.parse(body) as { items?: Array<{ full_name: string; html_url: string; description: string | null; stargazers_count: number }> }).items ?? [];
  return items.map((item) => ({
    title: item.full_name,
    url: item.html_url,
    snippet: `${item.description ?? "no description"} (${item.stargazers_count} stars)`,
    source: "github",
  }));
}

async function stackExchange(query: string, options: SearchOptions): Promise<readonly SearchResult[]> {
  const body = await get(
    "api.stackexchange.com",
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${MAX_RESULTS}`,
    options,
    "application/json",
  );
  const items = (JSON.parse(body) as { items?: Array<{ title: string; link: string; score: number; is_answered: boolean }> }).items ?? [];
  return items.map((item) => ({
    title: decodeEntities(item.title),
    url: item.link,
    snippet: `score ${item.score}${item.is_answered ? ", answered" : ""}`,
    source: "stackoverflow",
  }));
}

async function hackerNews(query: string, options: SearchOptions): Promise<readonly SearchResult[]> {
  const body = await get(
    "hn.algolia.com",
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${MAX_RESULTS}`,
    options,
    "application/json",
  );
  const hits = (JSON.parse(body) as { hits?: Array<{ title: string | null; url: string | null; objectID: string; points: number | null }> }).hits ?? [];
  return hits
    .filter((hit) => hit.title !== null)
    .map((hit) => ({
      title: hit.title ?? "",
      url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      snippet: `${hit.points ?? 0} points`,
      source: "hackernews",
    }));
}

function clean(fragment: string): string {
  return htmlToText(fragment).text.replace(/\s+/g, " ").trim();
}
