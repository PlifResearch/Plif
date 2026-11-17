import { Box, type DOMElement, useBoxMetrics } from "ink";
import React, { useEffect, useRef } from "react";

export interface HistoryLimits {
  // How many rows the history can scroll back before its first line reaches the top.
  readonly maxScroll: number;
  // Rows the history area shows at once.
  readonly viewport: number;
}

export interface HistoryViewProps {
  // Rows scrolled back from the newest line. 0 keeps the newest line at the bottom of the area.
  readonly scrollBack: number;
  readonly onLimits: (limits: HistoryLimits) => void;
  readonly children: React.ReactNode;
}

// The history fills the space above the live area and shows its end. Heights come from the layout itself,
// so a wrapped line or a long tool output never pushes the prompt off the screen.
// The live area below must use flexShrink={0}; otherwise both shrink together and rounding makes them overlap.
export function HistoryView({ scrollBack, onLimits, children }: HistoryViewProps): React.ReactElement {
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const viewport = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);
  const maxScroll = Math.max(0, content.height - viewport.height);
  const back = Math.min(Math.max(0, scrollBack), maxScroll);

  useEffect(() => {
    onLimits({ maxScroll, viewport: viewport.height });
  }, [maxScroll, viewport.height, onLimits]);

  return (
    <Box ref={viewportRef} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" contentOffsetY={maxScroll - back}>
      <Box ref={contentRef} flexDirection="column" flexShrink={0}>
        {children}
      </Box>
    </Box>
  );
}
