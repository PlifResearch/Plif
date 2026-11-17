import { outputText } from "../src/tools/registry.js";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "../src/agent.js";
import { createHookRunner } from "../src/hooks.js";
import { connectMcp } from "../src/mcp.js";
import type { ModelClient } from "../src/model.js";
import { TOOLS } from "../src/tools/index.js";
import type { ToolContext } from "../src/types.js";

const SDK = pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm")).href;

async function echoServerFile(): Promise<string> {
  const file = path.join(await realpath(await mkdtemp(path.join(tmpdir(), "plif-mcp-"))), "echo-server.mjs");
  await writeFile(
    file,
    `import { Server } from "${SDK}/server/index.js";
import { StdioServerTransport } from "${SDK}/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "${SDK}/types.js";
const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "echo", description: "echoes text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "boom", description: "always fails", inputSchema: { type: "object", properties: {} } },
] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "boom") return { content: [{ type: "text", text: "exploded" }], isError: true };
  return { content: [{ type: "text", text: "echo: " + request.params.arguments?.text }] };
});
await server.connect(new StdioServerTransport());
`,
  );
  return file;
}

test("MCP: lista ferramentas com prefixo, exige aprovação e executa quando liberada", async () => {
  const file = await echoServerFile();
  const mcp = await connectMcp({ echo: { command: "node", args: [file], env: {}, allow: ["echo"] } });
  try {
    assert.deepEqual(mcp.errors, []);
    const names = mcp.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["mcp__echo__boom", "mcp__echo__echo"]);

    const echo = mcp.tools.find((tool) => tool.name === "mcp__echo__echo");
    const boom = mcp.tools.find((tool) => tool.name === "mcp__echo__boom");
    if (echo === undefined || boom === undefined) throw new Error("tools missing");
    assert.equal(echo.definition.strict, false);
    const ctx = { root: "/tmp", home: "/tmp", session: "mcp" } as unknown as ToolContext;
    assert.equal((await echo.policy({ text: "hi" }, ctx)).decision, "allow");
    assert.equal((await boom.policy({}, ctx)).decision, "ask_user");
    assert.match(outputText(await echo.run({ text: "hi" }, ctx)), /echo: hi/);
    await assert.rejects(boom.run({}, ctx), /exploded/);
  } finally {
    await mcp.close();
  }
});

test("MCP: servidor que não sobe vira erro legível, sem derrubar a Plif", async () => {
  const mcp = await connectMcp({ broken: { command: "/nonexistent/binary", args: [], env: {}, allow: [] } });
  try {
    assert.equal(mcp.tools.length, 0);
    assert.equal(mcp.errors.length, 1);
    assert.match(mcp.errors[0] ?? "", /MCP server broken/);
  } finally {
    await mcp.close();
  }
});

const shell = (command: string, extra: Record<string, unknown> = {}) => ({
  hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command" as const, command, ...extra }] }] },
});

test("hooks: permitir, pedir, bloquear e estourar o tempo", async () => {
  const allow = createHookRunner([shell(`printf '%s' '{"decision":"allow","reason":"ok"}'`)]);
  const ask = createHookRunner([shell(`printf '%s' '{"decision":"ask","reason":"check it"}'`)]);
  const deny = createHookRunner([shell(`echo "not now" >&2; exit 2`)]);
  const slow = createHookRunner([shell("sleep 3", { timeout: 0.1 })]);
  const pre = (runner: ReturnType<typeof createHookRunner>, name = "Read", cwd = process.cwd()) =>
    runner.fire("PreToolUse", name, { session: "s", cwd }, { tool_name: name, tool_input: {}, tool_use_id: "t1" }).then((outcome) => outcome.permission && { decision: outcome.permission.decision, reason: outcome.permission.reason });

  assert.deepEqual(await pre(allow), { decision: "allow", reason: "ok" });
  assert.deepEqual(await pre(ask), { decision: "ask", reason: "check it" });
  assert.deepEqual(await pre(deny), { decision: "deny", reason: "not now" });
  assert.equal((await pre(slow))?.decision, "deny");
});

test("hooks: o mais restritivo vence e matcher limita o alcance", async () => {
  const both = createHookRunner([
    shell(`printf '%s' '{"decision":"allow"}'`),
    shell(`printf '%s' '{"decision":"ask","reason":"review"}'`),
  ]);
  const pre = (name: string) => both.fire("PreToolUse", name, { session: "s", cwd: process.cwd() }, { tool_name: name }).then((outcome) => outcome.permission);
  assert.equal((await pre("Read"))?.decision, "ask");
  assert.equal(await pre("Bash"), null);
});

test("agente: hook que bloqueia impede a execução e o erro chega ao modelo", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "plif-hook-agent-")));
  const file = path.join(dir, "secret.txt");
  await writeFile(file, "content\n");
  const ctx: ToolContext = {
    root: dir,
    home: path.join(dir, "home"),
    session: "hook",
    sandbox: null,
    mode: { approval: "on-request", readOnly: false },
    readFiles: new Set(),
    approver: { ask: async () => "deny" as const },
    log: { record: async () => {} },
  };
  const replies = [
    { id: "m1", type: "message", role: "assistant", model: "m", stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: file } }] },
    { id: "m2", type: "message", role: "assistant", model: "m", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "done" }] },
  ];
  const model: ModelClient = { create: async () => replies.shift() as unknown as Anthropic.Message };
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "read it" }];
  await runAgent({
    model,
    system: "s",
    tools: TOOLS,
    messages,
    ctx,
    maxTurns: 4,
    hooks: createHookRunner([shell(`echo "reading is off" >&2; exit 2`)]),
  });
  const result = (messages[2]?.content as Array<{ type: string; is_error?: boolean; content: string }>)[0];
  assert.equal(result?.is_error, true);
  assert.match(result?.content ?? "", /hook: reading is off/);
  assert.equal(ctx.readFiles.size, 0, "the file was not read");
});

test("hooks: o comando lê stdin e roda na pasta do projeto", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "plif-hook-cwd-")));
  await writeFile(path.join(dir, "answer.json"), '{"decision":"deny","reason":"project directory"}');
  const runner = createHookRunner([shell("cat >/dev/null; cat answer.json")]);
  const outcome = await runner.fire("PreToolUse", "Read", { session: "s", cwd: dir }, { tool_name: "Read" });
  assert.deepEqual(outcome.permission, { decision: "deny", reason: "project directory", fromUser: false });
});
