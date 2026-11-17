import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import type { ApprovalAnswer, ApprovalRequest } from "../types.js";
import { glyph, palette, reducedMotion, verbFor } from "./theme.js";

// Dialogs that stop the conversation and wait for an answer.

// Same order as the focus index in the approval box.
export const APPROVAL_OPTIONS = ["Deny", "Allow once", "Allow this session"] as const;
export const APPROVAL_ANSWERS: readonly ApprovalAnswer[] = ["deny", "once", "session"];

const DESTRUCTIVE = /\bapag|\bdelet|\bremov|\brm\b|sobrescrev|overwrit|destrut|destructive|reset --hard|push --force|fora do projeto|outside the project/i;

// Focus starts on Deny only when the reason or the command says the action destroys something.
export function initialApprovalFocus(request: ApprovalRequest): number {
  return DESTRUCTIVE.test(`${request.reason} ${request.summary}`) ? 0 : 1;
}

// The short consequence at the right of the question. It repeats what the reason says, in a few words.
function consequenceOf(request: ApprovalRequest): string {
  const text = `${request.reason} ${request.summary}`;
  if (/\brm\b|\bdelet|\bapag|\bremov/i.test(text)) return "deletes files";
  if (/reset --hard/i.test(text)) return "discards changes";
  if (/push --force/i.test(text)) return "rewrites remote history";
  if (/sobrescrev|overwrit/i.test(text)) return "overwrites files";
  if (/fora do projeto|outside the project/i.test(text)) return "writes outside the project";
  return "needs approval";
}

const PULSE = [palette.meta, palette.warn, palette.meta, palette.warn];
const PULSE_MS = 150;

// The rail alternates warn and meta twice when the box arrives, then stays warn.
function useRailColor(): string {
  const [step, setStep] = useState(reducedMotion ? PULSE.length : 0);
  useEffect(() => {
    if (step >= PULSE.length) return;
    const timer = setTimeout(() => setStep(step + 1), PULSE_MS);
    return () => clearTimeout(timer);
  }, [step]);
  return step < PULSE.length ? (PULSE[step] ?? palette.warn) : palette.warn;
}

// Each row of the block gets its own rail cell, so the rail runs the full height of the question.
function Rail({ color, children }: { readonly color: string; readonly children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {React.Children.toArray(children).map((child, index) => (
        <Box key={index}>
          <Text color={color}>{`${glyph.rail} `}</Text>
          <Box flexDirection="column" flexGrow={1}>
            {child}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

export function Approval({
  request,
  selected,
  width,
}: {
  readonly request: ApprovalRequest;
  readonly selected: number;
  readonly width: number;
}): React.ReactElement {
  const rail = useRailColor();
  const question = `${verbFor(request.tool).replace(/^./, (letter) => letter.toUpperCase())} ${request.summary}?`;
  const origin = request.from === undefined ? "" : `${request.from} · `;
  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      <Rail color={rail}>
        <Box justifyContent="space-between">
          <Text bold>{question}</Text>
          <Text color={palette.meta}>{`${origin}${consequenceOf(request)}`}</Text>
        </Box>
        <Text color={palette.meta}>{`  ${request.reason}`}</Text>
        <Box>
          <Text>{"  "}</Text>
          {APPROVAL_OPTIONS.map((label, index) => (
            <Box key={label} marginRight={3}>
              <Choice label={label} active={selected === index} />
            </Box>
          ))}
        </Box>
        <Text color={palette.meta}>{"  enter confirm · y once · s session · n or esc deny · ctrl+c stop turn"}</Text>
      </Rail>
    </Box>
  );
}

const LOGO_GAP = 3;

export function TrustDialog({
  cwd,
  logo,
  selected,
}: {
  readonly cwd: string;
  readonly logo: readonly string[];
  readonly selected: number;
}): React.ReactElement {
  const logoWidth = Math.max(0, ...logo.map((line) => [...line.replace(/\x1b\[[0-9;]*m/g, "")].length));
  // The mascot sits beside the first lines of text, as in the header.
  const beside = [undefined, "plif", `First time in ${cwd}.`];
  return (
    <Box flexDirection="column" marginTop={1}>
      {logo.map((line, index) => (
        <Box key={index}>
          <Box width={logoWidth + LOGO_GAP} flexShrink={0}>
            <Text>{line}</Text>
          </Box>
          {beside[index] === undefined ? null : <Text>{beside[index]}</Text>}
        </Box>
      ))}
      <Box marginTop={1} flexDirection="column" paddingLeft={2}>
        <Text>Plif can read, edit and run files in this folder.</Text>
        <Text>Trust it?</Text>
      </Box>
      <Box marginTop={1} paddingLeft={2}>
        <Box marginRight={3}>
          <Choice label="Trust this folder" active={selected === 0} />
        </Box>
        <Choice label="Not now" active={selected === 1} />
      </Box>
      <Box marginTop={1} paddingLeft={2}>
        <Text color={palette.meta}>enter confirm · esc exits without trusting</Text>
      </Box>
    </Box>
  );
}

// Focus is reverse video in the accent colour. There is no cursor glyph.
function Choice({ label, active }: { readonly label: string; readonly active: boolean }): React.ReactElement {
  return <Text color={active ? palette.accent : undefined} inverse={active}>{` ${label} `}</Text>;
}
