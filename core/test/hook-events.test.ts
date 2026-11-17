import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent, STOP_HOOK_CAP } from "../src/agent.js";
import { ApiFailure } from "../src/api-retry.js";
import { createHookRunner, type HookEvent, loadSettings, matches } from "../src/hooks.js";
import type { ModelClient } from "../src/model.js";
import { TOOLS } from "../src/tools/index.js";
import type { ToolContext } from "../src/types.js";

function settings(event: HookEvent, command: string, matcher?: string) {
  return { hooks: { [event]: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command }] }] } };
}

async function tempDir(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), "plif-hook-events-")));
}

function context(dir: string, approve: () => Promise<"deny" | "once"> = async () => "deny"): ToolContext {
  return {
    root: dir,
    home: path.join(dir, "home"),
    session: "events",
    sandbox: null,
    mode: { approval: "on-request", readOnly: false },
    readFiles: new Set(),
    approver: { ask: approve },
    log: { record: async () => {} },
  };
}

function reply(content: unknown[], stop: string = "end_turn"): Anthropic.Message {
  return { id: "m", type: "message", role: "assistant", model: "m", stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content } as unknown as Anthropic.Message;
}

function scripted(replies: Anthropic.Message[]): ModelClient & { readonly seen: Anthropic.MessageParam[][] } {
  const seen: Anthropic.MessageParam[][] = [];
  return {
    seen,
    create: async (params) => {
      seen.push(structuredClone(params.messages));
      const next = replies.shift();
      if (next === undefined) throw new Error("no scripted reply left");
      return next;
    },
  };
}

const readCall = (file: string, id = "t1") => reply([{ type: "tool_use", id, name: "Read", input: { file_path: file } }], "tool_use");
const done = (text = "done") => reply([{ type: "text", text }]);

function resultText(message: Anthropic.MessageParam | undefined): string {
  const block = (message?.content as Anthropic.ToolResultBlockParam[] | undefined)?.[0];
  if (block === undefined) return "";
  if (typeof block.content === "string") return block.content;
  return (block.content ?? []).map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
}

test("matcher: lista exata com | ou vírgula, expressão regular sem âncora e eventos sem matcher", () => {
  assert.equal(matches("Edit|Write", "Write"), true);
  assert.equal(matches("Edit, Write", "Write"), true);
  assert.equal(matches("Edit|Write", "WebFetch"), false);
  assert.equal(matches("Edit", "NotebookEdit"), false);
  assert.equal(matches("Edit.*", "NotebookEdit"), true);
  assert.equal(matches("^Edit$", "NotebookEdit"), false);
  assert.equal(matches("mcp__memory__.*", "mcp__memory__save"), true);
  assert.equal(matches(undefined, "anything"), true);
  assert.equal(matches("Bash", "x", "Stop"), true, "Stop ignores the matcher, as in Claude Code");
  assert.equal(matches("[", "x"), false, "an invalid regular expression matches nothing");
});

test("settings do Claude Code carregam: eventos e tipos desconhecidos viram aviso, não erro", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "settings.json");
  await writeFile(
    file,
    JSON.stringify({
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        Setup: [{ hooks: [{ type: "command", command: "true" }] }],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "http", url: "https://example.com" }, { type: "command", command: "true", if: "Bash(git *)", timeout: 5 }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "true" }] }],
      },
    }),
  );
  const loaded = await loadSettings(file);
  assert.equal(loaded.warnings.length, 3);
  assert.match(loaded.warnings.join("\n"), /Setup is not supported/);
  assert.match(loaded.warnings.join("\n"), /type http was skipped/);
  assert.match(loaded.warnings.join("\n"), /"if" filter/);
  const runner = createHookRunner([loaded]);
  assert.equal(runner.count, 2);
  assert.equal(runner.has("Stop"), true);
  assert.equal(runner.has("SessionStart"), false);
});

