import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectMcp, expandVariables, loadMcpFile, mcpOutput, schemaFor, toolNameFor } from "../src/mcp.js";
import { outputText } from "../src/tools/registry.js";
import type { ToolContext } from "../src/types.js";

const SDK = pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm")).href;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const ctx = { root: "/tmp", home: "/tmp", session: "mcp" } as unknown as ToolContext;

async function temp(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), "plif-mcp-compat-")));
}

// A server with the shapes that broke the old client: dotted names, bad schemas, images, pages and a changing list.
async function messyServer(): Promise<string> {
  const file = path.join(await temp(), "messy.mjs");
  await writeFile(
    file,
    `import { Server } from "${SDK}/server/index.js";
import { StdioServerTransport } from "${SDK}/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "${SDK}/types.js";
const object = { type: "object", properties: {} };
const tools = [
  { name: "files.read", description: "dotted name", inputSchema: object },
  { name: "bad", description: "string schema", inputSchema: { type: "string" } },
  { name: "union", description: "top-level anyOf", inputSchema: { anyOf: [object] } },
  { name: "pic", description: "returns an image", inputSchema: object },
  { name: "structured", description: "structured only", inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", properties: {} } },
  { name: "secret", description: "reads the token", inputSchema: object },
  { name: "grow", description: "adds a tool", inputSchema: object },
];
const server = new Server({ name: "messy", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
server.setRequestHandler(ListToolsRequestSchema, async (request) =>
  request.params?.cursor === "p2" ? { tools: tools.slice(3) } : { tools: tools.slice(0, 3), nextCursor: "p2" });
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  if (name === "pic") return { content: [{ type: "text", text: "a pixel" }, { type: "image", data: "${PNG}", mimeType: "image/png" }] };
  if (name === "structured") return { content: [], structuredContent: { total: 3 } };
  if (name === "secret") return { content: [{ type: "text", text: "token=" + process.env.PLIF_MCP_TOKEN }] };
  if (name === "grow") {
    tools.push({ name: "late", description: "added later", inputSchema: object });
    await server.sendToolListChanged();
    return { content: [{ type: "text", text: "grown" }] };
  }
  return { content: [{ type: "text", text: "read ok" }] };
});
await server.connect(new StdioServerTransport());
`,
  );
  return file;
}

test("MCP: nomes com ponto viram nomes aceitos, schemas inválidos saem com aviso e as páginas são lidas", async () => {
  process.env["PLIF_MCP_SECRET"] = "s3cret";
  const mcp = await connectMcp({ messy: { command: "node", args: [await messyServer()], env: { PLIF_MCP_TOKEN: "$PLIF_MCP_SECRET" }, allow: [] } });
  try {
    const names = mcp.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["mcp__messy__files_read", "mcp__messy__grow", "mcp__messy__pic", "mcp__messy__secret", "mcp__messy__structured"]);
    assert.ok(names.every((name) => /^[a-zA-Z0-9_-]{1,64}$/.test(name)));
    assert.equal(mcp.errors.length, 2);
    assert.match(mcp.errors.join("\n"), /tool bad was left out because the input schema has type "string"/);
    assert.match(mcp.errors.join("\n"), /tool union was left out because the input schema uses anyOf/);

    const byName = (name: string) => {
      const found = mcp.tools.find((tool) => tool.name === name);
      if (found === undefined) throw new Error(`${name} missing`);
      return found;
    };
    assert.match(byName("mcp__messy__files_read").definition.description ?? "", /MCP tool "files.read"/);
    assert.match(outputText(await byName("mcp__messy__files_read").run({}, ctx)), /read ok/);
    assert.equal((byName("mcp__messy__structured").definition.input_schema as Record<string, unknown>)["$schema"], undefined);
    assert.match(outputText(await byName("mcp__messy__structured").run({}, ctx)), /total/);
    assert.match(outputText(await byName("mcp__messy__secret").run({}, ctx)), /token=s3cret/);

    const picture = await byName("mcp__messy__pic").run({}, ctx);
    assert.ok(Array.isArray(picture));
    assert.equal(picture[1]?.type, "image");

    await byName("mcp__messy__grow").run({}, ctx);
    const started = Date.now();
    while (!mcp.tools.some((tool) => tool.name === "mcp__messy__late")) {
      if (Date.now() - started > 3000) throw new Error("the new tool did not arrive");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await mcp.close();
    delete process.env["PLIF_MCP_SECRET"];
  }
});

