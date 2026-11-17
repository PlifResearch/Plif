import { type FetchedPage, fetchPage } from "./fetch-page.js";

// robots.txt as in RFC 9309: the group for the Plif token wins over `*`, the longest matching rule decides,
// and Allow wins a tie. A missing file allows everything; an unreachable one disallows everything.

export const ROBOTS_TOKEN = "plif";
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_ROBOTS_CHARS = 500 * 1024;

interface Rule {
  readonly allow: boolean;
  readonly pattern: string;
}

export type RobotsRules = { readonly kind: "rules"; readonly rules: readonly Rule[] } | { readonly kind: "allow_all" } | { readonly kind: "disallow_all"; readonly reason: string };

export interface RobotsVerdict {
  readonly allowed: boolean;
  readonly reason: string;
}

export function parseRobots(text: string, token: string = ROBOTS_TOKEN): RobotsRules {
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.slice(0, MAX_ROBOTS_CHARS).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const match = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (match === null) continue;
    const field = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();
    if (field === "user-agent") {
      if (current === null || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === null) continue;
    if (field === "allow" || field === "disallow") {
      // An empty Disallow means "nothing is disallowed"; an empty Allow says nothing.
      if (value !== "") current.rules.push({ allow: field === "allow", pattern: value });
    }
  }
  const own = groups.filter((group) => group.agents.includes(token));
  const chosen = own.length > 0 ? own : groups.filter((group) => group.agents.includes("*"));
  return { kind: "rules", rules: chosen.flatMap((group) => group.rules) };
}

export function isPathAllowed(rules: RobotsRules, pathAndQuery: string): RobotsVerdict {
  if (rules.kind === "allow_all") return { allowed: true, reason: "no robots.txt" };
  if (rules.kind === "disallow_all") return { allowed: false, reason: rules.reason };
  if (pathAndQuery === "/robots.txt") return { allowed: true, reason: "robots.txt itself" };
  let best: Rule | null = null;
  for (const rule of rules.rules) {
    if (!matches(rule.pattern, pathAndQuery)) continue;
    if (best === null || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  if (best === null || best.allow) return { allowed: true, reason: best === null ? "no rule matches" : `Allow: ${best.pattern}` };
  return { allowed: false, reason: `robots.txt has Disallow: ${best.pattern}` };
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split("*")
    .map((part) => normalize(part).replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(normalize(path));
}

// Percent-encoding in rules and in URLs is compared in one form, so `/caf%C3%A9` matches `/café`.
function normalize(value: string): string {
  try {
    return encodeURI(decodeURI(value));
  } catch {
    return value;
  }
}

export interface RobotsOptions {
  readonly load?: (url: string) => Promise<FetchedPage>;
  readonly now?: () => number;
}

const cache = new Map<string, { readonly at: number; readonly rules: RobotsRules }>();

export async function checkRobots(target: URL, options: RobotsOptions = {}): Promise<RobotsVerdict> {
  const now = options.now ?? Date.now;
  const origin = target.origin;
  const cached = cache.get(origin);
  const rules = cached !== undefined && now() - cached.at < CACHE_TTL_MS ? cached.rules : await loadRobots(origin, options);
  if (cached?.rules !== rules) cache.set(origin, { at: now(), rules });
  return isPathAllowed(rules, `${target.pathname}${target.search}`);
}

async function loadRobots(origin: string, options: RobotsOptions): Promise<RobotsRules> {
  const load = options.load ?? ((url: string) => fetchPage(url, { acceptRedirectHost: () => true }));
  try {
    const page = await load(`${origin}/robots.txt`);
    return parseRobots(page.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(message.match(/^HTTP (\d{3})$/)?.[1] ?? Number.NaN);
    // 4xx means there is no file to follow. Anything else (5xx, timeout, network) may hide a real refusal.
    if (status >= 400 && status < 500) return { kind: "allow_all" };
    if (message.startsWith("unsupported content type")) return { kind: "allow_all" };
    return { kind: "disallow_all", reason: `robots.txt could not be read (${message}), so the site is treated as closed` };
  }
}

export function clearRobotsCache(): void {
  cache.clear();
}
