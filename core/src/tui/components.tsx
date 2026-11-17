import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import type { SlashCommand } from "./commands.js";
import { LabeledRule } from "./agents.js";
import { sandboxSupported } from "../sandbox.js";
import { glyph, palette, reducedMotion, SPINNER, SPINNER_MS } from "./theme.js";

// The frame around the conversation: header, prompt, command menu and the turn's status.

export const PROMPT_HINT = "shift+tab mode · / commands · @ files · ctrl+r history";
export const MENU_HINT = "enter run · tab complete · esc close";

export interface HeaderProps {
  // The mascot's rows with their own colour codes.
  readonly logo: readonly string[];
  readonly path: string;
  readonly details: string;
  readonly modelLine: string;
  readonly sandbox: boolean;
  // False on systems where Plif has no sandbox at all (Windows), so the header says so instead of "off".
  readonly sandboxAvailable?: boolean;
  // An empty session shows the mascot and a welcome line above the header line.
  readonly opening: boolean;
}

export function Header({ logo, path, details, modelLine, sandbox, sandboxAvailable = sandboxSupported(), opening }: HeaderProps): React.ReactElement {
  const width = Math.max(0, ...logo.map((line) => [...line.replace(/\x1b\[[0-9;]*m/g, "")].length));
  const place = details === "" ? path : `${path} · ${details}`;
  const line = (
    <Box justifyContent="space-between" marginBottom={1}>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text bold>plif</Text>
          <Text color={palette.meta}>{`  ${place}`}</Text>
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={2}>
        <Text color={palette.meta}>
          {`${modelLine} · sandbox `}
          {sandbox ? "on" : <Text color={palette.warn}>{sandboxAvailable ? "off" : "unavailable"}</Text>}
        </Text>
      </Box>
    </Box>
  );
  if (!opening) return <Box flexDirection="column">{line}</Box>;
  return (
    <Box flexDirection="column">
      {logo.map((row, index) => (
        <Box key={index}>
          <Box width={width} flexShrink={0}>
            <Text>{row}</Text>
          </Box>
          <Box marginLeft={3}>
            {index === 1 ? <Text bold>plif</Text> : null}
            {index === 2 ? <Text>{`Ready in ${path}. Ask for a change, or type / for commands.`}</Text> : null}
          </Box>
        </Box>
      ))}
      <Box marginTop={1}>{line}</Box>
    </Box>
  );
}

// What the turn is doing, shown on the prompt's line. Null means no turn is running.
export interface BusyState {
  readonly startedAt: number;
  readonly tokens: number;
  // True until the model sends its first event.
  readonly waiting: boolean;
  readonly stoppable: boolean;
}

const CURSOR = "█";

// The prompt line: the typed text on the left, the permission mode and the turn's status on the right.
// Labeled prompts (a subagent's conversation) are framed by a rule that names the receiver.
export function Prompt({
  value,
  label,
  color,
  width = 0,
  placeholder = "",
  mode,
  busy,
  hint,
}: {
  readonly value: string;
  readonly label?: string;
  readonly color?: string;
  readonly width?: number;
  readonly placeholder?: string;
  readonly mode?: string;
  readonly busy?: BusyState;
  readonly hint?: string;
}): React.ReactElement {
  const labeled = label !== undefined && width > 0 && color !== undefined;
  const tint = labeled ? color : palette.accent;
  return (
    <Box marginTop={1} flexDirection="column">
      {labeled ? <LabeledRule label={label} color={color} width={width} /> : null}
      <Box flexDirection="column" borderStyle={labeled ? "single" : undefined} borderColor={tint} borderLeft={false} borderRight={false} borderTop={false}>
        <Box>
          <Box flexShrink={1} flexGrow={1}>
            <Box width={2} flexShrink={0}>
              <Text color={tint}>{`${glyph.prompt} `}</Text>
            </Box>
            <Box flexShrink={1} flexGrow={1}>
              {/* Text that reaches the edge continues on the next line, and the prompt grows with it. */}
              <Text wrap="wrap">
                {value}
                <Text color={tint}>{CURSOR}</Text>
                {value === "" && placeholder !== "" ? <Text color={palette.meta}>{` ${placeholder}`}</Text> : null}
              </Text>
            </Box>
          </Box>
          {mode === undefined && busy === undefined ? null : (
            <Box flexShrink={0} marginLeft={2}>
              {mode === undefined ? null : <Text color={palette.meta}>{`[${mode}]`}</Text>}
              {busy === undefined ? null : (
                <Box marginLeft={2}>
                  <BusyStatus busy={busy} />
                </Box>
              )}
            </Box>
          )}
        </Box>
      </Box>
      {hint === undefined ? null : (
        <Box paddingLeft={2}>
          <Text color={palette.meta}>{hint}</Text>
        </Box>
      )}
    </Box>
  );
}

// The spinner turns every SPINNER_MS and the counter changes once a second. Reduced motion freezes the frame.
export function BusyStatus({ busy }: { readonly busy: BusyState }): React.ReactElement {
  const now = useClock(reducedMotion ? 1000 : SPINNER_MS);
  const elapsed = Math.max(0, now - busy.startedAt);
  const frame = reducedMotion ? SPINNER[0] : SPINNER[Math.floor(elapsed / SPINNER_MS) % SPINNER.length];
  const clock = formatElapsed(Math.floor(elapsed / 1000) * 1000);
  const text = busy.waiting
    ? `waiting for the model · ${clock}`
    : [
        "working",
        clock,
        busy.tokens > 0 ? formatTokens(busy.tokens) : "",
        busy.stoppable ? "esc stops" : "",
      ]
        .filter((part) => part !== "")
        .join(" · ");
  return (
    <Text>
      <Text color={palette.accent}>{`${frame} `}</Text>
      <Text color={palette.meta}>{text}</Text>
    </Text>
  );
}

export function SlashMenu({
  commands,
  selected,
  position,
  total,
  query,
}: {
  readonly commands: readonly SlashCommand[];
  // Index of the selected row inside `commands`, which is a window of the full list.
  readonly selected: number;
  // One-based index of the selection in the full list, and the number of matches.
  readonly position: number;
  readonly total: number;
  readonly query: string;
}): React.ReactElement {
  const nameWidth = Math.max(0, ...commands.map((command) => command.name.length + command.args.length + 1)) + 2;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between">
        <Text color={palette.meta}>{query === "" ? "commands" : `commands · "${query}"`}</Text>
        <Text color={palette.meta}>{`${position} of ${total}`}</Text>
      </Box>
      {commands.map((command, index) => {
        const label = (command.args === "" ? command.name : `${command.name} ${command.args}`).padEnd(nameWidth);
        if (index === selected) {
          return (
            <Text key={command.name} color={palette.accent} inverse>
              {`${label}${command.description}`}
            </Text>
          );
        }
        return (
          <Text key={command.name}>
            {label}
            <Text color={palette.meta}>{command.description}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

// Re-renders every `every` ms and returns the current time, so the caller can compute elapsed time.
function useClock(every: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