test("PreToolUse: hookSpecificOutput, nomes antigos, campos comuns no stdin e timeout em segundos", async () => {
  const dir = await tempDir();
  const payload = path.join(dir, "payload.json");
  const deny = createHookRunner([
    settings("PreToolUse", `cat > ${payload}; printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no reads"}}'`),
  ]);
  const base = { session: "s1", cwd: dir, transcriptPath: "/t.jsonl", permissionMode: "auto", agentId: "3", agentType: "explore" };
  const outcome = await deny.fire("PreToolUse", "Read", base, { tool_name: "Read", tool_input: { file_path: "/x" }, tool_use_id: "t9" });
  assert.deepEqual(outcome.permission, { decision: "deny", reason: "no reads", fromUser: false });
  const seen = JSON.parse(await readFile(payload, "utf8")) as Record<string, unknown>;
  assert.deepEqual(
    { ...seen },
    {
      session_id: "s1",
      transcript_path: "/t.jsonl",
      cwd: dir,
      permission_mode: "auto",
      hook_event_name: "PreToolUse",
      agent_id: "3",
      agent_type: "explore",
      tool_name: "Read",
      tool_input: { file_path: "/x" },
      tool_use_id: "t9",
    },
  );

  const legacy = createHookRunner([settings("PreToolUse", `printf '%s' '{"decision":"block","reason":"old style"}'`)]);
  assert.deepEqual((await legacy.fire("PreToolUse", "Read", base, {})).permission, { decision: "deny", reason: "old style", fromUser: false });

  const slow = createHookRunner([{ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "sleep 2", timeout: 0.2 }] }] } }]);
  const started = Date.now();
  assert.equal((await slow.fire("PreToolUse", "Read", base, {})).permission?.decision, "deny");
  assert.ok(Date.now() - started < 1500, "0.2 is seconds, not milliseconds");
});

test("PreToolUse: updatedInput passa de novo pela validação e pela política", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "asked.txt"), "asked\n");
  await writeFile(path.join(dir, "real.txt"), "real content\n");
  const rewrite = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { file_path: path.join(dir, "real.txt") } } });
  const model = scripted([readCall(path.join(dir, "asked.txt")), done()]);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "read it" }];
  await runAgent({ model, system: "s", tools: TOOLS, messages, ctx: context(dir), maxTurns: 4, hooks: createHookRunner([settings("PreToolUse", `printf '%s' '${rewrite}'`, "Read")]) });
  assert.match(resultText(messages[2]), /real content/);

  const outside = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { file_path: "/etc/hostname" } } });
  const second = scripted([readCall(path.join(dir, "asked.txt")), done()]);
  const log: Anthropic.MessageParam[] = [{ role: "user", content: "read it" }];
  await runAgent({ model: second, system: "s", tools: TOOLS, messages: log, ctx: context(dir), maxTurns: 4, hooks: createHookRunner([settings("PreToolUse", `printf '%s' '${outside}'`, "Read")]) });
  assert.match(resultText(log[2]), /did not approve|blocked/, "a path outside the project still asks, and the approver said no");
});

test("PreToolUse allow: hook do usuário aprova sozinho; hook do projeto não libera", async () => {
  const dir = await tempDir();
  const elsewhere = await tempDir();
  await writeFile(path.join(elsewhere, "note.txt"), "outside the project\n");
  const allow = `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'`;
  const run = async (source: "user" | "project") => {
    let asked = 0;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "read" }];
    await runAgent({
      model: scripted([readCall(path.join(elsewhere, "note.txt")), done()]),
      system: "s",
      tools: TOOLS,
      messages,
      ctx: context(dir, async () => {
        asked++;
        return "deny";
      }),
      maxTurns: 4,
      hooks: createHookRunner([{ settings: settings("PreToolUse", allow), warnings: [], source }]),
    });
    return { asked, result: resultText(messages[2]) };
  };
  const user = await run("user");
  assert.equal(user.asked, 0);
  assert.match(user.result, /outside the project/);
  const project = await run("project");
  assert.equal(project.asked, 1);
  assert.match(project.result, /did not approve/);
});

