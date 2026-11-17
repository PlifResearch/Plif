import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { type Subagent, type TranscriptEntry, describeToolRun, elapsedOf, subagentLabel } from "../subagents.js";
import { formatElapsed } from "./components.js";
import { Markdown } from "./markdown.js";
import { VERB_WIDTH, glyph, palette, railColor, stateColor, stateGlyph, verbFor, type ToolState, type TurnState } from "./theme.js";

const CLOCK_MS = 250;
// Four rows in the block, main included: three subagents, or two and a "+N more" row when the list overflows.
const ROWS_FIT = 3;
const ROWS_OVERFLOW = 2;
// Rail as a left-only border, so the line runs down the whole turn.
const RAIL = {
  topLeft: "",
  top: "",
  topRight: "",
  right: "",
  bottomRight: "",
  bottom: "",
  bottomLeft: "",
  left: glyph.rail,
};

export function agentTitle(agent: Subagent): string {
  return `${subagentLabel(agent)} #${agent.id}`;
}

function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return active ? now : Date.now();
}

export function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

// The list shows four states with the same glyphs as tool lines. A stopped subagent sits in the queued slot and says so.
function stateOf(agent: Subagent): ToolState {
  if (agent.status === "stopped") return "queued";
  return agent.status;
}

function activityOf(agent: Subagent): string {
  if (agent.status === "failed") return agent.error ?? "";
  if (agent.status !== "running") return "";
  if (agent.current === null) return "waiting for the model";
  return `${verbFor(agent.current.name)} ${agent.current.summary}`;
}

function rightOf(agent: Subagent, now: number): string {
  const time = formatElapsed(elapsedOf(agent, now));
  if (agent.status === "stopped") return `stopped  ${time}`;
  if (agent.status === "failed") return `failed  ${time}`;
  return time;
}

// Which rows the block shows: all of them when they fit, otherwise a window that holds the focused row.
export function listWindow(total: number, focus: number): { start: number; size: number } {
  if (total <= ROWS_FIT) return { start: 0, size: total };
  return { start: Math.min(Math.max(focus - 1, 0), total - ROWS_OVERFLOW), size: ROWS_OVERFLOW };
}

// The block above the prompt: main first, then the subagents. cursor is the row picked with the arrows, or null while the prompt has the focus.
export function AgentFooter({
  agents,
  cursor,
  mainStartedAt,
}: {
  readonly agents: readonly Subagent[];
  readonly cursor: number | null;
  readonly mainStartedAt: number | null;
}): React.ReactElement | null {
  const now = useClock(mainStartedAt !== null || agents.some((agent) => agent.status === "running"));
  if (agents.length === 0) return null;
  const focus = cursor !== null && cursor > 0 ? cursor - 1 : agents.length - 1;
  const { start, size } = listWindow(agents.length, focus);
  const shown = agents.slice(start, start + size);
  const hidden = agents.length - shown.length;
  return (
    <Box flexDirection="column">
      <MainRow
        selected={cursor === 0}
        right={mainStartedAt === null ? "" : `working  ${formatElapsed(now - mainStartedAt)}`}
      />
      {shown.map((agent, offset) => (
        <AgentRow key={agent.id} agent={agent} selected={cursor === start + offset + 1} now={now} />
      ))}
      {hidden > 0 ? (
        <Text color={palette.meta}>{`  +${hidden} more · ↓`}</Text>
      ) : null}
    </Box>
  );
}

function MainRow({ selected, right }: { readonly selected: boolean; readonly right: string }): React.ReactElement {
  return (
    <Box justifyContent="space-between">
      <Text color={selected ? palette.accent : undefined} inverse={selected}>
        {"  main"}
      </Text>
      <Box flexShrink={0} marginLeft={2}>
        <Text color={selected ? palette.accent : palette.meta} inverse={selected}>
          {right}
        </Text>
      </Box>
    </Box>
  );
}

// Inside a selected row every piece takes the row's colour, so the reverse video covers the whole line.
function AgentRow({ agent, selected, now }: { readonly agent: Subagent; readonly selected: boolean; readonly now: number }): React.ReactElement {
  const state = stateOf(agent);
  const tone = (color: string | undefined) => (selected ? undefined : color);
  const activity = activityOf(agent);
  const rightColor = agent.status === "failed" ? palette.err : palette.meta;
  return (
    <Box justifyContent="space-between">
      <Box flexShrink={1}>
        <Text wrap="truncate-end" color={selected ? palette.accent : undefined} inverse={selected}>
          {"  "}
          <Text color={tone(stateColor(state))}>{stateGlyph(state)}</Text>
          {` ${subagentLabel(agent).padEnd(8)} `}
          <Text color={tone(agent.status === "running" ? undefined : palette.meta)}>{agent.description}</Text>
          {activity === "" ? null : <Text color={tone(palette.meta)}>{`  ${activity}`}</Text>}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={2}>
        <Text color={selected ? palette.accent : rightColor} inverse={selected}>
          {rightOf(agent, now)}
        </Text>
      </Box>
    </Box>
  );
}

