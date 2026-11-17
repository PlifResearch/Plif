import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import { KeySetup } from "../src/tui/key-setup.js";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz_0123";

// Input listeners attach after the first commit, so the tests wait one tick before typing.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a chave aparece como asteriscos e nunca em texto na tela", async () => {
  const { lastFrame, stdin, unmount } = render(
    <KeySetup envName="ANTHROPIC_API_KEY" problem={null} storage="Keychain do macOS" onSubmit={() => {}} onCancel={() => {}} />,
  );
  await settle();
  stdin.write("sk-ant-abc");
  await settle();
  const frame = lastFrame() ?? "";
  assert.match(frame, /\*{10}/);
  assert.doesNotMatch(frame, /sk-ant/);
  assert.match(frame, /Keychain do macOS/);
  unmount();
});

test("colar a chave e apertar Enter entrega a chave inteira", async () => {
  let delivered = "";
  const { stdin, unmount } = render(
    <KeySetup envName="ANTHROPIC_API_KEY" problem={null} storage="x" onSubmit={(key) => (delivered = key)} onCancel={() => {}} />,
  );
  await settle();
  stdin.write(`${KEY}\r`);
  assert.equal(delivered, KEY);
  unmount();
});

test("o motivo da recusa aparece acima do campo", () => {
  const { lastFrame, unmount } = render(
    <KeySetup envName="ANTHROPIC_API_KEY" problem="a chave deveria começar com sk-ant-" storage="x" onSubmit={() => {}} onCancel={() => {}} />,
  );
  assert.match(lastFrame() ?? "", /começar com sk-ant-/);
  unmount();
});

test("ctrl+c sai; esc não sai da Plif nesta tela", async () => {
  let cancelled = false;
  const { stdin, unmount } = render(
    <KeySetup envName="ANTHROPIC_API_KEY" problem={null} storage="x" onSubmit={() => {}} onCancel={() => (cancelled = true)} />,
  );
  stdin.write("\x1b");
  // Ink waits briefly to tell a lone Esc from the start of an escape sequence.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(cancelled, false);
  stdin.write("\x03");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cancelled, true);
  unmount();
});