test("PreToolUse allow de hook do usuário não libera ação negada pela política", async () => {
  const dir = await tempDir();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "run" }];
  await runAgent({
    model: scripted([reply([{ type: "tool_use", id: "b1", name: "Bash", input: { command: "rm -rf /", description: "wipe" } }], "tool_use"), done()]),
    system: "s",
    tools: TOOLS,
    messages,
    ctx: context(dir),
    maxTurns: 4,
    hooks: createHookRunner([settings("PreToolUse", `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'`)]),
  });
  assert.match(resultText(messages[2]), /blocked \(level 0\)/);
});

test("PermissionRequest: deny recusa sem perguntar; allow do usuário aprova; allow do projeto só avisa", async () => {
  const dir = await tempDir();
  const elsewhere = await tempDir();
  await writeFile(path.join(elsewhere, "note.txt"), "outside\n");
  let asked = 0;
  const approve = async () => {
    asked++;
    return "deny" as const;
  };
  const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no reads outside" } } });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "read" }];
  await runAgent({ model: scripted([readCall(path.join(elsewhere, "note.txt")), done()]), system: "s", tools: TOOLS, messages, ctx: context(dir, approve), maxTurns: 4, hooks: createHookRunner([settings("PermissionRequest", `printf '%s' '${deny}'`, "Read")]) });
  assert.equal(asked, 0);
  assert.match(resultText(messages[2]), /refused by a PermissionRequest hook: no reads outside/);

  const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  const approvedLog: Anthropic.MessageParam[] = [{ role: "user", content: "read" }];
  await runAgent({ model: scripted([readCall(path.join(elsewhere, "note.txt")), done()]), system: "s", tools: TOOLS, messages: approvedLog, ctx: context(dir, approve), maxTurns: 4, hooks: createHookRunner([settings("PermissionRequest", `printf '%s' '${allow}'`)]) });
  assert.equal(asked, 0);
  assert.match(resultText(approvedLog[2]), /outside/);

  const notices: string[] = [];
  await runAgent({
    model: scripted([readCall(path.join(elsewhere, "note.txt")), done()]),
    system: "s",
    tools: TOOLS,
    messages: [{ role: "user", content: "read" }],
    ctx: context(dir, approve),
    maxTurns: 4,
    hooks: createHookRunner([{ settings: settings("PermissionRequest", `printf '%s' '${allow}'`), warnings: [], source: "project" }]),
    events: { onNotice: (text) => notices.push(text) },
  });
  assert.equal(asked, 1, "a project hook does not release the action");
  assert.match(notices.join("\n"), /only hooks in ~\/\.plif\/settings\.json release actions/);
});

test("PostToolUse e PostToolUseFailure: contexto e feedback chegam junto do resultado", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "a.txt"), "alpha\n");
  const failurePayload = path.join(dir, "failure.json");
  const hooks = createHookRunner([
    settings("PostToolUse", `printf '%s' '{"decision":"block","reason":"lint found 2 problems","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"file is generated"}}'`, "Read"),
    settings("PostToolUseFailure", `cat > ${failurePayload}; printf '%s' '{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"try Glob first"}}'`),
  ]);
  const model = scripted([readCall(path.join(dir, "a.txt")), readCall(path.join(dir, "missing.txt"), "t2"), done()]);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "read" }];
  await runAgent({ model, system: "s", tools: TOOLS, messages, ctx: context(dir), maxTurns: 5, hooks });
  const ok = resultText(messages[2]);
  assert.match(ok, /alpha/);
  assert.match(ok, /<hook_context event="PostToolUse">[\s\S]*lint found 2 problems[\s\S]*file is generated/);
  const failed = resultText(messages[4]);
  assert.match(failed, /try Glob first/);
  const seen = JSON.parse(await readFile(failurePayload, "utf8")) as { error: string; tool_name: string };
  assert.equal(seen.tool_name, "Read");
  assert.notEqual(seen.error, "");
});

