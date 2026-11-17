import assert from "node:assert/strict";
import { test } from "node:test";
import { collapseRepeats, estimateTokens, limitOutput, stripAnsi } from "../src/output.js";

test("limitOutput mantém o começo e o fim e informa o que saiu", () => {
  const text = `HEAD${"m".repeat(10_000)}TAIL`;
  const limited = limitOutput(text, 1000);
  assert.ok(limited.length < 1200, `length ${limited.length}`);
  assert.ok(limited.startsWith("HEAD"));
  assert.ok(limited.endsWith("TAIL"));
  assert.match(limited, /characters omitted/);
  assert.equal(limitOutput("short", 1000), "short");
});

test("stripAnsi remove cores e fica com o último trecho de linhas de progresso", () => {
  assert.equal(stripAnsi("\x1b[31merro\x1b[0m"), "erro");
  assert.equal(stripAnsi("10%\r50%\r100%"), "100%");
});

test("collapseRepeats resume linhas repetidas e mantém pares", () => {
  assert.equal(collapseRepeats("a\na\na\na\na\nb"), "a  [repeated 5 times]\nb");
  assert.equal(collapseRepeats("x\nx\ny"), "x\nx\ny");
});

test("estimativa de tokens usa cerca de quatro caracteres por token", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});
