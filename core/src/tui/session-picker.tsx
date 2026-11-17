import path from "node:path";
import { Box, Text, useInput, useWindowSize } from "ink";
import React, { useEffect, useState } from "react";
import type { SessionEntry } from "../session.js";
import { glyph, palette } from "./theme.js";

export interface PreviewEntry {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface SessionPickerProps {
  // Every session on this machine. The picker shows the current project unless Ctrl+A widens it.
  readonly sessions: readonly SessionEntry[];
  readonly cwd?: string;
  readonly branch?: string | null;
  readonly onPick: (session: SessionEntry | null) => void;
  readonly onPreview?: (id: string) => Promise<readonly PreviewEntry[]>;
  readonly onRename?: (id: string, title: string) => Promise<void>;
  readonly now?: number;
}

// Header, search line, the blank lines around the list, and the hint.
const CHROME_ROWS = 6;
const PREVIEW_ROWS = 10;

// Lowercase and without accents, so "sessao" finds "sessão".
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function projectName(cwd: string): string {
  return path.basename(cwd) || cwd;
}

function matches(session: SessionEntry, title: string, query: string): boolean {
  if (query === "") return true;
  const haystack = fold([title, session.id, session.branch ?? "", projectName(session.cwd)].join(" "));
  return fold(query)
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => haystack.includes(word));
}