type Segment =
  | { readonly kind: "entry"; readonly entry: Exclude<TranscriptEntry, { kind: "tool" }> }
  | { readonly kind: "tools"; readonly entries: readonly Extract<TranscriptEntry, { kind: "tool" }>[] };

// Consecutive tool calls form one run; the run gets a summary line above its lines.
function segmentsOf(transcript: readonly TranscriptEntry[]): Segment[] {
  const segments: Segment[] = [];
  for (const entry of transcript) {
    const last = segments.at(-1);
    if (entry.kind === "tool") {
      if (last?.kind === "tools") segments[segments.length - 1] = { kind: "tools", entries: [...last.entries, entry] };
      else segments.push({ kind: "tools", entries: [entry] });
    } else {
      segments.push({ kind: "entry", entry });
    }
  }
  return segments;
}

function turnStateOf(agent: Subagent): TurnState {
  if (agent.status === "running") return "running";
  if (agent.status === "failed") return "failed";
  return "done";
}

// What the history area shows while a subagent is in view: its own header, then its conversation on one rail.
export function AgentTranscript({
  agent,
  place,
  model,
}: {
  readonly agent: Subagent;
  // Where the subagent works, such as "~/Plif · main", and the model line, such as "Haiku 5.5 · low".
  readonly place: string;
  readonly model: string;
}): React.ReactElement {
  const now = useClock(agent.status === "running");
  const segments = segmentsOf(agent.transcript);
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" marginTop={1} marginBottom={1} flexShrink={1}>
        <Text wrap="truncate-end">
          <Text bold>plif</Text>
          {`  ${place} / ${subagentLabel(agent)} · ${agent.description}`}
        </Text>
        <Box flexShrink={0} marginLeft={2}>
          <Text color={palette.meta}>{`${model} · ${formatElapsed(elapsedOf(agent, now))} · ${formatTokenCount(agent.tokens)} tokens`}</Text>
        </Box>
      </Box>
      <Box
        flexDirection="column"
        flexShrink={1}
        borderStyle={RAIL}
        borderColor={railColor(turnStateOf(agent))}
        borderTop={false}
        borderBottom={false}
        borderRight={false}
        paddingLeft={1}
      >
        {segments.map((segment, index) => (
          <Box key={index} marginTop={index === 0 ? 0 : 1} flexDirection="column" flexShrink={1}>
            <SegmentView segment={segment} />
          </Box>
        ))}
        {agent.current === null ? null : <ToolLine name={agent.current.name} summary={agent.current.summary} state="running" />}
      </Box>
    </Box>
  );
}

function ToolLine({ name, summary, state }: { readonly name: string; readonly summary: string; readonly state: ToolState }): React.ReactElement {
  return (
    <Box justifyContent="space-between" flexShrink={1}>
      <Text wrap="truncate-end">
        <Text color={stateColor(state)}>{stateGlyph(state)}</Text>
        {` ${verbFor(name).padEnd(VERB_WIDTH)}  ${summary}`}
      </Text>
      {state === "running" ? (
        <Box flexShrink={0} marginLeft={2}>
          <Text color={palette.accent}>running</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function SegmentView({ segment }: { readonly segment: Segment }): React.ReactElement {
  if (segment.kind === "tools") {
    return (
      <>
        {segment.entries.length > 1 ? <Text color={palette.meta}>{describeToolRun(segment.entries)}</Text> : null}
        {segment.entries.map((entry, index) => (
          <ToolLine key={index} name={entry.name} summary={entry.summary} state={entry.ok ? "done" : "failed"} />
        ))}
      </>
    );
  }
  const { entry } = segment;
  switch (entry.kind) {
    case "user":
      return (
        <>
          <Text color={palette.meta}>{entry.from === "main" ? "from main" : "from you"}</Text>
          <Text bold>{entry.text}</Text>
        </>
      );
    case "text":
      return <Markdown text={entry.text} />;
    case "notice":
      return <Text color={entry.tone === "error" ? palette.err : palette.meta}>{entry.text}</Text>;
  }
}

// The rule above the prompt carries the name of the subagent that receives what is typed.
export function LabeledRule({ label, color, width }: { readonly label: string; readonly color: string; readonly width: number }): React.ReactElement {
  const room = Math.max(8, width - 6);
  const shown = label.length > room ? `${label.slice(0, room - 1)}…` : label;
  const fill = Math.max(1, width - shown.length - 3);
  return (
    <Text wrap="truncate-end">
      <Text color={color}>{"─".repeat(fill)}</Text>
      <Text color={color} inverse>
        {` ${shown} `}
      </Text>
      <Text color={color}>─</Text>
    </Text>
  );
}
