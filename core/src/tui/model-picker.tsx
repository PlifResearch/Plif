import { Box, Text, useInput, useWindowSize } from "ink";
import React, { useState } from "react";
import type { ModelEntry } from "../catalog.js";
import { palette } from "./theme.js";

export interface ModelPickerProps {
  readonly models: readonly ModelEntry[];
  readonly current: string;
  readonly onPick: (model: ModelEntry) => void;
  readonly onCancel: () => void;
}

// Enter switches the model for this session, the same as /model <id>.
export function ModelPicker({ models, current, onPick, onCancel }: ModelPickerProps): React.ReactElement {
  const { columns } = useWindowSize();
  const [selected, setSelected] = useState(() => Math.max(0, models.findIndex((model) => model.id === current)));

  useInput((_input, key) => {
    if (key.escape) onCancel();
    else if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    else if (key.downArrow) setSelected((value) => Math.min(models.length - 1, value + 1));
    else if (key.return) {
      const model = models[selected];
      if (model !== undefined) onPick(model);
    }
  });

  return (
    <Box flexDirection="column" width={columns}>
      <Box justifyContent="space-between" paddingX={2}>
        <Text>
          <Text bold>plif</Text>
          {"  choose the model"}
        </Text>
        <Text color={palette.meta}>{`${Math.min(selected + 1, models.length)} of ${models.length}`}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {models.map((model, position) => {
          const active = position === selected;
          return (
            <Box
              key={model.id}
              width={columns}
              paddingX={2}
              justifyContent="space-between"
              backgroundColor={active ? palette.accent : undefined}
            >
              <Text color={active ? palette.background : undefined} wrap="truncate-end">
                {model.name}
              </Text>
              <Text color={active ? palette.background : palette.meta}>{`default effort ${model.defaultEffort}`}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} paddingX={2}>
        <Text color={palette.meta}>enter switch · esc cancel</Text>
      </Box>
    </Box>
  );
}
