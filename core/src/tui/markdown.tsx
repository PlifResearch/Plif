import { Box, Text } from "ink";
import { type Token, type Tokens, lexer } from "marked";
import React from "react";
import { decodeEntities } from "../net/html.js";
import { CodeLineView, highlightLines, languageFor } from "./syntax.js";
import { ascii, MEASURE, palette } from "./theme.js";

// Markdown in the terminal: CommonMark plus GitHub extensions (tables, task lists, strikethrough, autolinks),
// parsed by marked's lexer and drawn with Ink. Nothing is converted to HTML on the way.

const BULLETS = ascii ? ["-", "*", "+"] : ["•", "◦", "▪"];
const QUOTE_BAR = ascii ? "|" : "▎";
const CODE_BAR = ascii ? "|" : "│";
const RULE = ascii ? "-" : "─";

export function Markdown({ text, width = MEASURE }: { readonly text: string; readonly width?: number }): React.ReactElement {
  const tokens = lexer(text, { gfm: true });
  return <Box flexDirection="column">{blocks(tokens, width, 0)}</Box>;
}

function blocks(tokens: readonly Token[], width: number, depth: number): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let first = true;
  tokens.forEach((token, index) => {
    if (token.type === "space" || token.type === "def") return;
    const node = block(token, width, depth, index);
    if (node === null) return;
    out.push(
      <Box key={index} marginTop={first ? 0 : 1} flexDirection="column">
        {node}
      </Box>,
    );
    first = false;
  });
  return out;
}

function block(token: Token, width: number, depth: number, key: number): React.ReactNode {
  switch (token.type) {
    case "heading": {
      const { depth: level, tokens } = token as Tokens.Heading;
      const color = level <= 2 ? palette.accent : level >= 4 ? palette.meta : undefined;
      return (
        <Text bold underline={level === 1} color={color}>
          {inline(tokens)}
        </Text>
      );
    }
    case "paragraph":
      return <Text>{inline((token as Tokens.Paragraph).tokens)}</Text>;
    case "text": {
      const textToken = token as Tokens.Text;
      return <Text>{textToken.tokens === undefined ? decodeEntities(textToken.text) : inline(textToken.tokens)}</Text>;
    }
    case "code":
      return <CodeBlock code={(token as Tokens.Code).text} lang={(token as Tokens.Code).lang} />;
    case "blockquote":
      return (
        <Box flexDirection="row">
          <Box flexShrink={0} marginRight={1}>
            <Text color={palette.meta}>{QUOTE_BAR}</Text>
          </Box>
          <Box flexDirection="column" flexShrink={1}>
            {blocks((token as Tokens.Blockquote).tokens, width - 2, depth)}
          </Box>
        </Box>
      );
    case "list":
      return <List list={token as Tokens.List} width={width} depth={depth} />;
    case "table":
      return <Table table={token as Tokens.Table} width={width} />;
    case "hr":
      return <Text color={palette.meta}>{RULE.repeat(Math.max(3, Math.min(width, 40)))}</Text>;
    case "html":
      return <Text color={palette.meta}>{(token as Tokens.HTML).text.trimEnd()}</Text>;
    default:
      return "raw" in token && typeof token.raw === "string" ? <Text key={key}>{token.raw.trimEnd()}</Text> : null;
  }
}

function inline(tokens: readonly Token[] | undefined): React.ReactNode[] {
  return (tokens ?? []).map((token, index) => {
    switch (token.type) {
      case "strong":
        return (
          <Text key={index} bold>
            {inline((token as Tokens.Strong).tokens)}
          </Text>
        );
      case "em":
        return (
          <Text key={index} italic>
            {inline((token as Tokens.Em).tokens)}
          </Text>
        );
      case "del":
        return (
          <Text key={index} strikethrough>
            {inline((token as Tokens.Del).tokens)}
          </Text>
        );
      case "codespan":
        return (
          <Text key={index} color={palette.accent}>
            {decodeEntities((token as Tokens.Codespan).text)}
          </Text>
        );
      case "link": {
        const link = token as Tokens.Link;
        const label = plain(link.tokens);
        const href = link.href.replace(/^mailto:/, "");
        return (
          <Text key={index}>
            <Text color={palette.accent} underline>
              {inline(link.tokens)}
            </Text>
            {label === href || label === link.href ? null : <Text color={palette.meta}>{` (${link.href})`}</Text>}
          </Text>
        );
      }
      case "image": {
        const image = token as Tokens.Image;
        return <Text key={index} color={palette.meta}>{`[image${image.text === "" ? "" : `: ${image.text}`}] ${image.href}`}</Text>;
      }
      case "br":
        return <Text key={index}>{"\n"}</Text>;
      case "escape":
        return <Text key={index}>{(token as Tokens.Escape).text}</Text>;
      case "html":
        return (
          <Text key={index} color={palette.meta}>
            {(token as Tokens.HTML).text}
          </Text>
        );
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens !== undefined && text.tokens.length > 0 ? <Text key={index}>{inline(text.tokens)}</Text> : <Text key={index}>{decodeEntities(text.text)}</Text>;
      }
      default:
        return <Text key={index}>{"raw" in token && typeof token.raw === "string" ? token.raw : ""}</Text>;
    }
  });
}

