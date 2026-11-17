import { Box, Text, useInput, useWindowSize } from "ink";
import React, { useState } from "react";
import type { Vps } from "../vps.js";
import { palette } from "./theme.js";

export interface VpsDraft {
  readonly name: string;
  readonly host: string;
  readonly user: string;
  readonly port: string;
  readonly keyPath: string;
}

export interface VpsBrowserProps {
  readonly list: readonly Vps[];
  readonly active: string | null;
  readonly onToggle: (vps: Vps | null) => void;
  readonly onAdd: (draft: VpsDraft) => Promise<string>;
  readonly onTest: (vps: Vps) => Promise<string>;
  readonly onDelete: (vps: Vps) => Promise<string>;
  readonly onClose: () => void;
}

const FIELDS: ReadonlyArray<{ readonly key: keyof VpsDraft; readonly label: string; readonly fallback: string }> = [
  { key: "name", label: "name (short, e.g. prod)", fallback: "" },
  { key: "host", label: "IP or host", fallback: "" },
  { key: "user", label: "user", fallback: "root" },
  { key: "port", label: "port", fallback: "22" },
  { key: "keyPath", label: "private key path (e.g. ~/.ssh/id_ed25519)", fallback: "" },
];

// Keys: Enter switches the VPS on or off for this session, a adds one, t tests, d removes, Esc closes.
export function VpsBrowser(props: VpsBrowserProps): React.ReactElement {
  const { columns } = useWindowSize();
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<"list" | "add" | "delete">("list");
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<VpsDraft>({ name: "", host: "", user: "", port: "", keyPath: "" });
  const [input, setInput] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const current = props.list[selected];

  useInput((char, key) => {
    if (mode === "add") {
      if (key.escape) {
        setMode("list");
        setInput("");
        setStep(0);
        return;
      }
      if (key.return) {
        const field = FIELDS[step];
        if (field === undefined) return;
        const value = input.trim() === "" ? field.fallback : input.trim();
        const next = { ...draft, [field.key]: value };
        if (step + 1 < FIELDS.length) {
          setDraft(next);
          setInput("");
          setStep(step + 1);
          return;
        }
        setMode("list");
        setInput("");
        setStep(0);
        setMessage("testing the connection…");
        void props.onAdd(next).then(setMessage);
        return;
      }
      if (key.backspace || key.delete) setInput((value) => value.slice(0, -1));
      else if (char !== "" && !key.ctrl && !key.meta) setInput((value) => value + char);
      return;
    }

    if (mode === "delete") {
      if (char === "y" && current !== undefined) {
        setMode("list");
        void props.onDelete(current).then((text) => {
          setMessage(text);
          setSelected(0);
        });
      } else {
        setMode("list");
      }
      return;
    }

    if (key.escape) props.onClose();
    else if (key.upArrow) setSelected((index) => Math.max(0, index - 1));
    else if (key.downArrow) setSelected((index) => Math.min(Math.max(0, props.list.length - 1), index + 1));
    else if (key.return && current !== undefined) {
      const turningOff = props.active === current.name;
      props.onToggle(turningOff ? null : current);
      setMessage(turningOff ? `${current.name} is off for this session` : `${current.name} is on for this session. Commands that target it run over SSH.`);
    } else if (char === "a") {
      setMode("add");
      setStep(0);
      setInput("");
      setMessage(null);
    } else if (char === "t" && current !== undefined) {
      setMessage(`testing ${current.name}…`);
      void props.onTest(current).then(setMessage);
    } else if (char === "d" && current !== undefined) {
      setMode("delete");
    }
  });

  return (
    <Box flexDirection="column" width={columns}>
      <Box justifyContent="space-between" paddingX={2}>
        <Text>
          <Text bold>plif</Text>
          {"  VPS"}
        </Text>
        {mode === "list" && props.list.length > 0 ? (
          <Text color={palette.meta}>{`${selected + 1} of ${props.list.length}`}</Text>
        ) : null}
      </Box>

      {mode === "add" ? (
        <Box flexDirection="column" marginTop={1} paddingX={2}>
          {FIELDS.map((field, index) => {
            const hint = field.fallback === "" ? "" : ` [${field.fallback}]`;
            const label = index === step ? `${field.label}${hint}: ${input}` : index < step ? `${field.label}: ${draft[field.key]}` : field.label;
            return (
              <Text key={field.key} color={index === step ? palette.accent : index > step ? palette.meta : undefined}>
                {label}
                {index === step ? <Text color={palette.accent}>█</Text> : null}
              </Text>
            );
          })}
          <Text color={palette.meta}>Enter next · Esc cancel · empty uses the value in brackets when there is one</Text>
        </Box>
      ) : props.list.length === 0 ? (
        <Box marginTop={1} paddingX={2}>
          <Text color={palette.meta}>No VPS yet. Press a to add one (key authentication only).</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {props.list.map((vps, index) => {
            const active = index === selected;
            const on = props.active === vps.name;
            const fg = active ? palette.background : undefined;
            const muted = active ? palette.background : palette.meta;
            return (
              <Box key={vps.name} width={columns} paddingX={2} justifyContent="space-between" backgroundColor={active ? palette.accent : undefined}>
                <Box flexShrink={1} marginRight={2}>
                  <Text color={fg} wrap="truncate-end">
                    {vps.name} <Text color={muted}>{`${vps.user}@${vps.host}:${vps.port}`}</Text>
                  </Text>
                </Box>
                <Text color={muted}>{on ? "on in this session" : "off"}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {mode === "delete" && current !== undefined ? (
        <Box marginTop={1} paddingX={2}>
          <Text color={palette.warn}>Remove {current.name} from vps.json? y confirms · any other key cancels</Text>
        </Box>
      ) : null}
      {message !== null ? (
        <Box marginTop={1} paddingX={2}>
          <Text>{message}</Text>
        </Box>
      ) : null}
      {mode === "list" ? (
        <Box marginTop={1} paddingX={2}>
          <Text color={palette.meta}>enter on or off · a add · t test · d remove · esc close</Text>
        </Box>
      ) : null}
    </Box>
  );
}
