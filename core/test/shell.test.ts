import assert from "node:assert/strict";
import { test } from "node:test";
import { parseShell } from "../src/shell.js";

test("separa comandos encadeados e respeita aspas", () => {
  const segments = parseShell('echo "a;b" && ls | wc -l');
  assert.deepEqual(
    segments?.map((segment) => segment.argv),
    [["echo", "a;b"], ["ls"], ["wc", "-l"]],
  );
});

test("guarda o alvo do redirecionamento separado dos argumentos", () => {
  assert.deepEqual(parseShell("echo oi > saida.txt"), [{ argv: ["echo", "oi"], redirects: ["saida.txt"] }]);
});

test("ignora o descritor numérico antes do redirecionamento", () => {
  assert.deepEqual(parseShell("ls 2> erros.log"), [{ argv: ["ls"], redirects: ["erros.log"] }]);
});

test("recusa substituição de comando e aspas abertas", () => {
  assert.equal(parseShell("echo $(whoami)"), null);
  assert.equal(parseShell("echo `whoami`"), null);
  assert.equal(parseShell("echo 'aberto"), null);
});

test("recusa redirecionamento sem alvo", () => {
  assert.equal(parseShell("echo >"), null);
});