// The words of inline tokens, without styling: for table widths and link labels.
export function plain(tokens: readonly Token[] | undefined): string {
  return (tokens ?? [])
    .map((token) => {
      if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.length > 0) return plain(token.tokens);
      if (token.type === "image") return `[image: ${(token as Tokens.Image).text}]`;
      if (token.type === "br") return " ";
      return decodeEntities("text" in token && typeof token.text === "string" ? token.text : "");
    })
    .join("");
}

function CodeBlock({ code, lang }: { readonly code: string; readonly lang?: string }): React.ReactElement {
  const label = (lang ?? "").trim().split(/\s+/)[0] ?? "";
  const lines = highlightLines(code.replace(/\n$/, ""), languageFor(label));
  return (
    <Box flexDirection="column">
      {label === "" ? null : <Text color={palette.meta}>{label}</Text>}
      {lines.map((line, index) => (
        <CodeLineView key={index} line={line} prefix={<Text color={palette.meta}>{`${CODE_BAR} `}</Text>} />
      ))}
    </Box>
  );
}

function List({ list, width, depth }: { readonly list: Tokens.List; readonly width: number; readonly depth: number }): React.ReactElement {
  const start = typeof list.start === "number" ? list.start : 1;
  const markers = list.items.map((item, index) => {
    if (item.task) return item.checked === true ? "[x]" : "[ ]";
    return list.ordered ? `${start + index}.` : (BULLETS[depth % BULLETS.length] ?? "-");
  });
  const markerWidth = Math.max(...markers.map((marker) => marker.length)) + 1;
  return (
    <Box flexDirection="column">
      {list.items.map((item, index) => (
        <Box key={index} flexDirection="row" marginTop={list.loose && index > 0 ? 1 : 0}>
          <Box width={markerWidth} flexShrink={0}>
            <Text color={item.task && item.checked === true ? palette.accent : palette.meta}>{markers[index]}</Text>
          </Box>
          <Box flexDirection="column" flexShrink={1}>
            {itemBlocks(item, width - markerWidth, depth + 1)}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

// A tight item holds bare text tokens; a loose one holds paragraphs. Nested lists keep their own spacing.
function itemBlocks(item: Tokens.ListItem, width: number, depth: number): React.ReactNode[] {
  const tokens = item.tokens.filter((token) => token.type !== "checkbox");
  if (item.loose) return blocks(tokens, width, depth);
  return tokens
    .filter((token) => token.type !== "space")
    .map((token, index) => (
      <Box key={index} flexDirection="column">
        {block(token, width, depth, index)}
      </Box>
    ));
}

function Table({ table, width }: { readonly table: Tokens.Table; readonly width: number }): React.ReactElement {
  const header = table.header.map((cell) => plain(cell.tokens));
  const rows = table.rows.map((row) => row.map((cell) => plain(cell.tokens)));
  const columns = header.length;
  const natural = Array.from({ length: columns }, (_, column) => Math.max(3, ...[header, ...rows].map((row) => (row[column] ?? "").length)));
  const sizes = fitColumns(natural, width - (columns - 1) * 3);
  const separator = ascii ? " | " : " │ ";
  const line = (cells: readonly string[]) =>
    cells.map((cell, column) => pad(cell, sizes[column] ?? 3, table.align[column] ?? null)).join(separator);
  const rule = sizes.map((size) => RULE.repeat(size)).join(ascii ? "-+-" : "─┼─");
  return (
    <Box flexDirection="column">
      <Text bold>{line(header)}</Text>
      <Text color={palette.meta}>{rule}</Text>
      {rows.map((row, index) => (
        <Text key={index}>{line(row)}</Text>
      ))}
    </Box>
  );
}

// Shrinks the widest columns first until the table fits; a cut cell ends with an ellipsis.
export function fitColumns(natural: readonly number[], available: number): number[] {
  const sizes = [...natural];
  while (sizes.reduce((sum, size) => sum + size, 0) > available) {
    const widest = sizes.indexOf(Math.max(...sizes));
    if ((sizes[widest] ?? 0) <= 3) break;
    sizes[widest] = (sizes[widest] ?? 0) - 1;
  }
  return sizes;
}

function pad(text: string, size: number, align: "left" | "right" | "center" | null): string {
  const cut = text.length > size ? `${text.slice(0, Math.max(0, size - 1))}${ascii ? "~" : "…"}` : text;
  const room = size - cut.length;
  if (align === "right") return `${" ".repeat(room)}${cut}`;
  if (align === "center") return `${" ".repeat(Math.floor(room / 2))}${cut}${" ".repeat(Math.ceil(room / 2))}`;
  return `${cut}${" ".repeat(room)}`;
}
