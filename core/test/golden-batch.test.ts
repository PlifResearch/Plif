import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { test } from "node:test";
import type { ClassifierInput } from "../src/classifier.js";
import { classifyInBatch } from "../src/golden-batch.js";
import type { GoldenCase } from "../src/golden.js";

function input(text: string): ClassifierInput {
  return { user_messages: [text], recent_actions: [], pending_action: { tool: "Bash", input: { command: text } } } as unknown as ClassifierInput;
}

function fakeClient(errorId: string) {
  const created: Array<{ custom_id: string; params: { cache_control?: unknown; model: string } }> = [];
  let polls = 0;
  const client = {
    messages: {
      batches: {
        create: async (body: { requests: typeof created }) => {
          created.push(...body.requests);
          return { id: "msgbatch_test", processing_status: "in_progress" };
        },
        retrieve: async (id: string) => {
          polls++;
          return { id, processing_status: polls < 2 ? "in_progress" : "ended" };
        },
        results: async () =>
          (async function* () {
            for (const request of created) {
              if (request.custom_id === errorId) {
                yield { custom_id: request.custom_id, result: { type: "errored", error: { type: "invalid_request_error" } } };
              } else {
                const message = {
                  stop_reason: "end_turn",
                  content: [{ type: "text", text: JSON.stringify({ decision: "allow", rule: "clearly_safe", reason: "ok" }) }],
                };
                yield { custom_id: request.custom_id, result: { type: "succeeded", message } };
              }
            }
          })(),
      },
    },
  };
  return { client: client as unknown as Anthropic, created, polls: () => polls };
}

test("lote mapeia cada caso pelo custom_id, espera até ended e trata erro por caso", async () => {
  const cases: GoldenCase[] = [
    { id: "gl-01", critical: false, note: "a", input: input("a") } as unknown as GoldenCase,
    { id: "gl-02", critical: false, note: "b", input: input("b") } as unknown as GoldenCase,
  ];
  const { client, created, polls } = fakeClient("gl-02");
  const submitted: string[] = [];
  const byCase = await classifyInBatch(client, cases, "system", {
    pollMs: 1,
    wait: async () => {},
    onSubmitted: (id) => submitted.push(id),
  });
  assert.deepEqual(submitted, ["msgbatch_test"]);
  assert.equal(polls(), 2);
  assert.deepEqual(created.map((request) => request.custom_id), ["gl-01", "gl-02"]);
  assert.ok(created[0]?.params.cache_control, "cache_control vai em cada requisição do lote");
  assert.equal(byCase.get(cases[0]!.input)?.decision, "allow");
  assert.equal(byCase.get(cases[1]!.input)?.rule, "unclear");
});

test("custom_id fora do formato do lote é recusado antes de enviar", async () => {
  const { client, created } = fakeClient("x");
  const cases = [{ id: "bad id!", critical: false, note: "", input: input("a") } as unknown as GoldenCase];
  await assert.rejects(classifyInBatch(client, cases, "system"), /custom_id invalid/);
  assert.equal(created.length, 0);
});
