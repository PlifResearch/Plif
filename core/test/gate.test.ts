import assert from "node:assert/strict";
import { test } from "node:test";
import type { Classification, ClassifierInput } from "../src/classifier.js";
import { ClassifierGate } from "../src/gate.js";

const input: ClassifierInput = {
  user_messages: [],
  recent_actions: [],
  pending_action: { tool: "Bash", input: { command: "echo x > a.txt" } },
  model_reason: "",
  project_policy: "",
};

const BLOCK: Classification = { decision: "ask_user", rule: "unclear", reason: "doubt" };
const ALLOW: Classification = { decision: "allow", rule: "clearly_safe", reason: "ok" };

function gateReplying(sequence: Classification[]): { gate: ClassifierGate; calls: () => number } {
  const queue = [...sequence];
  let count = 0;
  const gate = new ClassifierGate(async () => {
    count++;
    return queue.shift() ?? BLOCK;
  });
  return { gate, calls: () => count };
}

test("três bloqueios seguidos pausam a revisão automática", async () => {
  const { gate, calls } = gateReplying([BLOCK, BLOCK, BLOCK]);
  for (let i = 0; i < 3; i++) assert.notEqual(await gate.review(input), null);
  assert.equal(gate.isPaused, true);
  assert.equal(await gate.review(input), null);
  assert.equal(calls(), 3);
});

test("uma liberação zera a sequência de bloqueios", async () => {
  const { gate } = gateReplying([BLOCK, BLOCK, ALLOW, BLOCK, BLOCK]);
  for (let i = 0; i < 5; i++) await gate.review(input);
  assert.equal(gate.isPaused, false);
});

test("erro do classificador conta como bloqueio", async () => {
  const gate = new ClassifierGate(async () => {
    throw new Error("sem rede");
  });
  const verdict = await gate.review(input);
  assert.equal(verdict?.decision, "ask_user");
  assert.match(verdict?.reason ?? "", /unavailable/);
});

test("resume devolve a revisão automática", async () => {
  const { gate } = gateReplying([BLOCK, BLOCK, BLOCK]);
  for (let i = 0; i < 3; i++) await gate.review(input);
  gate.resume();
  assert.equal(gate.isPaused, false);
});
