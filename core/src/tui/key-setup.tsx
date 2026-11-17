import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { palette } from "./theme.js";

export interface KeySetupProps {
  readonly envName: string;
  readonly problem: string | null;
  readonly storage: string;
  readonly onSubmit: (key: string) => void;
  readonly onCancel: () => void;
}

// The key is shown as asterisks, one per character. The typed text never reaches the screen or the log.
// Esc does not leave the app from this screen; Ctrl+C does.
export function KeySetup({ envName, problem, storage, onSubmit, onCancel }: KeySetupProps): React.ReactElement {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }
    if (input.includes("\r") || input.includes("\n")) {
      const head = input.split(/[\r\n]/)[0] ?? "";
      onSubmit(value + head);
      return;
    }
    if (key.return) {
      onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((current) => current.slice(0, -1));
      return;
    }
    if (input !== "" && !key.ctrl && !key.meta && !key.tab && !key.escape) setValue((current) => current + input);
  });

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text color={palette.pigment}>{"   ▄█▄"}</Text>
      <Text>
        <Text color={palette.pigment}>{"  █████   "}</Text>
        <Text bold>plif</Text>
      </Text>
      <Text>
        <Text color={palette.pigment}>{" ███████  "}</Text>
        <Text>No API key set. Paste one here to start.</Text>
      </Text>
      <Text color={palette.pigment}>{" ▀▀███▀▀"}</Text>
      <Text color={palette.pigment}>{"▀▀▀▀▀▀▀▀▀▀"}</Text>
      <Box marginTop={1}>
        <Text>
          It goes into {envName} and is stored in {storage}.
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          {"» "}
          {"*".repeat(value.length)}
          <Text color={palette.accent}>█</Text>
        </Text>
      </Box>
      {problem === null ? null : (
        <Box marginTop={1}>
          <Text color={palette.warn}>{problem}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={palette.meta}>enter save · ctrl+c exit</Text>
      </Box>
    </Box>
  );
}
