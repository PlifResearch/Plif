import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import { BusyStatus, formatElapsed } from "../src/tui/components.js";

test("tempo formatado em segundos, minutos e horas", () => {
  assert.equal(formatElapsed(38_000), "38s");
  assert.equal(formatElapsed(20 * 60_000 + 38_000), "20m 38s");
  assert.equal(formatElapsed(2 * 3_600_000 + 5 * 60_000), "2h 5m");
});

test("turno em andamento mostra tempo, tokens e a dica de parar", () => {
  const { lastFrame, unmount } = render(
    <BusyStatus busy={{ startedAt: Date.now() - 14_000, tokens: 3_200, waiting: false, stoppable: true }} />,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /working · 14s · 3\.2k · esc stops/);
  unmount();
});

test("antes do primeiro evento do modelo, a linha diz que espera a resposta", () => {
  const { lastFrame, unmount } = render(
    <BusyStatus busy={{ startedAt: Date.now() - 6_000, tokens: 0, waiting: true, stoppable: true }} />,
  );
  assert.match(lastFrame() ?? "", /waiting for the model · 6s/);
  unmount();
});

test("a animação gira com o relógio, mesmo sem evento do modelo", async () => {
  const { lastFrame, unmount } = render(
    <BusyStatus busy={{ startedAt: Date.now(), tokens: 0, waiting: true, stoppable: true }} />,
  );
  const spinner = () => (lastFrame() ?? "").trim().charAt(0);
  const first = spinner();
  // Polls rather than sleeping once, so a loaded machine that delays the 250 ms tick still passes.
  const started = Date.now();
  while (spinner() === first && Date.now() - started < 2000) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.notEqual(spinner(), first);
  unmount();
});

test("sem tokens recebidos, a linha não inventa números", () => {
  const { lastFrame, unmount } = render(
    <BusyStatus busy={{ startedAt: Date.now(), tokens: 0, waiting: false, stoppable: false }} />,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /working · 0s/);
  assert.doesNotMatch(frame, /tokens|k ·|esc stops/);
  unmount();
});
