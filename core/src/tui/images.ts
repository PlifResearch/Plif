import type Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION, MAX_IMAGE_BASE64_CHARS, type MediaType, checkImage } from "../media.js";
import { windowsPowerShell } from "../keystore-windows.js";
import { isWindows } from "../platform.js";

export type { MediaType } from "../media.js";

export interface ImageBytes {
  readonly mediaType: MediaType;
  readonly bytes: Buffer;
}

// Each image is a file in a temp folder on this computer. The prompt keeps only its id.
export interface ImageAttachment {
  readonly mediaType: MediaType;
  // [Image #N] counts across the whole session, so a later prompt can point back to an earlier image.
  readonly number: number;
  path: string;
}

export class Attachments extends Map<string, ImageAttachment> {
  next: number;
  constructor(first = 1) {
    super();
    this.next = first;
  }
}

const MAX_BASE64_CHARS = MAX_IMAGE_BASE64_CHARS;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
// Prompt text holds each image as a private-use marker with the attachment id, so numbering follows the text.
const OPEN = "";
const CLOSE = "";
const MARKER = /([0-9a-f]+)/g;
// Terminals paste dragged files as shell words: quoted, or with backslash-escaped characters.
const WORD = /'[^']*'|"[^"]*"|(?:\\.|[^ \t'"\\]|\\)+/g;
// On Windows the backslash separates folders, and Windows Terminal wraps a dropped path in double quotes when it has spaces.
// An apostrophe is legal in a Windows file name, so single quotes count only around a whole word.
const WINDOWS_WORD = /"[^"]*"|'[^']*'(?=[ \t]|$)|[^ \t"]+/g;
// C:\folder, C:/folder and \\server\share.
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/;
const CLIPBOARD_TIMEOUT_MS = 10_000;

export function hasImages(value: string): boolean {
  return value.includes(OPEN);
}

// Each marker shows the session number of its image. Without the record, images count from 1 in the prompt.
export function displayText(value: string, attachments?: Attachments): string {
  let count = 0;
  return value.replace(MARKER, (_marker, id: string) => `[Image #${attachments?.get(id)?.number ?? ++count}]`);
}

// The numbers of the images in a prompt, in the order they appear.
export function imageNumbers(value: string, attachments: Attachments): number[] {
  return [...value.matchAll(MARKER)].flatMap((match) => {
    const number = attachments.get(match[1] ?? "")?.number;
    return number === undefined ? [] : [number];
  });
}

export function removeLast(value: string): string {
  if (value.endsWith(CLOSE)) {
    const start = value.lastIndexOf(OPEN);
    if (start !== -1) return value.slice(0, start);
  }
  return value.slice(0, -1);
}

// A dragged file is copied into the staging folder, so the prompt does not depend on where the file lives.
export function absorbDroppedImages(
  value: string,
  attachments: Attachments,
  staging: string,
  platform: NodeJS.Platform = process.platform,
): { value: string; rejected: string[] } {
  const rejected: string[] = [];
  let next = value;
  const windows = isWindows(platform);
  // Only absolute paths and file:// links count, so a word like "logo.png" typed in a sentence stays text.
  const found = [...value.matchAll(windows ? WINDOWS_WORD : WORD)].filter((match) => {
    const word = unquote(match[0], windows);
    if (!IMAGE_FILE.test(word)) return false;
    if (word.startsWith("/") || word.startsWith("~/") || word.startsWith("file://")) return true;
    return windows && (WINDOWS_ABSOLUTE.test(word) || word.startsWith("~\\"));
  });
  // Attached left to right, so the numbers follow the text. Replaced right to left, so the indices stay valid.
  const accepted: Array<{ index: number; length: number; id: string }> = [];
  for (const match of found) {
    const file = pathOfWord(unquote(match[0], windows), windows);
    const image = readImageFile(file);
    if (typeof image === "string") {
      rejected.push(`${file}: ${image}`);
      continue;
    }
    accepted.push({ index: match.index ?? 0, length: match[0].length, id: attach(attachments, image, staging) });
  }
  for (const { index, length, id } of accepted.reverse()) {
    next = `${next.slice(0, index)}${OPEN}${id}${CLOSE}${next.slice(index + length)}`;
  }
  return { value: next, rejected };
}

export type ClipboardRunner = (command: string, args: string[], options: RunOptions) => Promise<Buffer>;

export interface RunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeout?: number;
  readonly windowsHide?: boolean;
}

// Null when the clipboard holds no image, or when the platform has no clipboard tool.
export async function readClipboardImage(
  platform: NodeJS.Platform = process.platform,
  runner: ClipboardRunner = run,
): Promise<ImageBytes | null> {
  try {
    if (platform === "darwin") return await clipboardOnMac();
    if (platform === "linux") return await clipboardOnLinux();
    if (isWindows(platform)) return await clipboardOnWindows(runner);
    return null;
  } catch {
    return null;
  }
}

export function attachImage(value: string, attachments: Attachments, image: ImageBytes, staging: string): string {
  const id = attach(attachments, image, staging);
  return `${value}${OPEN}${id}${CLOSE}`;
}

// Moves the images of a prompt from staging into the session folder, where they stay with the session.
export function storeAttachments(value: string, attachments: Attachments, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const match of value.matchAll(MARKER)) {
    const attachment = attachments.get(match[1] ?? "");
    if (attachment === undefined) continue;
    const target = path.join(destination, path.basename(attachment.path));
    if (attachment.path !== target) renameSync(attachment.path, target);
    attachment.path = target;
  }
}

