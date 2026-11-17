import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { render } from "ink-testing-library";
import React from "react";
import type { ModelClient } from "../src/model.js";
import { buildRuntime, type Runtime } from "../src/runtime.js";
import { App } from "../src/tui/App.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

// Generous: the full suite runs many files at once, and these tests start the whole interface.
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("tempo esgotado esperando a interface");
    await settle();
  }
}

async function runtimeWith(hooks: Record<string, unknown>, model: ModelClient): Promise<{ runtime: Runtime; base: string }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-hooks-tui-")));
  const project = path.join(base, "projeto");
  await mkdir(project);
  await mkdir(path.join(base, ".plif"));
  await writeFile(path.join(base, ".plif", "settings.json"), JSON.stringify({ hooks }));
  return { runtime: await buildRuntime(project, path.join(base, ".plif"), model), base };
}

const command = (text: string, matcher?: string) => [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command: text }] }];

function recordingModel(): ModelClient & { readonly requests: Anthropic.MessageParam[][] } {
  const requests: Anthropic.MessageParam[][] = [];
  return {
    requests,
    async create(params) {
      requests.push(structuredClone(params.messages));
      return { id: "m", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Message;
    },
  };
}

test("UserPromptSubmit com exit 2 bloqueia o prompt antes do modelo", async () => {
  const model = recordingModel();
  const { runtime } = await runtimeWith({ UserPromptSubmit: command(`echo "no secrets in prompts" >&2; exit 2`) }, model);
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  try {
    stdin.write("my token is abc");
    stdin.write("\r");
    await waitFor(() => /prompt blocked by a hook: no secrets in prompts/.test(lastFrame() ?? ""));
    assert.equal(model.requests.length, 0);
  } finally {
    unmount();
    await runtime.dispose();
  }
});

test("SessionStart e UserPromptSubmit: o contexto dos hooks chega ao modelo junto do prompt", async () => {
  const model = recordingModel();
  const { runtime } = await runtimeWith(
    { SessionStart: command("echo 'current ticket: ABC-12'", "startup"), UserPromptSubmit: command("echo 'branch: main'") },
    model,
  );
  const { stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  try {
    stdin.write("oi");
    stdin.write("\r");
    await waitFor(() => model.requests.length > 0);
    const first = JSON.stringify(model.requests[0]?.[0]);
    assert.match(first, /oi/);
    assert.match(first, /hook_context event=\\"SessionStart\\"[\s\S]*current ticket: ABC-12/);
    assert.match(first, /hook_context event=\\"UserPromptSubmit\\"[\s\S]*branch: main/);
  } finally {
    unmount();
    await runtime.dispose();
  }
});

test("/clear dispara SessionEnd da sessão antiga e SessionStart com source clear na nova", async () => {
  const model = recordingModel();
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "plif-hooks-clear-")));
  const ended = path.join(base, "ended.json");
  const started = path.join(base, "started.log");
  const { runtime } = await runtimeWith(
    { SessionEnd: command(`cat > ${ended}`, "clear"), SessionStart: command(`cat >> ${started}; echo >> ${started}`) },
    model,
  );
  const { lastFrame, stdin, unmount } = render(<App runtime={runtime} trusted={true} />);
  try {
    stdin.write("first");
    stdin.write("\r");
    await waitFor(() => model.requests.length === 1);
    await settle();
    await waitFor(() => /ok/.test(lastFrame() ?? ""));
    stdin.write("/clear");
    await waitFor(() => /clear/.test(lastFrame() ?? ""));
    await settle();
    stdin.write("\r");
    await waitFor(async () => (await readFile(ended, "utf8").catch(() => "")) !== "");
    const end = JSON.parse(await readFile(ended, "utf8")) as Record<string, unknown>;
    assert.equal(end["reason"], "clear");
    assert.match(String(end["transcript_path"]), /transcript\.jsonl$/);
    stdin.write("second");
    stdin.write("\r");
    await waitFor(() => model.requests.length === 2);
    await waitFor(async () => (await readFile(started, "utf8")).split("\n").filter((line) => line.trim() !== "").length === 2);
    const sources = (await readFile(started, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => (JSON.parse(line) as { source: string; session_id: string }));
    assert.deepEqual(sources.map((entry) => entry.source), ["startup", "clear"]);
    assert.notEqual(sources[0]?.session_id, sources[1]?.session_id);
    assert.equal(sources[0]?.session_id, end["session_id"]);
  } finally {
    unmount();
    await runtime.dispose();
  }
});
