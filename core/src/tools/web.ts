import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { imageBlock } from "../media.js";
import { isPublicAddress } from "../net/address.js";
import { fetchPage, parseWebUrl } from "../net/fetch-page.js";
import { htmlToMarkdown } from "../net/readable.js";
import { checkRobots } from "../net/robots.js";
import { ensureDirs, sessionScratch } from "../scratch.js";
import { maskSecrets } from "../secrets.js";
import { MAX_SHOTS, MAX_SHOT_SECONDS, renderPage } from "../web/browser.js";
import { SCOPES, search } from "../web/search.js";
import type { PolicyContext, Verdict } from "../types.js";
import type { Tool, ToolBlocks } from "./registry.js";

const PAGE_TEXT_LIMIT = 12_000;

const searchSchema = z.object({
  query: z.string().min(1).describe("What to search for, in the language that fits the scope."),
  scope: z
    .enum(SCOPES)
    .describe("web (general), wikipedia, papers (arXiv), code (GitHub repos), qa (Stack Overflow) or discussions (Hacker News)."),
});

export const webSearchTool: Tool<typeof searchSchema> = {
  name: "WebSearch",
  description: "Searches the web or a specific source and returns titles, URLs and snippets as JSON. Use it before stating facts that may be recent.",
  schema: searchSchema,
  async policy(input, ctx: PolicyContext): Promise<Verdict> {
    if (maskSecrets(input.query) !== input.query) {
      return { level: 2, decision: "deny", reason: "the query contains something that looks like a secret" };
    }
    return { level: 2, decision: "allow", reason: `search (${input.scope})` };
  },
  async run(input) {
    const outcome = await search(input.scope, input.query);
    return JSON.stringify({
      scope: outcome.scope,
      query: outcome.query,
      provider: outcome.provider,
      results: outcome.results,
      fetched_at: outcome.fetchedAt,
    });
  },
};

const fetchSchema = z.object({
  url: z.string().min(1).describe("Absolute http or https address of the page to read."),
});

// Both page tools read one address the model chose, so they share the same gate.
async function pagePolicy(raw: string, ctx: PolicyContext, action: string): Promise<Verdict> {
  let url: URL;
  try {
    url = parseWebUrl(raw);
  } catch (error) {
    return { level: 2, decision: "deny", reason: error instanceof Error ? error.message : "invalid URL" };
  }
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  const isLiteral = /^[\d.]+$/.test(literal) || literal.includes(":");
  if (url.hostname === "localhost" || (isLiteral && !isPublicAddress(literal))) {
    return { level: 2, decision: "deny", reason: "local and private addresses are not read" };
  }
  if ((ctx.webDomains ?? []).includes(url.hostname)) {
    return { level: 1, decision: "allow", reason: `domain released by the user: ${url.hostname}` };
  }
  return { level: 3, decision: "ask_user", reason: `${action} from ${url.hostname}` };
}

async function assertRobots(raw: string): Promise<void> {
  const url = parseWebUrl(raw);
  const verdict = await checkRobots(url);
  if (!verdict.allowed) throw new Error(`${url.host} does not allow Plif to read ${url.pathname}: ${verdict.reason}`);
}

export const webFetchTool: Tool<typeof fetchSchema> = {
  name: "WebFetch",
  description:
    "Reads one web page over HTTP and returns its main content as Markdown, in JSON. It does not run JavaScript. Respects robots.txt. Private and local addresses are refused.",
  schema: fetchSchema,
  policy: (input, ctx) => pagePolicy(input.url, ctx, "read a page"),
  async run(input, ctx) {
    await assertRobots(input.url);
    const page = await fetchPage(input.url, {
      acceptRedirectHost: (host) => (ctx.webDomains ?? []).includes(host),
    });
    const isHtml = page.contentType.includes("html");
    const extracted = isHtml
      ? htmlToMarkdown(page.body, page.finalUrl)
      : { title: "", markdown: page.body.trim(), extraction: "full" as const };
    const text = extracted.markdown.slice(0, PAGE_TEXT_LIMIT);
    return JSON.stringify({
      url: page.requestedUrl,
      final_url: page.finalUrl,
      title: extracted.title,
      extraction: extracted.extraction,
      text,
      truncated: page.truncated || text.length < extracted.markdown.length,
      ...(isHtml && extracted.markdown.length < THIN_PAGE_CHARS ? { hint: THIN_PAGE_HINT } : {}),
    });
  },
};

const THIN_PAGE_CHARS = 300;
const THIN_PAGE_HINT = "Little text came back. The page may build its content with JavaScript: WebView renders it in a real browser.";
const DEFAULT_SHOTS = [3, 10];
const VIEW_TEXT_LIMIT = 8_000;

const viewSchema = z.object({
  url: z.string().min(1).describe("Absolute http or https address of the page to open."),
  shots: z
    .array(z.number().int().min(0).max(MAX_SHOT_SECONDS))
    .min(1)
    .max(MAX_SHOTS)
    .optional()
    .describe(
      `Seconds after the page loads at which to take a screenshot, e.g. [3, 10]. Pages with an intro or loader need a late shot. Default ${JSON.stringify(DEFAULT_SHOTS)}.`,
    ),
});

export const webViewTool: Tool<typeof viewSchema, ToolBlocks> = {
  name: "WebView",
  description:
    "Opens a web page in a real headless browser (Chrome, Chromium, Edge or Brave found on the machine), waits real time, and returns screenshots you can see plus the rendered text as Markdown. Use it to see how a page looks or to read pages that need JavaScript. Respects robots.txt.",
  schema: viewSchema,
  strict: false,
  policy: (input, ctx) => pagePolicy(input.url, ctx, "open a page in the browser"),
  async run(input, ctx) {
    await assertRobots(input.url);
    const shots = [...new Set(input.shots ?? DEFAULT_SHOTS)].sort((a, b) => a - b);
    const page = await renderPage(input.url, { shots, acceptHost: (host) => (ctx.webDomains ?? []).includes(host) });
    const readable = htmlToMarkdown(page.html, page.finalUrl);
    const text = readable.markdown.slice(0, VIEW_TEXT_LIMIT);

    const folder = path.join(sessionScratch(ctx.root, ctx.session).scratchpad, "web");
    await ensureDirs(folder);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const host = new URL(page.finalUrl).hostname.replace(/[^a-z0-9.-]/gi, "_");
    const files: string[] = [];
    for (const shot of page.shots) {
      const file = path.join(folder, `${host}-${stamp}-${shot.atSeconds}s.jpg`);
      await writeFile(file, shot.jpeg, { mode: 0o600 });
      files.push(file);
    }

    const summary = {
      url: input.url,
      final_url: page.finalUrl,
      title: page.title || readable.title,
      browser: page.browser,
      load_event: page.loaded,
      screenshots: page.shots.map((shot, index) => ({ at_seconds: shot.atSeconds, file: files[index] })),
      blocked_requests: page.blocked,
      load_ms: page.loadMs,
      ...(page.notes.length > 0 ? { notes: page.notes } : {}),
      extraction: readable.extraction,
      text,
      truncated: text.length < readable.markdown.length,
    };
    const blocks: ToolBlocks = [{ type: "text", text: JSON.stringify(summary) }];
    for (const shot of page.shots) {
      blocks.push({ type: "text", text: `Screenshot ${shot.atSeconds}s after load (${VIEWPORT_LABEL}):` });
      blocks.push(imageBlock(shot.jpeg, "image/jpeg"));
    }
    return blocks;
  },
};

const VIEWPORT_LABEL = "1440x900";
