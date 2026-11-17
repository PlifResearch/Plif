import { Box, Text } from "ink";
import React from "react";
import { formatElapsed } from "./components.js";
import { type ToolActivity } from "../subagents.js";
import { type Item } from "./transcript.js";
import { CodeLineView, highlightLines, languageFor } from "./syntax.js";
import { COLUMN, type ToolState, glyph, palette, stateColor, stateGlyph, verbFor } from "./theme.js";

export type ToolItem = Extract<Item, { kind: "tool" }>;

// What the history draws: plain items, cards for tools whose result is worth reading, and groups for the rest.
export type HistoryUnit =
  | { readonly kind: "item"; readonly id: number; readonly item: Item }
  | { readonly kind: "card"; readonly id: number; readonly tool: ToolItem }
  | { readonly kind: "group"; readonly id: number; readonly tools: readonly ToolItem[] };

// Each unit is a block of its own, apart from the user's message and the model's prose.
// Writes, edits and commands always get a card. Reads, searches and listings in a row fold into one block; anything else stands alone.
const CARD_TOOLS = new Set(["Write", "Edit", "Bash", "Monitor", "Terminal"]);
const COMMAND_TOOLS = new Set(["Bash", "Monitor", "Terminal"]);
const COMMAND_TAIL_LINES = 4;
// A heredoc can carry a whole file. Closed, a block shows this much of the command; open, all of it.
const COMMAND_PREVIEW_LINES = 3;
const FOLDED_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
const CARD_PREVIEW_LINES = 6;
const MAX_EXPANDED_LINES = 2000;
// Columns from the glyph to the output: the output sits under the object, as in the design.
const OUTPUT_OFFSET = COLUMN.output - COLUMN.glyph;

// The frame of a block: a rounded border in the colour of its state.
function Frame({ state, children }: { readonly state: ToolState; readonly children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={1} borderStyle={glyph.done === "#" ? "classic" : "round"} borderColor={stateColor(state)} paddingX={1}>
      {children}
    </Box>
  );
}

export function historyUnits(items: readonly Item[]): HistoryUnit[] {
  const units: HistoryUnit[] = [];
  for (const item of items) {
    if (item.kind !== "tool") {
      units.push({ kind: "item", id: item.id, item });
      continue;
    }
    if (CARD_TOOLS.has(item.name)) {
      units.push({ kind: "card", id: item.id, tool: item });
      continue;
    }
    const last = units.at(-1);
    const folds = last?.kind === "group" && FOLDED_TOOLS.has(last.tools[0]?.name ?? "") && FOLDED_TOOLS.has(item.name);
    if (folds && last?.kind === "group") units[units.length - 1] = { ...last, tools: [...last.tools, item] };
    else units.push({ kind: "group", id: item.id, tools: [item] });
  }
  return units;
}

export interface MouseEvent {
  readonly button: number;
  readonly x: number;
  readonly y: number;
  readonly press: boolean;
}

// SGR mouse reports (mode 1006). Ink hands them to useInput with the escape byte already removed.
const MOUSE = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g;

export function mouseEvents(input: string): MouseEvent[] {
  return [...input.matchAll(MOUSE)].map((match) => ({
    button: Number(match[1]),
    x: Number(match[2]),
    y: Number(match[3]),
    press: match[4] === "M",
  }));
}

