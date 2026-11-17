import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import { fitColumns, Markdown } from "../src/tui/markdown.js";
import { highlightLines, languageFor } from "../src/tui/syntax.js";

function frame(text: string, width?: number): string {
  const { lastFrame, unmount } = render(<Markdown text={text} width={width} />);
  const out = lastFrame() ?? "";
  unmount();
  return out;
}

test("Markdown: títulos, ênfase, tachado, código inline, links e imagens", () => {
  const out = frame("# Plan\n\n**bold**, *it*, ~~old~~, `code`, [docs](https://example.com), <https://auto.example> and snake_case_name\n\n![logo](https://x.example/logo.png)");
  assert.match(out, /Plan/);
  assert.match(out, /bold, it, old, code, docs \(https:\/\/example\.com\), https:\/\/auto\.example and snake_case_name/);
  assert.doesNotMatch(out, /\*\*|~~|`/);
  assert.match(out, /\[image: logo\] https:\/\/x\.example\/logo\.png/);
});

test("Markdown: listas aninhadas, numeradas a partir de outro número e listas de tarefa", () => {
  const out = frame("- one\n  - inner\n    - deeper\n- two\n\n3. third\n4. fourth\n\n- [x] done\n- [ ] todo");
  const lines = out.split("\n").map((line) => line.trimEnd());
  assert.ok(lines.some((line) => /^[•-] one$/.test(line)));
  assert.ok(lines.some((line) => /^ {2}[◦*] inner$/.test(line)));
  assert.ok(lines.some((line) => /^ {4}[▪+] deeper$/.test(line)));
  assert.ok(lines.includes("3. third"));
  assert.ok(lines.includes("4. fourth"));
  assert.ok(lines.includes("[x] done"));
  assert.ok(lines.includes("[ ] todo"));
});

test("Markdown: tabela GFM com alinhamento e corte quando não cabe", () => {
  const out = frame("| name | qty | note |\n|:-----|----:|:----:|\n| apple | 3 | ok |\n| kiwi | 12 | fresh |");
  const lines = out.split("\n").map((line) => line.trimEnd());
  assert.match(lines[0] ?? "", /^name\s+[│|] qty [│|]\s+note$/);
  assert.match(lines[1] ?? "", /^[─-]+[┼+][─-]+/);
  assert.match(lines[2] ?? "", /^apple [│|]\s+3 [│|]/);
  assert.match(lines[3] ?? "", /^kiwi\s+[│|]  12 [│|] fresh$/);
  assert.deepEqual(fitColumns([40, 10, 5], 30), [15, 10, 5]);
});

test("Markdown: citação, regra, HTML e bloco de código com rótulo da linguagem", () => {
  const out = frame("> quoted *text*\n\n---\n\n<details>raw</details>\n\n```ts\nconst a = 1;\n```");
  assert.match(out, /[▎|] quoted text/);
  assert.match(out, /[─-]{3,}/);
  assert.match(out, /<details>raw<\/details>/);
  assert.match(out, /ts\n[│|] const a = 1;/);
});

test("realce: palavras-chave, strings, funções e variáveis recebem cores diferentes", () => {
  const [line] = highlightLines('const total = add(1, "a");', "typescript", "dark");
  const colorOf = (text: string) => line?.find((segment) => segment.text === text)?.color;
  assert.ok(colorOf("const") !== undefined);
  assert.ok(colorOf("total") !== undefined, "identifiers get the variable colour");
  assert.ok(colorOf('"a"') !== undefined);
  assert.notEqual(colorOf("const"), colorOf("total"));
  assert.notEqual(colorOf("add"), colorOf("total"));
  assert.notEqual(colorOf('"a"'), colorOf("const"));
  assert.equal(highlightLines("a\nb", null).length, 2);
});

test("realce: linguagem pelo rótulo da cerca ou pelo nome do arquivo", () => {
  assert.equal(languageFor("ts"), "ts");
  assert.equal(languageFor("src/app.tsx"), "tsx");
  assert.equal(languageFor("scripts/run.py"), "py");
  assert.equal(languageFor("Makefile"), "makefile");
  assert.equal(languageFor("notes.unknownext"), null);
  assert.equal(languageFor(""), null);
});
