// Design tokens from Decisions.md (2026-11-15). Every screen takes colours, glyphs and motion from here.
import { supportsUnicode } from "./terminal.js";

export type ThemeName = "dark" | "light";

export interface Palette {
  // undefined means the terminal's own foreground, which is the main text colour in both themes.
  readonly ink: string | undefined;
  readonly meta: string;
  readonly accent: string;
  readonly warn: string;
  readonly err: string;
  // The mascot's blue. Shapes only; it is too dark for text on a dark background.
  readonly pigment: string;
  readonly background: string;
}

const PALETTES: Record<ThemeName, Palette> = {
  dark: { ink: undefined, meta: "#8B9096", accent: "#7C9FF2", warn: "#E8B45C", err: "#F0786F", pigment: "#2F5FD6", background: "#0E1116" },
  light: { ink: undefined, meta: "#5F646B", accent: "#2F5FD6", warn: "#9A5B00", err: "#B42318", pigment: "#2F5FD6", background: "#FAFAF7" },
};

// PLIF_THEME wins. Otherwise COLORFGBG ("fg;bg", set by many terminals) tells a light background by its colour index.
export function detectTheme(env: NodeJS.ProcessEnv = process.env): ThemeName {
  const forced = env["PLIF_THEME"]?.toLowerCase();
  if (forced === "light" || forced === "dark") return forced;
  const background = Number(env["COLORFGBG"]?.split(";").at(-1));
  if (Number.isFinite(background) && (background === 7 || background >= 9)) return "light";
  return "dark";
}

export const theme: ThemeName = detectTheme();
export const palette: Palette = PALETTES[theme];

export function paletteFor(name: ThemeName): Palette {
  return PALETTES[name];
}

// Some of these are East Asian "ambiguous width" and take two cells in a few terminals; PLIF_ASCII=1 swaps them out.
// The old Windows console host gets the ASCII set too, unless PLIF_ASCII=0 asks for Unicode.
const UNICODE = {
  rail: "┃",
  user: "▌",
  prompt: "»",
  queued: "◇",
  running: "◆",
  done: "◼",
  failed: "✕",
  rule: "▀",
  search: "⌕",
} as const;

const ASCII: Record<keyof typeof UNICODE, string> = {
  rail: "|",
  user: "|",
  prompt: ">",
  queued: "-",
  running: "*",
  done: "#",
  failed: "x",
  rule: "=",
  search: "/",
};

export const ascii = !supportsUnicode();
export const glyph: Record<keyof typeof UNICODE, string> = ascii ? ASCII : { ...UNICODE };

export type ToolState = "queued" | "running" | "done" | "failed";

export function stateGlyph(state: ToolState): string {
  return glyph[state];
}

export function stateColor(state: ToolState): string | undefined {
  if (state === "failed") return palette.err;
  if (state === "running") return palette.accent;
  return palette.meta;
}

// The turn's rail takes the colour of the turn's state.
export type TurnState = "running" | "waiting" | "failed" | "done";

export function railColor(state: TurnState): string {
  if (state === "running") return palette.accent;
  if (state === "waiting") return palette.warn;
  if (state === "failed") return palette.err;
  return palette.meta;
}

// One element moves on screen: this spinner, beside the turn's clock. Reduced motion freezes it.
export const SPINNER = ascii ? ["-", "\\", "|", "/"] : ["▖", "▘", "▝", "▗"];
export const SPINNER_MS = 250;
export const reducedMotion = process.env["PLIF_REDUCED_MOTION"] === "1" || process.env["NO_MOTION"] === "1";

// Prose from the model wraps at 78 columns; tool lines and the frame use the full width.
export const MEASURE = 78;
// Columns inside a turn: rail at 0, glyph at 2, verb at 4 (7 wide), object at 13, tool output at 15.
export const COLUMN = { glyph: 2, verb: 4, object: 13, output: 15 } as const;
export const VERB_WIDTH = 7;

// Tool name to the verb shown in the verb column (Decisions, section 6).
export function verbFor(tool: string): string {
  switch (tool) {
    case "Read":
      return "read";
    case "Write":
      return "write";
    case "Edit":
      return "edit";
    case "Bash":
    case "Monitor":
      return "run";
    case "Terminal":
      return "term";
    case "Grep":
    case "WebSearch":
      return "search";
    case "Glob":
      return "list";
    case "WebFetch":
      return "fetch";
    case "WebView":
      return "view";
    case "Agent":
      return "explore";
    case "Plan":
      return "plan";
    case "Memory":
      return "memory";
    case "Git":
      return "git";
    default: {
      const parts = tool.split("__");
      return (parts[0] === "mcp" && parts.length >= 3 ? (parts[1] ?? tool) : tool).toLowerCase().slice(0, VERB_WIDTH);
    }
  }
}