test("MCP: variável ausente, configuração inválida e stderr do servidor viram erros legíveis", async () => {
  const dir = await temp();
  const crash = path.join(dir, "crash.mjs");
  await writeFile(crash, `console.error("missing API key: set FOO_KEY"); process.exit(1);\n`);
  const mcp = await connectMcp({
    needs: { command: "node", args: [crash], env: { KEY: "$PLIF_NOT_SET_ANYWHERE" } },
    wrong: { command: "" },
    crash: { command: "node", args: [crash] },
  });
  try {
    assert.equal(mcp.tools.length, 0);
    const text = mcp.errors.join("\n");
    assert.match(text, /needs: set PLIF_NOT_SET_ANYWHERE in the environment/);
    assert.match(text, /wrong: invalid configuration/);
    assert.match(text, /crash: [\s\S]*server stderr:\nmissing API key: set FOO_KEY/);
  } finally {
    await mcp.close();
  }
});

test("MCP remoto (Streamable HTTP): cabeçalho com variável autentica; sem ele, o erro explica como", async () => {
  const httpServer = http.createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer t0ken") {
      response.writeHead(401).end("unauthorized");
      return;
    }
    const server = new Server({ name: "remote", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", description: "pong", inputSchema: { type: "object", properties: {} } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "pong" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(httpServer.address() as net.AddressInfo).port}/mcp`;
  process.env["PLIF_REMOTE_TOKEN"] = "t0ken";
  const good = await connectMcp({ remote: { type: "http", url, headers: { Authorization: "Bearer ${PLIF_REMOTE_TOKEN}" }, allow: ["ping"] } });
  const bad = await connectMcp({ remote: { type: "http", url } });
  try {
    assert.deepEqual(good.errors, []);
    const ping = good.tools.find((tool) => tool.name === "mcp__remote__ping");
    assert.ok(ping !== undefined);
    assert.match(outputText(await ping.run({}, ctx)), /pong/);
    assert.equal(bad.tools.length, 0);
    assert.match(bad.errors.join("\n"), /asks for authorization: put the token in "headers"/);
  } finally {
    await good.close();
    await bad.close();
    httpServer.closeAllConnections();
    httpServer.close();
    delete process.env["PLIF_REMOTE_TOKEN"];
  }
});

test("mcp.json: lê mcpServers (formato dos READMEs) e servers (formato da Plif)", async () => {
  const file = path.join(await temp(), "mcp.json");
  await writeFile(file, JSON.stringify({ mcpServers: { a: { command: "x" } }, servers: { b: { command: "y" } } }));
  assert.deepEqual(Object.keys(await loadMcpFile(file)).sort(), ["a", "b"]);
});

test("nomes, schemas, variáveis e saídas: casos de borda", () => {
  const taken = new Set<string>();
  const long = toolNameFor("server", "x".repeat(100), taken);
  assert.ok(long.length <= 64);
  taken.add(long);
  const twin = toolNameFor("server", "x".repeat(100) + "y", taken);
  assert.notEqual(twin, long);
  assert.equal(toolNameFor("my server", "do.it", new Set()), "mcp__my_server__do_it");

  assert.deepEqual(schemaFor({}), { type: "object" });
  assert.equal(typeof schemaFor(null), "string");

  const missing: string[] = [];
  assert.equal(expandVariables("Bearer ${A}-${B}", { A: "1" }, missing), "Bearer 1-");
  assert.deepEqual(missing, ["B"]);

  assert.throws(() => mcpOutput({ content: [{ type: "text", text: "nope" }], isError: true }), /nope/);
  assert.match(String(mcpOutput({ content: [{ type: "resource_link", name: "doc", uri: "file:///a" }] })), /resource link: doc file:\/\/\/a/);
});
