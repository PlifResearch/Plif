import path from "node:path";
import { Box, Text } from "ink";
import { common, createLowlight } from "lowlight";
import React from "react";
import { theme, type ThemeName } from "./theme.js";

// Syntax colours for code in the terminal: fenced blocks in Markdown, file previews of Write and Edit, and Bash commands.
// highlight.js (through lowlight) finds keywords, strings, functions and types. Plain identifiers it leaves untagged
// get the variable colour here, so names stand apart from punctuation.

const lowlight = createLowlight(common);
const MAX_HIGHLIGHT_CHARS = 100_000;

type Role = "keyword" | "string" | "number" | "comment" | "function" | "type" | "variable" | "builtin" | "attr" | "tag" | "meta" | "regexp" | "deletion" | "addition";

const SYNTAX: Record<ThemeName, Record<Role, string>> = {
  dark: {
    keyword: "#C792EA",
    string: "#E8B45C",
    number: "#F78C6C",
    comment: "#8B9096",
    function: "#7C9FF2",
    type: "#89DDFF",
    variable: "#E6E1CF",
    builtin: "#82AAFF",
    attr: "#FFCB6B",
    tag: "#F07178",
    meta: "#8B9096",
    regexp: "#89DDFF",
    deletion: "#F0786F",
    addition: "#7C9FF2",
  },
  light: {
    keyword: "#7C3AED",
    string: "#9A5B00",
    number: "#B45309",
    comment: "#5F646B",
    function: "#2F5FD6",
    type: "#0E7490",
    variable: "#1F2937",
    builtin: "#1D4ED8",
    attr: "#92400E",
    tag: "#BE185D",
    meta: "#5F646B",
    regexp: "#0E7490",
    deletion: "#B42318",
    addition: "#2F5FD6",
  },
};

const CLASS_ROLE: Record<string, Role> = {
  keyword: "keyword",
  "selector-tag": "keyword",
  literal: "number",
  string: "string",
  "template-string": "string",
  char: "string",
  number: "number",
  comment: "comment",
  quote: "comment",
  doctag: "keyword",
  title: "function",
  function_: "function",
  section: "function",
  "class_": "type",
  type: "type",
  "title.class_": "type",
  "built_in": "builtin",
  variable: "variable",
  "template-variable": "variable",
  params: "variable",
  property: "attr",
  attr: "attr",
  attribute: "attr",
  "selector-attr": "attr",
  "selector-class": "attr",
  "selector-id": "attr",
  name: "tag",
  tag: "tag",
  meta: "meta",
  "meta keyword": "meta",
  regexp: "regexp",
  symbol: "regexp",
  link: "string",
  deletion: "deletion",
  addition: "addition",
  subst: "variable",
};

export interface Segment {
  readonly text: string;
  readonly color?: string;
  readonly italic?: boolean;
}

export type CodeLine = readonly Segment[];

interface HastNode {
  readonly type: string;
  readonly value?: string;
  readonly properties?: { readonly className?: readonly string[] };
  readonly children?: readonly HastNode[];
}

// The language of a fence label or a file name ("ts", "tsx", "Makefile", "src/a.py"). null when unknown.
// The set is lowlight's "common" bundle (37 languages, from Bash to YAML).
export function languageFor(label: string | undefined): string | null {
  if (label === undefined || label.trim() === "") return null;
  const raw = label.trim().toLowerCase();
  const base = path.basename(raw);
  const candidates = [raw, base, base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base];
  if (base === "makefile" || base === "gnumakefile") candidates.unshift("makefile");
  for (const candidate of candidates) {
    if (candidate !== "" && lowlight.registered(candidate)) return candidate;
  }
  return null;
}

// Splits code into coloured lines. Unknown languages and very long text come back as plain lines.
export function highlightLines(code: string, language: string | null, name: ThemeName = theme): CodeLine[] {
  const colors = SYNTAX[name];
  const plain = code.split("\n").map((line) => [{ text: line }]);
  if (language === null || code.length > MAX_HIGHLIGHT_CHARS) return plain;
  let tree: HastNode;
  try {
    tree = lowlight.highlight(language, code) as unknown as HastNode;
  } catch {
    return plain;
  }
  const lines: Segment[][] = [[]];
  const push = (text: string, role: Role | null) => {
    const parts = text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part === "") return;
      const current = lines[lines.length - 1] ?? [];
      if (role === null) {
        for (const piece of part.split(/([A-Za-z_$][\w$]*)/)) {
          if (piece === "") continue;
          current.push(/^[A-Za-z_$][\w$]*$/.test(piece) ? { text: piece, color: colors.variable } : { text: piece });
        }
      } else {
        current.push({ text: part, color: colors[role], italic: role === "comment" });
      }
    });
  };
  const walk = (node: HastNode, inherited: Role | null) => {
    if (node.type === "text") {
      push(node.value ?? "", inherited);
      return;
    }
    const classes = (node.properties?.className ?? []).map((name) => name.replace(/^hljs-/, ""));
    const role = classes.map((name) => CLASS_ROLE[name]).find((value) => value !== undefined) ?? inherited;
    for (const child of node.children ?? []) walk(child, role);
  };
  walk(tree, null);
  return lines;
}

// A long line wraps, and the continuation stays aligned after the prefix ("$ ", "- ", "│ ").
export function CodeLineView({ line, prefix }: { readonly line: CodeLine; readonly prefix?: React.ReactNode }): React.ReactElement {
  const body = (
    <Text wrap="wrap">
      {line.length === 0 ? " " : null}
      {line.map((segment, index) => (
        <Text key={index} color={segment.color} italic={segment.italic}>
          {segment.text}
        </Text>
      ))}
    </Text>
  );
  if (prefix === undefined) return body;
  return (
    <Box flexDirection="row">
      <Box flexShrink={0}>{prefix}</Box>
      <Box flexShrink={1} flexGrow={1}>
        {body}
      </Box>
    </Box>
  );
}
