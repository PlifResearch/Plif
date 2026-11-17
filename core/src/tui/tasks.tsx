import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { type Task, elapsedMs } from "../tasks.js";
import { formatElapsed } from "./components.js";
import { glyph, palette, stateColor, stateGlyph, type ToolState } from "./theme.js";

const CLOCK_MS = 250;

function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// One line under the prompt while tasks run. It is the way into the panel.
export function TaskChips({ running }: { readonly running: readonly Task[] }): React.ReactElement | null {
  if (running.length === 0) return null;
  const count = running.length === 1 ? "1 task running" : `${running.length} tasks running`;
  return <Text color={palette.meta}>{`${count} · ctrl+t`}</Text>;
}

function stateOf(task: Task): ToolState {
  if (task.status === "running") return "running";
  if (task.status === "done") return "done";
  if (task.status === "stopped") return "queued";
  return "failed";
}

function statusWord(task: Task): string {
  if (task.status === "running") return "running";
  if (task.status === "stopped") return "stopped";
  if (task.status === "failed") return `exit ${task.exitCode ?? "?"}`;
  return "";
}

// The panel replaces the bottom area. Enter or Esc closes it, x stops the selected task.
export function TaskPanel({
  tasks,
  onStop,
  onClose,
}: {
  readonly tasks: readonly Task[];
  readonly onStop: (id: number) => void;
  readonly onClose: () => void;
}): React.ReactElement {
  const [selected, setSelected] = useState(0);
  const now = useClock();

  useInput((input, key) => {
    if (key.escape || key.return) onClose();
    else if (key.upArrow) setSelected((index) => Math.max(0, index - 1));
    else if (key.downArrow) setSelected((index) => Math.min(Math.max(0, tasks.length - 1), index + 1));
    else if (input === "x") {
      const task = tasks[selected];
      if (task !== undefined) onStop(task.id);
    }
  });

  const position = tasks.length === 0 ? "" : `${selected + 1} of ${tasks.length}`;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text color={palette.accent}>{glyph.rail}</Text> <Text bold>background tasks</Text>
        </Text>
        <Text color={palette.meta}>{position}</Text>
      </Box>
      {tasks.length === 0 ? <Text color={palette.meta}>{`${glyph.rail} no background tasks in this session`}</Text> : null}
      {tasks.map((task, index) => (
        <TaskRow key={task.id} task={task} selected={index === selected} now={now} />
      ))}
      <Text color={palette.meta}>{`${glyph.rail} ↑↓ move · x stop the task · enter or esc close`}</Text>
    </Box>
  );
}

function TaskRow({ task, selected, now }: { readonly task: Task; readonly selected: boolean; readonly now: number }): React.ReactElement {
  const state = stateOf(task);
  const word = statusWord(task);
  const lastLine = task.tail.trimEnd().split("\n").at(-1) ?? "";
  const tone = (color: string | undefined) => (selected ? undefined : color);
  const wordColor = task.status === "failed" ? palette.err : palette.meta;
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text color={selected ? palette.accent : undefined} inverse={selected} wrap="truncate-end">
          <Text color={tone(stateColor(state))}>{`${glyph.rail} ${stateGlyph(state)} `}</Text>
          <Text color={tone(palette.meta)}>{`#${task.id}  `}</Text>
          {task.command}
          {word === "" ? null : <Text color={tone(wordColor)}>{`  ${word}`}</Text>}
        </Text>
        <Box flexShrink={0} marginLeft={2}>
          <Text color={selected ? palette.accent : palette.meta} inverse={selected}>
            {formatElapsed(elapsedMs(task, now))}
          </Text>
        </Box>
      </Box>
      {lastLine === "" ? null : (
        <Text color={palette.meta} wrap="truncate-end">{`${glyph.rail}     ${lastLine.slice(0, 120)}`}</Text>
      )}
    </Box>
  );
}