export function isMouseInput(input: string): boolean {
  return /^(?:\x1b?\[<\d+;\d+;\d+[Mm])+$/.test(input);
}

function inputRecord(tool: { readonly input?: unknown }): Record<string, unknown> {
  return (tool.input ?? {}) as Record<string, unknown>;
}

function stringField(tool: { readonly input?: unknown }, key: string): string | null {
  const value = inputRecord(tool)[key];
  return typeof value === "string" ? value : null;
}

function lines(text: string): string[] {
  const all = text.replace(/\n$/, "").split("\n");
  return all.length === 1 && all[0] === "" ? [] : all;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

// The object column: the command for Bash, the pattern and folder for Grep, the summary for the rest.
function objectOf(name: string, summary: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  if (name === "Bash" && typeof record["command"] === "string") return firstLine(record["command"]);
  if (name === "Grep" && typeof record["path"] === "string") return `${firstLine(summary)} in ${record["path"]}`;
  return firstLine(summary);
}

function timeText(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : formatElapsed(ms);
}

// Read, Grep and Glob say how much they found; the other tools have no count to show.
function countText(tool: ToolItem): string | null {
  const count = lines(tool.output).length;
  if (tool.name === "Read") return `${count} ${count === 1 ? "line" : "lines"}`;
  if (tool.name === "Grep") return `${count} ${count === 1 ? "match" : "matches"}`;
  if (tool.name === "Glob") return `${count} ${count === 1 ? "file" : "files"}`;
  return null;
}

// "+14 -0" for a write, "+3 -2" for an edit, from the input the model sent.
function changeText(tool: ToolItem): string | null {
  if (tool.name === "Write") {
    const content = stringField(tool, "content");
    return content === null ? null : `+${lines(content).length} -0`;
  }
  const before = stringField(tool, "old_string");
  const after = stringField(tool, "new_string");
  if (tool.name === "Edit" && before !== null && after !== null) return `+${lines(after).length} -${lines(before).length}`;
  return null;
}

function Row({
  state,
  verb,
  bold = false,
  object,
  detail,
  right,
}: {
  readonly state: ToolState;
  readonly verb: string;
  readonly bold?: boolean;
  readonly object: string;
  readonly detail?: string | null;
  readonly right?: React.ReactNode;
}): React.ReactElement {
  return (
    <Box>
      <Box width={COLUMN.verb - COLUMN.glyph} flexShrink={0}>
        <Text color={stateColor(state)}>{stateGlyph(state)}</Text>
      </Box>
      <Box width={COLUMN.object - COLUMN.verb} flexShrink={0}>
        <Text bold={bold}>{verb}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">
          {object}
          {detail ? <Text color={palette.meta}>{`  ${detail}`}</Text> : null}
        </Text>
      </Box>
      {right === undefined || right === null ? null : (
        <Box flexShrink={0} marginLeft={2}>
          {right}
        </Box>
      )}
    </Box>
  );
}

// Tool output in meta, under the object. The first `limit` lines show; the rest are counted.
function OutputLines({ text, limit }: { readonly text: string; readonly limit: number }): React.ReactElement | null {
  const all = lines(text);
  const shown = all.slice(0, limit);
  const hidden = all.length - shown.length;
  if (shown.length === 0) return null;
  return (
    <Box flexDirection="column" flexShrink={1}>
      {shown.map((line, index) => (
        <Text key={index} color={palette.meta} wrap="wrap">
          {line}
        </Text>
      ))}
      {hidden > 0 ? <Text color={palette.meta}>{`+${hidden} more ${hidden === 1 ? "line" : "lines"}`}</Text> : null}
    </Box>
  );
}

function rightOf(tool: ToolItem): React.ReactNode {
  if (!tool.ok) return <Text color={palette.err}>failed</Text>;
  const text = [countText(tool), timeText(tool.durationMs)].filter((part): part is string => part !== null).join("  ");
  return text === "" ? null : <Text color={palette.meta}>{text}</Text>;
}

function totalTime(tools: readonly ToolItem[]): string | null {
  const known = tools.map((tool) => tool.durationMs).filter((ms): ms is number => ms !== undefined);
  return known.length === 0 ? null : timeText(known.reduce((sum, ms) => sum + ms, 0));
}

// Folded tools: one line that names what ran. Failures open the group by themselves; a click toggles it.
export const ToolGroupView = React.memo(
  function ToolGroupView({
    tools,
    expanded,
    hovered,
  }: {
    readonly tools: readonly ToolItem[];
    readonly expanded: boolean;
    readonly hovered: boolean;
  }): React.ReactElement | null {
    const first = tools[0];
    if (first === undefined) return null;
    const failures = tools.filter((tool) => !tool.ok).length;
    const open = failures > 0 ? !expanded : expanded;
    const names = tools.slice(0, 2).map((tool) => objectOf(tool.name, tool.summary, tool.input));
    const more = tools.length - names.length;
    const object = more > 0 ? `${names.join(", ")} +${more} more` : names.join(", ");
    const hint = hovered ? (open ? "click to close" : "click to open") : null;
    const single = tools.length === 1;
    const right =
      single && first !== undefined ? (
        rightOf(first)
      ) : (
        <Text>
          {failures > 0 ? <Text color={palette.err}>{`${failures} failed`}</Text> : null}
          {failures > 0 && totalTime(tools) !== null ? "  " : null}
          {totalTime(tools) === null ? null : <Text color={palette.meta}>{totalTime(tools)}</Text>}
        </Text>
      );
    return (
      <Frame state={failures > 0 ? "failed" : "done"}>
        <Row
          state={failures > 0 ? "failed" : "done"}
          verb={verbFor(first.name)}
          bold={failures > 0}
          object={object}
          detail={hint}
          right={right}
        />
        {open
          ? tools.map((tool) => (
              <Box key={tool.id} flexDirection="column" marginLeft={OUTPUT_OFFSET} flexShrink={1}>
                {single ? null : (
                  <Row
                    state={tool.ok ? "done" : "failed"}
                    verb={verbFor(tool.name)}
                    bold={!tool.ok}
                    object={objectOf(tool.name, tool.summary, tool.input)}
                    right={rightOf(tool)}
                  />
                )}
                {single || !FOLDED_TOOLS.has(tool.name) || !tool.ok ? <OutputLines text={tool.output} limit={MAX_EXPANDED_LINES} /> : null}
              </Box>
            ))
          : null}
      </Frame>
    );
  },
  (previous, next) =>
    previous.expanded === next.expanded &&
    previous.hovered === next.hovered &&
    previous.tools.length === next.tools.length &&
    previous.tools[0]?.id === next.tools[0]?.id &&
    previous.tools.at(-1)?.ok === next.tools.at(-1)?.ok,
);

// A write or an edit. The preview shows the first lines; a click, or ctrl+o, shows all of them.
export const ToolCardView = React.memo(function ToolCardView({
  tool,
  expanded,
  hovered,
}: {
  readonly tool: ToolItem;
  readonly expanded: boolean;
  readonly hovered: boolean;
}): React.ReactElement {
  const hint = hovered ? (expanded ? "click to close" : "click to open") : null;
  const change = changeText(tool);
  const command = COMMAND_TOOLS.has(tool.name);
  const description = stringField(tool, "description");
  return (
    <Frame state={tool.ok ? "done" : "failed"}>
      <Row
        state={tool.ok ? "done" : "failed"}
        verb={verbFor(tool.name)}
        bold={!tool.ok}
        object={command ? (description ?? objectOf(tool.name, tool.summary, tool.input)) : firstLine(tool.summary)}
        detail={[change, hint].filter((part): part is string => part !== null).join("  ") || null}
        right={tool.ok ? timeRight(tool) : rightOf(tool)}
      />
      <Box marginLeft={command ? 0 : OUTPUT_OFFSET} flexDirection="column" flexShrink={1}>
        {command ? <CommandBody tool={tool} expanded={expanded} /> : <CardBody tool={tool} expanded={expanded} />}
      </Box>
    </Frame>
  );
});

// Terminal writes show what was typed, with control keys named; Terminal results are JSON, so the output field is shown.
function terminalInput(tool: ToolItem): string | null {
  if (tool.name !== "Terminal") return null;
  const record = inputRecord(tool);
  const session = typeof record["session"] === "number" ? `#${record["session"]} ` : "";
  if (record["action"] === "write") {
    const typed = typeof record["input"] === "string" ? record["input"] : "";
    const shown = typed === "" ? "(read)" : typed.replace(/\u0003/g, "^C").replace(/\u0004/g, "^D").replace(/\u001b/g, "^[").replace(/\n$/, "⏎").replace(/\n/g, "⏎ ");
    return `${session}‹ ${shown}`;
  }
  if (record["action"] === "stop") return `${session}stop`;
  if (record["action"] === "list") return "list";
  return null;
}

function terminalOutput(tool: ToolItem): string {
  if (tool.name !== "Terminal") return tool.output;
  try {
    const parsed = JSON.parse(tool.output) as { output?: string; status?: string; exit_code?: number; session?: number };
    const tail = parsed.status === "running" ? `[session #${parsed.session} still running]` : parsed.exit_code === undefined ? "" : `[exit ${parsed.exit_code}]`;
    return [parsed.output ?? "", tail].filter((part) => part !== "").join("\n");
  } catch {
    return tool.output;
  }
}

// A command: the command itself, coloured as shell, then the end of its output (where results and errors land).
function CommandBody({ tool, expanded }: { readonly tool: ToolItem; readonly expanded: boolean }): React.ReactElement {
  const command = stringField(tool, "command") ?? terminalInput(tool) ?? firstLine(tool.summary);
  const output = lines(terminalOutput(tool));
  const shown = expanded ? output.slice(0, MAX_EXPANDED_LINES) : output.slice(-COMMAND_TAIL_LINES);
  const hidden = output.length - shown.length;
  return (
    <Box flexDirection="column" flexShrink={1}>
      <CommandLines command={command} limit={expanded ? MAX_EXPANDED_LINES : COMMAND_PREVIEW_LINES} />
      {hidden > 0 && !expanded ? <Text color={palette.meta}>{`${hidden} earlier ${hidden === 1 ? "line" : "lines"} · ctrl+o`}</Text> : null}
      {shown.map((line, index) => (
        <Text key={index} color={tool.ok ? palette.meta : palette.err} wrap="wrap">
          {line}
        </Text>
      ))}
      {hidden > 0 && expanded ? <Text color={palette.meta}>{`+${hidden} more ${hidden === 1 ? "line" : "lines"}`}</Text> : null}
    </Box>
  );
}

function CommandLines({ command, limit }: { readonly command: string; readonly limit: number }): React.ReactElement {
  const all = highlightLines(command, "bash");
  const shown = all.slice(0, limit);
  const hidden = all.length - shown.length;
  return (
    <Box flexDirection="column" flexShrink={1}>
      {shown.map((line, index) => (
        <CodeLineView key={index} line={line} prefix={<Text color={palette.accent}>{index === 0 ? "$ " : "  "}</Text>} />
      ))}
      {hidden > 0 ? <Text color={palette.meta}>{`  +${hidden} more command ${hidden === 1 ? "line" : "lines"} · click or ctrl+o`}</Text> : null}
    </Box>
  );
}

function timeRight(tool: ToolItem): React.ReactNode {
  const time = timeText(tool.durationMs);
  return time === null ? null : <Text color={palette.meta}>{time}</Text>;
}

function CardBody({ tool, expanded }: { readonly tool: ToolItem; readonly expanded: boolean }): React.ReactElement | null {
  const limit = expanded ? MAX_EXPANDED_LINES : CARD_PREVIEW_LINES;
  const content = stringField(tool, "content");
  const language = languageFor(stringField(tool, "file_path") ?? undefined);
  if (tool.name === "Write" && tool.ok && content !== null) return <Preview body={lines(content)} language={language} limit={limit} expanded={expanded} />;
  const before = stringField(tool, "old_string");
  const after = stringField(tool, "new_string");
  if (tool.name === "Edit" && tool.ok && before !== null && after !== null) {
    const diff = [...lines(before).map((line) => ({ sign: "-" as const, line })), ...lines(after).map((line) => ({ sign: "+" as const, line }))];
    return <DiffPreview diff={diff} language={language} limit={limit} expanded={expanded} />;
  }
  return <OutputLines text={tool.output} limit={limit} />;
}

function Preview({
  body,
  language,
  limit,
  expanded,
}: {
  readonly body: readonly string[];
  readonly language: string | null;
  readonly limit: number;
  readonly expanded: boolean;
}): React.ReactElement {
  const shown = body.slice(0, limit);
  const hidden = body.length - shown.length;
  const coloured = highlightLines(shown.join("\n"), language);
  return (
    <Box flexDirection="column" flexShrink={1}>
      {coloured.map((line, index) => (
        <CodeLineView key={index} line={line} />
      ))}
      {hidden > 0 ? <Text color={palette.meta}>{`+${hidden} more ${hidden === 1 ? "line" : "lines"}${expanded ? "" : " · ctrl+o"}`}</Text> : null}
    </Box>
  );
}

function DiffPreview({
  diff,
  language,
  limit,
  expanded,
}: {
  readonly diff: readonly { readonly sign: "-" | "+"; readonly line: string }[];
  readonly language: string | null;
  readonly limit: number;
  readonly expanded: boolean;
}): React.ReactElement {
  const shown = diff.slice(0, limit);
  const hidden = diff.length - shown.length;
  return (
    <Box flexDirection="column" flexShrink={1}>
      {shown.map((entry, index) => (
        <CodeLineView
          key={index}
          line={highlightLines(entry.line, language)[0] ?? []}
          prefix={<Text color={entry.sign === "-" ? palette.err : palette.accent}>{`${entry.sign} `}</Text>}
        />
      ))}
      {hidden > 0 ? <Text color={palette.meta}>{`+${hidden} more ${hidden === 1 ? "line" : "lines"}${expanded ? "" : " · ctrl+o"}`}</Text> : null}
    </Box>
  );
}

// The tool running now. Static: the only moving element on screen is the spinner at the prompt.
export function ToolActivityView({ activity }: { readonly activity: ToolActivity }): React.ReactElement {
  const object = objectOf(activity.name, activity.summary, { command: activity.command ?? undefined });
  const command = COMMAND_TOOLS.has(activity.name) && activity.command !== null && activity.command !== undefined;
  return (
    <Frame state="running">
      <Row state="running" verb={verbFor(activity.name)} object={command ? firstLine(activity.summary) : object} right={<Text color={palette.accent}>running</Text>} />
      {command ? <CommandLines command={activity.command ?? ""} limit={COMMAND_PREVIEW_LINES} /> : null}
    </Frame>
  );
}
