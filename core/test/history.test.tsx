import assert from "node:assert/strict";
import { test } from "node:test";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { type HistoryLimits, HistoryView } from "../src/tui/history.js";

const lines = Array.from({ length: 12 }, (_, index) => `linha ${index + 1}`);

// The measurement arrives a moment after the first layout, and later under load, so the tests wait for it.
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("tempo esgotado esperando o layout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function Frame({ scrollBack, onLimits }: { readonly scrollBack: number; readonly onLimits: (limits: HistoryLimits) => void }) {
  return (
    <Box flexDirection="column" height={6}>
      <HistoryView scrollBack={scrollBack} onLimits={onLimits}>
        {lines.map((line) => (
          <Text key={line}>{line}</Text>
        ))}
      </HistoryView>
      <Box flexShrink={0}>
        <Text>prompt</Text>
      </Box>
    </Box>
  );
}

test("o histórico mostra o fim e deixa o prompt embaixo", async () => {
  let limits: HistoryLimits = { maxScroll: 0, viewport: 0 };
  const { lastFrame, unmount } = render(<Frame scrollBack={0} onLimits={(next) => (limits = next)} />);
  try {
    const expected = ["linha 8", "linha 9", "linha 10", "linha 11", "linha 12", "prompt"];
    // The limits are reported by an effect that runs just after the frame is drawn.
    await waitFor(() => (lastFrame() ?? "") === expected.join("\n") && limits.viewport > 0);
    assert.deepEqual(limits, { maxScroll: 7, viewport: 5 });
  } finally {
    unmount();
  }
});

test("rolar para trás mostra linhas anteriores, e não passa do começo", async () => {
  const { lastFrame, rerender, unmount } = render(<Frame scrollBack={3} onLimits={() => {}} />);
  try {
    await waitFor(() => (lastFrame() ?? "").startsWith("linha 5\n"));
    rerender(<Frame scrollBack={99} onLimits={() => {}} />);
    await waitFor(() => (lastFrame() ?? "").startsWith("linha 1\n"));
    assert.match(lastFrame() ?? "", /linha 5\nprompt$/);
  } finally {
    unmount();
  }
});
