import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { palette } from "./theme.js";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

const GAP = 6;
// The scale starts after "quick ", so the rule lines up with the first label.
const SCALE_INDENT = 8;

export interface EffortMenuProps {
  readonly levels: readonly EffortLevel[];
  readonly current: EffortLevel;
  // The catalog default of the model, named under the scale.
  readonly modelDefault: EffortLevel;
  // persist: true saves it as the default in config.toml; false keeps it for this session only.
  readonly onConfirm: (level: EffortLevel, persist: boolean) => void;
  readonly onCancel: () => void;
}

// A scale from quick to thorough. The marker sits over the chosen level.
export function EffortMenu({ levels, current, modelDefault, onConfirm, onCancel }: EffortMenuProps): React.ReactElement {
  const [index, setIndex] = useState(() => Math.max(0, levels.indexOf(current)));
  const chosen = levels[index] ?? current;

  useInput((input, key) => {
    if (key.escape) onCancel();
    else if (key.leftArrow) setIndex((value) => Math.max(0, value - 1));
    else if (key.rightArrow) setIndex((value) => Math.min(levels.length - 1, value + 1));
    else if (key.return) onConfirm(chosen, true);
    else if (input === "s") onConfirm(chosen, false);
  });

  const starts: number[] = [];
  let total = 0;
  levels.forEach((level, position) => {
    starts.push(total);
    total += level.length + (position < levels.length - 1 ? GAP : 0);
  });
  const marker = (starts[index] ?? 0) + Math.floor(chosen.length / 2);
  const rule = "─".repeat(Math.max(1, total));

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text>
        <Text bold>plif</Text>
        {"  reasoning depth"}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text color={palette.meta}>
          {"  quick "}
          {rule.slice(0, marker)}
          <Text color={palette.accent}>◆</Text>
          {rule.slice(marker + 1)}
          {" thorough"}
        </Text>
        <Text>
          {" ".repeat(SCALE_INDENT)}
          {levels.map((level, position) => (
            <Text key={level} color={position === index ? palette.accent : palette.meta}>
              {level}
              {position < levels.length - 1 ? " ".repeat(GAP) : ""}
            </Text>
          ))}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={palette.meta}>the model default is {modelDefault} · more depth spends more tokens and takes longer</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={palette.meta}>←→ adjust · enter save as default · s this session only · esc cancel</Text>
      </Box>
    </Box>
  );
}
