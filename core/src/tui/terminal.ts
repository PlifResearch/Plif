import { isWindows } from "../platform.js";

// Outside Windows every terminal Plif targets draws these glyphs. On Windows the old console host (conhost)
// often runs with a raster font or a legacy code page, so Unicode is assumed only where a modern terminal says so.
export function supportsUnicode(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env["PLIF_ASCII"] === "1") return false;
  if (env["PLIF_ASCII"] === "0") return true;
  if (!isWindows(platform)) return true;
  return modernWindowsTerminal(env);
}

// SGR mouse reports (modes 1000, 1003, 1006) reach the program in Windows Terminal. The old console host
// turns them into console events that never arrive on stdin, and the escape codes only add noise there.
export function supportsMouse(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (!isWindows(platform)) return true;
  return (env["WT_SESSION"] ?? "") !== "";
}

function modernWindowsTerminal(env: NodeJS.ProcessEnv): boolean {
  if ((env["WT_SESSION"] ?? "") !== "") return true;
  if (env["TERM_PROGRAM"] === "vscode") return true;
  if (env["TERMINAL_EMULATOR"] === "JetBrains-JediTerm") return true;
  if (env["ConEmuANSI"] === "ON") return true;
  // Terminals that set TERM on Windows (mintty, Alacritty, WezTerm) are xterm-like and draw Unicode.
  const term = env["TERM"] ?? "";
  return /^(xterm|alacritty|wezterm|rxvt-unicode)/.test(term);
}

// Windows Terminal binds Ctrl+V to its own text paste, which sends nothing when the clipboard holds only an image.
// On Windows, Alt+V asks for the clipboard image as well.
export function isImagePasteKey(
  input: string,
  key: { readonly ctrl: boolean; readonly meta: boolean },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (input !== "v") return false;
  return key.ctrl || (isWindows(platform) && key.meta);
}
