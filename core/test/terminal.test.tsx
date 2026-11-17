import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import { Header } from "../src/tui/components.js";
import { isImagePasteKey, supportsMouse, supportsUnicode } from "../src/tui/terminal.js";

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

test("Unicode: Linux e macOS seguem com os glifos, e PLIF_ASCII=1 ainda troca por ASCII", () => {
  assert.equal(supportsUnicode(env({}), "linux"), true);
  assert.equal(supportsUnicode(env({}), "darwin"), true);
  assert.equal(supportsUnicode(env({ PLIF_ASCII: "1" }), "linux"), false);
});

test("Unicode no Windows: conhost antigo usa ASCII, Windows Terminal e outros terminais modernos usam Unicode", () => {
  assert.equal(supportsUnicode(env({}), "win32"), false);
  assert.equal(supportsUnicode(env({ WT_SESSION: "b4a1c0de-0000-4000-8000-000000000000" }), "win32"), true);
  assert.equal(supportsUnicode(env({ TERM_PROGRAM: "vscode" }), "win32"), true);
  assert.equal(supportsUnicode(env({ TERM: "xterm-256color" }), "win32"), true);
  assert.equal(supportsUnicode(env({ WT_SESSION: "x", PLIF_ASCII: "1" }), "win32"), false);
  assert.equal(supportsUnicode(env({ PLIF_ASCII: "0" }), "win32"), true);
});

test("mouse SGR: ligado fora do Windows, e no Windows só no Windows Terminal", () => {
  assert.equal(supportsMouse(env({}), "linux"), true);
  assert.equal(supportsMouse(env({}), "darwin"), true);
  assert.equal(supportsMouse(env({}), "win32"), false);
  assert.equal(supportsMouse(env({ WT_SESSION: "" }), "win32"), false);
  assert.equal(supportsMouse(env({ WT_SESSION: "b4a1c0de" }), "win32"), true);
});

test("colar imagem: Ctrl+V em todo lugar, Alt+V só no Windows", () => {
  assert.equal(isImagePasteKey("v", { ctrl: true, meta: false }, "linux"), true);
  assert.equal(isImagePasteKey("v", { ctrl: true, meta: false }, "win32"), true);
  assert.equal(isImagePasteKey("v", { ctrl: false, meta: true }, "win32"), true);
  assert.equal(isImagePasteKey("v", { ctrl: false, meta: true }, "linux"), false);
  assert.equal(isImagePasteKey("v", { ctrl: false, meta: true }, "darwin"), false);
  assert.equal(isImagePasteKey("c", { ctrl: true, meta: false }, "win32"), false);
  assert.equal(isImagePasteKey("v", { ctrl: false, meta: false }, "win32"), false);
});

test("cabeçalho: sem sandbox na plataforma (Windows) diz unavailable, e nos outros sistemas segue on ou off", () => {
  const props = { logo: [], path: "~/p", details: "", modelLine: "model", opening: false };
  const frame = (sandbox: boolean, sandboxAvailable: boolean) =>
    render(<Header {...props} sandbox={sandbox} sandboxAvailable={sandboxAvailable} />).lastFrame() ?? "";
  assert.match(frame(false, false), /sandbox unavailable/);
  assert.match(frame(false, true), /sandbox off/);
  assert.match(frame(true, true), /sandbox on/);
});
