import assert from "node:assert/strict";
import { test } from "node:test";
import { loadMascot } from "../src/tui/mascot.js";

test("mascote do cabeçalho tem quatro linhas de meio-bloco", () => {
  const lines = loadMascot();
  assert.equal(lines.length, 4);
  assert.ok(lines.some((line) => /[▀▄█]/.test(line)));
});

test("o mascote mantém os olhos escuros dentro do corpo azul", () => {
  const lines = loadMascot();
  // Body #2F5FD6 and eyes #0A1233, as truecolor codes from plif-small.ans.
  assert.ok(lines.some((line) => line.includes("\x1b[38;2;10;18;51m")), "eyes");
  assert.ok(lines.some((line) => line.includes("\x1b[38;2;47;95;214m")), "body");
});