test("continue: false para o turno sem rodar a ferramenta", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, "a.txt"), "alpha\n");
  const notices: string[] = [];
  const ctx = context(dir);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "read" }];
  const answer = await runAgent({
    model: scripted([readCall(path.join(dir, "a.txt"))]),
    system: "s",
    tools: TOOLS,
    messages,
    ctx,
    maxTurns: 4,
    hooks: createHookRunner([settings("PreToolUse", `printf '%s' '{"continue":false,"stopReason":"budget reached"}'`)]),
    events: { onNotice: (text) => notices.push(text) },
  });
  assert.equal(answer, "");
  assert.equal(ctx.readFiles.size, 0);
  assert.match(notices.join("\n"), /budget reached/);
});

test("Stop: exit 2 manda o motivo ao modelo e o turno continua, com stop_hook_active na volta", async () => {
  const dir = await tempDir();
  const flag = path.join(dir, "flag");
  // First stop: block. Second stop: stop_hook_active is true, so the hook lets it end.
  const command = `input=$(cat); case "$input" in *'"stop_hook_active":true'*) exit 0;; esac; echo "run the tests before finishing" >&2; touch ${flag}; exit 2`;
  const model = scripted([done("first"), done("second")]);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "work" }];
  const answer = await runAgent({ model, system: "s", tools: TOOLS, messages, ctx: context(dir), maxTurns: 5, hooks: createHookRunner([settings("Stop", command)]) });
  assert.equal(answer, "second");
  const feedback = model.seen[1]?.at(-1);
  assert.match(JSON.stringify(feedback), /hook_feedback event=\\"Stop\\"[\s\S]*run the tests before finishing/);
});

test(`Stop: depois de ${STOP_HOOK_CAP} continuações seguidas a Plif encerra o turno`, async () => {
  const dir = await tempDir();
  const replies = Array.from({ length: STOP_HOOK_CAP + 1 }, (_, index) => done(`try ${index}`));
  const notices: string[] = [];
  const answer = await runAgent({
    model: scripted(replies),
    system: "s",
    tools: TOOLS,
    messages: [{ role: "user", content: "work" }],
    ctx: context(dir),
    maxTurns: 20,
    hooks: createHookRunner([settings("Stop", `printf '%s' '{"decision":"block","reason":"never satisfied"}'`)]),
    events: { onNotice: (text) => notices.push(text) },
  });
  assert.equal(answer, `try ${STOP_HOOK_CAP}`);
  assert.match(notices.join("\n"), new RegExp(`${STOP_HOOK_CAP} times in a row`));
});

test("subagente dispara SubagentStop com o tipo no matcher, e não Stop", async () => {
  const dir = await tempDir();
  const stopFile = path.join(dir, "stop");
  const subFile = path.join(dir, "sub.json");
  const hooks = createHookRunner([settings("Stop", `touch ${stopFile}`), settings("SubagentStop", `cat > ${subFile}`, "explore")]);
  await runAgent({
    model: scripted([done("report")]),
    system: "s",
    tools: TOOLS,
    messages: [{ role: "user", content: "look" }],
    ctx: context(dir),
    maxTurns: 3,
    hooks,
    hookInfo: { agentId: "2", agentType: "explore" },
  });
  const seen = JSON.parse(await readFile(subFile, "utf8")) as Record<string, unknown>;
  assert.equal(seen["hook_event_name"], "SubagentStop");
  assert.equal(seen["agent_type"], "explore");
  assert.equal(seen["last_assistant_message"], "report");
  await assert.rejects(readFile(stopFile), "Stop must not run for a subagent");
});

