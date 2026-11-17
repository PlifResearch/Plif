import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
import { htmlToText } from "./html.js";

export interface ReadablePage {
  readonly title: string;
  readonly markdown: string;
  // "readability" when the article was found, "full" when the whole body was converted.
  readonly extraction: "readability" | "full";
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove(["script", "style", "noscript", "template", "iframe", "canvas", "form", "button", "select", "input"]);
turndown.remove((node) => node.nodeName.toLowerCase() === "svg");
// The default list item pads the marker to four columns ("-   one"); one space reads better and costs fewer tokens.
turndown.addRule("listItem", {
  filter: "li",
  replacement(content, node, options) {
    const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n  ");
    const parent = node.parentNode as HTMLElement | null;
    let prefix = `${options.bulletListMarker ?? "-"} `;
    if (parent?.nodeName === "OL") {
      const start = Number(parent.getAttribute("start") ?? "1");
      prefix = `${(Number.isFinite(start) ? start : 1) + Array.prototype.indexOf.call(parent.children, node)}. `;
    }
    return prefix + body + (node.nextSibling !== null && !body.endsWith("\n") ? "\n" : "");
  },
});

// jsdom only parses here: no scripts run and no subresource is loaded, which are its defaults.
export function htmlToMarkdown(html: string, url: string): ReadablePage {
  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  } catch {
    const plain = htmlToText(html);
    return { title: plain.title, markdown: plain.text, extraction: "full" };
  }
  const document = dom.window.document;
  const title = document.title.trim();
  const fallbackBody = document.body?.innerHTML ?? "";
  const article = new Readability(document).parse();
  dom.window.close();

  const content = article?.content ?? "";
  if (content.trim() !== "" && (article?.textContent ?? "").trim().length >= 200) {
    return { title: article?.title?.trim() || title, markdown: tidy(turndown.turndown(content)), extraction: "readability" };
  }
  return { title, markdown: tidy(turndown.turndown(fallbackBody)), extraction: "full" };
}

function tidy(markdown: string): string {
  const lines = markdown
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return joinLetterRuns(lines.split("\n\n")).join("\n\n");
}

// Animated headings often wrap each letter in its own block, which turns "powered" into seven paragraphs.
// Three or more one-letter paragraphs in a row are joined back into a word.
export function joinLetterRuns(paragraphs: readonly string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length >= 3) out.push(run.join(""));
    else out.push(...run);
    run = [];
  };
  for (const paragraph of paragraphs) {
    if (/^\p{L}$/u.test(paragraph)) {
      run.push(paragraph);
      continue;
    }
    flush();
    if (/^#{1,6}$/.test(paragraph)) continue;
    out.push(paragraph);
  }
  flush();
  return out;
}
