import { readFileSync } from "node:fs";
import { findRepoFile } from "../repo.js";

export const ACCENT = "#2F5FD6";
export const ACCENT_DARK = "#0A1233";

// Four rows of half-block pixels (7x8), drawn from plif.ans, with their own colours: the eyes are dark blocks inside
// the blue body, so they read against the body (3.25:1) whatever the terminal background is.
export function loadMascot(): string[] {
  const text = readFileSync(findRepoFile("assets/mascot/plif-small.ans"), "utf8");
  return text.replace(/\n$/, "").split("\n");
}