// The current project first, then the others by their latest session. Inside a project, newest first.
function ordered(sessions: readonly SessionEntry[], cwd: string | undefined): SessionEntry[] {
  const groups = new Map<string, SessionEntry[]>();
  for (const session of [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const group = groups.get(session.cwd) ?? [];
    group.push(session);
    groups.set(session.cwd, group);
  }
  const keys = [...groups.keys()].sort((a, b) => Number(b === cwd) - Number(a === cwd));
  return keys.flatMap((key) => groups.get(key) ?? []);
}

// A project label takes a line, and a blank line before it unless it opens the list.
function startsProject(visible: readonly SessionEntry[], position: number): boolean {
  return position === 0 || visible[position - 1]?.cwd !== visible[position]?.cwd;
}

function rowsAt(visible: readonly SessionEntry[], position: number): number {
  if (!startsProject(visible, position)) return 1;
  return position === 0 ? 2 : 3;
}

// Grows the window around the selected session until the rows run out.
function windowAround(visible: readonly SessionEntry[], index: number, budget: number): [number, number] {
  let start = index;
  let end = index + 1;
  let used = rowsAt(visible, index);
  for (;;) {
    let grew = false;
    if (end < visible.length && used + rowsAt(visible, end) <= budget) {
      used += rowsAt(visible, end);
      end += 1;
      grew = true;
    }
    if (start > 0 && used + rowsAt(visible, start - 1) <= budget) {
      start -= 1;
      used += rowsAt(visible, start);
      grew = true;
    }
    if (!grew) return [start, end];
  }
}

export function SessionPicker({ sessions, cwd, branch = null, onPick, onPreview, onRename, now = Date.now() }: SessionPickerProps): React.ReactElement {
  const { columns, rows } = useWindowSize();
  const [query, setQuery] = useState("");
  const [allProjects, setAllProjects] = useState(cwd === undefined);
  const [onlyBranch, setOnlyBranch] = useState(false);
  const [selected, setSelected] = useState(0);
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<readonly PreviewEntry[] | null>(null);

  const titleOf = (session: SessionEntry) => titles.get(session.id) ?? session.title;
  const visible = ordered(sessions, cwd).filter(
    (session) =>
      (allProjects || session.cwd === cwd) &&
      (!onlyBranch || branch === null || session.branch === branch) &&
      matches(session, titleOf(session), query),
  );
  const index = Math.min(selected, Math.max(0, visible.length - 1));
  const current = visible[index];

  useEffect(() => {
    if (!previewOpen || current === undefined || onPreview === undefined) return;
    let alive = true;
    setPreview(null);
    onPreview(current.id)
      .then((entries) => {
        if (alive) setPreview(entries);
      })
      .catch(() => {
        if (alive) setPreview([]);
      });
    return () => {
      alive = false;
    };
  }, [previewOpen, current?.id, onPreview]);

  const move = (delta: number) => setSelected(Math.min(Math.max(0, index + delta), Math.max(0, visible.length - 1)));

  useInput((input, key) => {
    if (renaming !== null) {
      if (key.escape) setRenaming(null);
      else if (key.return && current !== undefined) {
        const title = renaming.trim();
        setRenaming(null);
        if (title === "" || onRename === undefined) return;
        const id = current.id;
        void onRename(id, title).then(() => setTitles((previous) => new Map(previous).set(id, title)));
      } else if (key.backspace || key.delete) setRenaming((value) => (value ?? "").slice(0, -1));
      else if (input !== "" && !key.ctrl && !key.meta) setRenaming((value) => (value ?? "") + input);
      return;
    }
    if (key.escape) onPick(null);
    else if (key.return) onPick(current ?? null);
    else if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp || key.pageDown) move(key.pageUp ? -5 : 5);
    else if (key.ctrl && input === "a") {
      setAllProjects((value) => cwd === undefined || !value);
      setSelected(0);
    } else if (key.ctrl && input === "b") {
      setOnlyBranch((value) => !value);
      setSelected(0);
    } else if (key.ctrl && input === "e") {
      // Ink 8 does not pass F2 to useInput (its key name is not exposed), so Ctrl+E renames.
      if (current !== undefined && onRename !== undefined) setRenaming(titleOf(current));
    } else if (key.backspace || key.delete) {
      setQuery((value) => value.slice(0, -1));
      setSelected(0);
    } else if (input === " " && query === "") {
      setPreviewOpen((value) => !value);
    } else if (input !== "" && !key.ctrl && !key.meta && !key.tab) {
      setQuery((value) => value + input);
      setSelected(0);
    }
  });

  const width = columns;
  const budget = Math.max(1, rows - CHROME_ROWS - (previewOpen ? PREVIEW_ROWS : 0));
  const [start, end] = visible.length === 0 ? [0, 0] : windowAround(visible, index, budget);
  const countText = visible.length === 0 ? "0 of 0" : `${index + 1} of ${visible.length}`;
  const hint =
    renaming !== null
      ? "enter save · esc cancel"
      : [
          "↑↓ move",
          "enter open",
          previewOpen ? "space close preview" : "space preview",
          "ctrl+e rename",
          cwd === undefined ? null : allProjects ? "ctrl+a this project" : "ctrl+a all projects",
          branch === null ? null : onlyBranch ? "ctrl+b all branches" : "ctrl+b this branch",
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between" paddingX={2}>
        <Text>
          <Text bold>plif</Text>
          {"  resume a session"}
        </Text>
        <Text color={palette.meta}>{countText}</Text>
      </Box>
      <Box marginTop={1} paddingX={2}>
        {query === "" ? (
          <Text color={palette.meta}>{glyph.search} search…</Text>
        ) : (
          <Text>
            {glyph.search} {query}
            <Text color={palette.accent}>█</Text>
          </Text>
        )}
      </Box>

      {visible.length === 0 ? (
        <Box marginTop={1} paddingX={2}>
          <Text color={palette.meta}>{sessions.length === 0 ? "No sessions yet." : "No session matches."}</Text>
        </Box>
      ) : null}

      {visible.slice(start, end).map((session, offset) => {
        const position = start + offset;
        const active = position === index;
        const meta = [timeAgo(session.updatedAt, now), session.branch, formatSize(session.bytes), session.vps ? `vps ${session.vps.name}` : undefined]
          .filter(Boolean)
          .join(" · ");
        const label = renaming !== null && active ? `rename: ${renaming}` : titleOf(session) || "(untitled)";
        const textColor = active ? palette.background : undefined;
        const metaColor = active ? palette.background : palette.meta;
        return (
          <Box key={session.id} flexDirection="column">
            {startsProject(visible, position) ? (
              <>
                {position === 0 ? null : <Box height={1} />}
                <Box paddingX={2}>
                  <Text color={palette.meta}>{projectName(session.cwd)}</Text>
                </Box>
              </>
            ) : null}
            <Box width={width} paddingX={2} justifyContent="space-between" backgroundColor={active ? palette.accent : undefined}>
              <Box flexGrow={1} flexShrink={1} marginRight={2}>
                <Text color={textColor} wrap="truncate-end">
                  {label}
                </Text>
              </Box>
              <Text color={metaColor}>{meta}</Text>
            </Box>
            {active && previewOpen ? <PreviewPane entries={preview} /> : null}
          </Box>
        );
      })}

      {visible.length === 0 ? null : <Box height={1} />}
      <Box paddingX={2}>
        <Text color={palette.meta}>{hint}</Text>
      </Box>
    </Box>
  );
}

function PreviewPane({ entries }: { readonly entries: readonly PreviewEntry[] | null }): React.ReactElement {
  if (entries === null) {
    return (
      <Box paddingLeft={6} marginBottom={1}>
        <Text color={palette.meta}>loading…</Text>
      </Box>
    );
  }
  if (entries.length === 0) {
    return (
      <Box paddingLeft={6} marginBottom={1}>
        <Text color={palette.meta}>session has no messages</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingLeft={6} marginBottom={1}>
      {entries.map((entry, index) => (
        <Box key={index} marginTop={index === 0 ? 0 : 1}>
          <Text wrap="truncate-end" bold={entry.role === "user"}>
            {entry.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

// "1 hour ago", "just now". Older than a month counts in months.
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  const ago = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many} ago`;
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return ago(minutes, "minute", "minutes");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ago(hours, "hour", "hours");
  const days = Math.floor(hours / 24);
  if (days < 30) return ago(days, "day", "days");
  return ago(Math.floor(days / 30), "month", "months");
}

// Whole kilobytes below 1 MB, one decimal in megabytes above it.
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