test("PreCompact: stdout vira instrução do resumo, e PostCompact recebe o resumo", async () => {
  const dir = await tempDir();
  const post = path.join(dir, "post.json");
  const history: Anthropic.MessageParam[] = [];
  for (let index = 0; index < 6; index++) {
    history.push({ role: "user", content: `question ${index} ${"x".repeat(200)}` });
    history.push({ role: "assistant", content: [{ type: "text", text: `answer ${index}` }] });
  }
  history.push({ role: "user", content: "last question" });
  let received: string | undefined;
  await runAgent({
    model: scripted([done()]),
    system: "s",
    tools: TOOLS,
    messages: history,
    ctx: context(dir),
    maxTurns: 2,
    compactAt: 10,
    summarize: async (_messages, _options, instructions) => {
      received = instructions;
      return "the summary";
    },
    hooks: createHookRunner([settings("PreCompact", "echo keep every file path", "auto"), settings("PostCompact", `cat > ${post}`)]),
  });
  assert.equal(received, "keep every file path");
  const seen = JSON.parse(await readFile(post, "utf8")) as Record<string, unknown>;
  assert.equal(seen["trigger"], "auto");
  assert.equal(seen["compact_summary"], "the summary");
});

test("PreCompact com exit 2 impede a compactação", async () => {
  const dir = await tempDir();
  const history: Anthropic.MessageParam[] = [];
  for (let index = 0; index < 6; index++) {
    history.push({ role: "user", content: `question ${index}` });
    history.push({ role: "assistant", content: [{ type: "text", text: `answer ${index}` }] });
  }
  history.push({ role: "user", content: "last" });
  let summarized = false;
  await runAgent({
    model: scripted([done()]),
    system: "s",
    tools: TOOLS,
    messages: history,
    ctx: context(dir),
    maxTurns: 2,
    compactAt: 10,
    summarize: async () => {
      summarized = true;
      return "x";
    },
    hooks: createHookRunner([settings("PreCompact", "echo 'not now' >&2; exit 2")]),
  });
  assert.equal(summarized, false);
});

test("StopFailure recebe o tipo do erro da API e o erro continua chegando a quem chamou", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "failure.json");
  const model: ModelClient = {
    create: async () => {
      throw new ApiFailure("rate_limit", "429 Too Many Requests");
    },
  };
  await assert.rejects(
    runAgent({ model, system: "s", tools: TOOLS, messages: [{ role: "user", content: "x" }], ctx: context(dir), maxTurns: 2, hooks: createHookRunner([settings("StopFailure", `cat > ${file}`, "rate_limit")]) }),
    /429/,
  );
  const seen = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  assert.equal(seen["error"], "rate_limit");
});

test("UserPromptSubmit e SessionStart: stdout simples vira contexto; exit 2 bloqueia o prompt", async () => {
  const dir = await tempDir();
  const base = { session: "s", cwd: dir };
  const context = createHookRunner([settings("UserPromptSubmit", "echo branch: main"), settings("SessionStart", "echo 'ticket ABC-1'", "startup|resume")]);
  assert.deepEqual((await context.fire("UserPromptSubmit", "", base, { prompt: "hi" })).context, ["branch: main"]);
  assert.deepEqual((await context.fire("SessionStart", "resume", base, { source: "resume" })).context, ["ticket ABC-1"]);
  assert.equal((await context.fire("SessionStart", "clear", base, { source: "clear" })).ran, 0);

  const block = createHookRunner([settings("UserPromptSubmit", `printf '%s' '{"decision":"block","reason":"contains a secret"}'`)]);
  assert.equal((await block.fire("UserPromptSubmit", "", base, { prompt: "sk-..." })).block, "contains a secret");
  const failing = createHookRunner([settings("SessionEnd", "exit 1")]);
  const ended = await failing.fire("SessionEnd", "clear", base, { reason: "clear" });
  assert.equal(ended.block, null);
  assert.match(ended.messages.join("\n"), /failed with exit 1/);
});