// Reads each image from its file when the message is built. Markers without an image are kept as text.
export function messageContentFor(value: string, attachments: Attachments): string | Anthropic.ContentBlockParam[] {
  if (!hasImages(value)) return value.trim();
  const blocks: Anthropic.ContentBlockParam[] = [];
  let text = "";
  let count = 0;
  let last = 0;
  for (const match of value.matchAll(MARKER)) {
    const start = match.index ?? 0;
    const attachment = attachments.get(match[1] ?? "");
    // The label sits right before its image, so "this one [Image #2]" in the text points at the next block.
    text += value.slice(last, start) + `[Image #${attachment?.number ?? ++count}]`;
    last = start + match[0].length;
    if (attachment === undefined) continue;
    pushText(blocks, text);
    text = "";
    const data = readFileSync(attachment.path).toString("base64");
    blocks.push({ type: "image", source: { type: "base64", media_type: attachment.mediaType, data } });
  }
  pushText(blocks, text + value.slice(last));
  return blocks;
}

// Images the person attached in a conversation. Images returned by tools are not numbered.
export function countImages(messages: readonly Anthropic.MessageParam[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    count += message.content.filter((block) => block.type === "image").length;
  }
  return count;
}

// Drops the record of the images a sent prompt used. The files stay in the session folder.
export function releaseAttachments(value: string, attachments: Attachments): void {
  for (const match of value.matchAll(MARKER)) attachments.delete(match[1] ?? "");
}

function attach(attachments: Attachments, image: ImageBytes, staging: string): string {
  const id = randomUUID().replaceAll("-", "");
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const file = path.join(staging, `${id}.${EXTENSION[image.mediaType]}`);
  writeFileSync(file, image.bytes, { mode: 0o600 });
  attachments.set(id, { mediaType: image.mediaType, path: file, number: attachments.next++ });
  return id;
}

function pushText(blocks: Anthropic.ContentBlockParam[], text: string): void {
  if (text.trim() !== "") blocks.push({ type: "text", text });
}

function unquote(word: string, windows = false): string {
  if (word.length >= 2 && ((word.startsWith("'") && word.endsWith("'")) || (word.startsWith('"') && word.endsWith('"')))) {
    return word.slice(1, -1);
  }
  return windows ? word : word.replace(/\\(.)/g, "$1");
}

// GNOME and other file managers drop file:// links, with spaces and accents percent-encoded.
function pathOfWord(word: string, windows = false): string {
  if (word.startsWith("file://")) {
    try {
      return fileURLToPath(word, { windows });
    } catch {
      return word;
    }
  }
  if (word.startsWith("~/") || (windows && word.startsWith("~\\"))) {
    return (windows ? path.win32 : path).join(os.homedir(), word.slice(2));
  }
  return word;
}

function readImageFile(file: string): ImageBytes | string {
  let info;
  try {
    info = statSync(file);
  } catch {
    return "file not found";
  }
  if (!info.isFile()) return "not a file";
  if ((info.size * 4) / 3 > MAX_BASE64_CHARS) return "larger than 10 MB";
  return imageFromBytes(readFileSync(file));
}

function imageFromBytes(bytes: Buffer): ImageBytes | string {
  const checked = checkImage(bytes);
  return typeof checked === "string" ? checked : { mediaType: checked.type, bytes };
}

function run(command: string, args: string[], options: RunOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, encoding: "buffer", maxBuffer: MAX_BASE64_CHARS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function clipboardOnMac(): Promise<ImageBytes | null> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plif-clip-"));
  const file = path.join(dir, "clipboard.png");
  try {
    await run("osascript", [
      "-e",
      "set imageData to the clipboard as «class PNGf»",
      "-e",
      `set fileRef to open for access POSIX file "${file}" with write permission`,
      "-e",
      "set eof fileRef to 0",
      "-e",
      "write imageData to fileRef",
      "-e",
      "close access fileRef",
    ]);
    const image = imageFromBytes(readFileSync(file));
    return typeof image === "string" ? null : image;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function clipboardOnLinux(): Promise<ImageBytes | null> {
  const bytes = process.env["WAYLAND_DISPLAY"]
    ? await run("wl-paste", ["--no-newline", "--type", "image/png"])
    : await run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
  const image = imageFromBytes(bytes);
  return typeof image === "string" ? null : image;
}

// Windows PowerShell 5.1 ships with every Windows 10 and 11 and has Get-Clipboard -Format Image (PowerShell 7 dropped it).
// The script goes base64 encoded, so no quoting rule of cmd or PowerShell can change it, and the file path goes by
// environment variable, so no part of it is ever parsed as code.
const WINDOWS_CLIPBOARD_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Drawing",
  "$image = Get-Clipboard -Format Image",
  "if ($null -eq $image) { exit 2 }",
  "$image.Save($env:PLIF_CLIPBOARD_FILE, [System.Drawing.Imaging.ImageFormat]::Png)",
  "$image.Dispose()",
].join("; ");

export function windowsClipboardCommand(file: string): { command: string; args: string[]; options: RunOptions } {
  return {
    command: windowsPowerShell(),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(WINDOWS_CLIPBOARD_SCRIPT, "utf16le").toString("base64"),
    ],
    options: { env: { ...process.env, PLIF_CLIPBOARD_FILE: file }, timeout: CLIPBOARD_TIMEOUT_MS, windowsHide: true },
  };
}

async function clipboardOnWindows(runner: ClipboardRunner): Promise<ImageBytes | null> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plif-clip-"));
  const file = path.join(dir, "clipboard.png");
  try {
    const { command, args, options } = windowsClipboardCommand(file);
    await runner(command, args, options);
    const image = imageFromBytes(readFileSync(file));
    return typeof image === "string" ? null : image;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
