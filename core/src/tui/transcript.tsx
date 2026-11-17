import { Box, Text } from "ink";
import React from "react";
import { Markdown } from "./markdown.js";
import { MEASURE, glyph, palette, railColor, type TurnState } from "./theme.js";

// The conversation history: what each kind of item looks like once it is in the transcript.

export interface ImageDetail {
  readonly number: number;
  readonly name?: string;
  readonly width?: number;
  readonly height?: number;
}

export type Item =
  | { readonly kind: "header"; readonly id: number }
  | {
      readonly kind: "user";
      readonly id: number;
      readonly text: string;
      readonly images?: readonly number[];
      readonly imageDetails?: readonly ImageDetail[];
    }
  | { readonly kind: "assistant"; readonly id: number; readonly text: string }
  | {
      readonly kind: "tool";
      readonly id: number;
      readonly name: string;
      readonly summary: string;
      readonly ok: boolean;
      readonly output: string;
      // The input as the model sent it. Cards read the command or the written content from it.
      readonly input?: unknown;
      readonly durationMs?: number;
    }
  | { readonly kind: "notice"; readonly id: number; readonly text: string; readonly tone: "dim" | "warn" | "error" | "footer" }
  // The line that closes a turn. turnsOf fills failed and files from the turn's own items.
  | {
      readonly kind: "turnEnd";
      readonly id: number;
      readonly seconds: number;
      readonly tokens: number;
      readonly stopped: boolean;
      readonly failed?: boolean;
      readonly files?: number;
    };

// Rail glyph on the left edge only. Top, bottom and right stay open, so the rail runs through blank lines.
const RAIL_STYLE = { topLeft: "", top: "", topRight: "", right: "", bottomRight: "", bottom: "", bottomLeft: "", left: glyph.rail };

// Each block sits in the turn's column 2. Blank lines between blocks keep the rail running.
export function ItemView({ item }: { readonly item: Item }): React.ReactElement | null {
  switch (item.kind) {
    case "header":
      return <Text />;
    case "user":
      return <UserPrompt text={item.text} images={item.images ?? []} details={item.imageDetails ?? []} />;
    case "assistant":
      return (
        <Box marginTop={1} maxWidth={MEASURE} flexDirection="column">
          <Markdown text={item.text} />
        </Box>
      );
    case "tool":
      return null;
    case "notice":
      return (
        <Box marginTop={1}>
          <Text color={item.tone === "error" ? palette.err : item.tone === "warn" ? palette.warn : palette.meta}>{item.text}</Text>
        </Box>
      );
    case "turnEnd":
      return <TurnEndLine item={item} />;
  }
}

// The user's message is a block of its own: an accent bar on the left, the text in bold.
const USER_STYLE = { topLeft: "", top: "", topRight: "", right: "", bottomRight: "", bottom: "", bottomLeft: "", left: glyph.user };

export function UserPrompt({
  text,
  images,
  details,
}: {
  readonly text: string;
  readonly images: readonly number[];
  readonly details: readonly ImageDetail[];
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      paddingLeft={1}
      borderStyle={USER_STYLE}
      borderColor={palette.accent}
      borderTop={false}
      borderBottom={false}
      borderRight={false}
    >
      <Text bold>{text}</Text>
      {images.map((number) => (
        <Text key={number} color={palette.meta}>
          {imageLine(number, details.find((detail) => detail.number === number))}
        </Text>
      ))}
    </Box>
  );
}

function imageLine(number: number, detail: ImageDetail | undefined): string {
  const parts = [`[Image #${number}]`];
  if (detail?.name !== undefined) parts.push(detail.name);
  if (detail?.width !== undefined && detail.height !== undefined) parts.push(`${detail.width}×${detail.height}`);
  return parts.join("  ");
}

function TurnEndLine({ item }: { readonly item: Extract<Item, { kind: "turnEnd" }> }): React.ReactElement {
  const parts = [
    item.failed === true ? "failed" : item.stopped ? "Interrupted" : null,
    `${item.seconds}s`,
    item.tokens > 0 ? `${tokenText(item.tokens)} tokens` : null,
    item.files === undefined || item.files === 0 ? null : `${item.files} ${item.files === 1 ? "file" : "files"} changed`,
  ];
  return (
    <Box marginTop={1}>
      <Text color={item.failed === true ? palette.err : palette.meta}>{parts.filter((part) => part !== null).join(" · ")}</Text>
    </Box>
  );
}

function tokenText(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

// The rail of one turn: a bordered column whose left edge is the rail glyph, in the colour of the turn's state.
export function TurnRail({
  rail,
  state,
  gap,
  children,
}: {
  readonly rail: boolean;
  readonly state: TurnState;
  readonly gap: boolean;
  readonly children: React.ReactNode;
}): React.ReactElement {
  if (!rail) {
    return (
      <Box flexDirection="column" flexShrink={1} marginTop={gap ? 1 : 0}>
        {children}
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      flexShrink={1}
      marginTop={gap ? 1 : 0}
      paddingLeft={1}
      borderStyle={RAIL_STYLE}
      borderColor={railColor(state)}
      borderTop={false}
      borderBottom={false}
      borderRight={false}
    >
      {children}
    </Box>
  );
}

export interface Turn {
  readonly key: number;
  readonly rail: boolean;
  readonly gap: boolean;
  readonly state: TurnState;
  readonly items: readonly Item[];
}

// A turn starts at a user message and runs until the next one. Items before the first message form a turn without a rail.
// `live` is the state of the turn in progress, if any; the last turn takes it. Otherwise the state comes from its items.
export function turnsOf(items: readonly Item[], live: TurnState | null): Turn[] {
  const groups: { key: number; rail: boolean; items: Item[] }[] = [];
  for (const item of items) {
    const current = groups.at(-1);
    if (item.kind === "user" || current === undefined) groups.push({ key: item.id, rail: item.kind === "user", items: [item] });
    else current.items.push(item);
  }
  return groups.map((group, index) => {
    const failed = group.items.some((item) => item.kind === "notice" && item.tone === "error");
    const files = group.items.filter((item) => item.kind === "tool" && item.ok && (item.name === "Write" || item.name === "Edit")).length;
    const turnItems = group.items.map((item) => (item.kind === "turnEnd" ? { ...item, failed, files } : item));
    const isLast = index === groups.length - 1;
    const state: TurnState = isLast && live !== null ? live : failed ? "failed" : "done";
    return { key: group.key, rail: group.rail, gap: index > 0, state, items: turnItems };
  });
}
