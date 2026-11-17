import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { checkImage, imageBlock } from "./media.js";
import { limitOutput } from "./output.js";
import type { RegisteredTool, ToolBlocks, ToolOutput } from "./tools/registry.js";
import type { Verdict } from "./types.js";

const CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_CALL_TIMEOUT_SECONDS = 60;
// Progress notifications restart the call timer; this caps the whole call.
const MAX_CALL_MS = 10 * 60 * 1000;
const MAX_OUTPUT_CHARS = 16_000;
const MAX_TOOL_PAGES = 20;
const STDERR_TAIL_CHARS = 2_000;
// The Anthropic API accepts ^[a-zA-Z0-9_-]{1,128}$; OpenAI-compatible providers stop at 64.
const MAX_TOOL_NAME = 64;
// Locale, temp folder and proxies, on top of the SDK's own list (PATH, HOME, and on Windows SYSTEMROOT, APPDATA and the rest).
const EXTRA_ENV = ["LANG", "LC_ALL", "TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

const COMMON = {
  // Tools the user released for this server. Everything else needs approval.
  allow: z.array(z.string()).default([]),
  // "verified" comes from the PlifResearch marketplace and runs at level 1. Anything else asks first.
  trust: z.enum(["verified", "community", "local"]).default("local"),
  // Seconds per call. Progress from the server restarts the count.
  timeout: z.number().positive().optional(),
};

const STDIO = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  ...COMMON,
});

const REMOTE = z.object({
  type: z.enum(["http", "streamable-http", "sse"]),
  url: z.string().url(),
  // Values may name variables: "$TOKEN" or "Bearer ${TOKEN}". The secret stays out of mcp.json.
  headers: z.record(z.string(), z.string()).default({}),
  ...COMMON,
});

const SERVER = z.union([STDIO, REMOTE]);

export type McpServer = z.input<typeof STDIO>;
export type McpServerConfig = z.input<typeof SERVER>;

// Claude Code and most READMEs use "mcpServers"; Plif wrote "servers". Both are read.
export async function loadMcpFile(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed = JSON.parse(text) as { servers?: unknown; mcpServers?: unknown };
  const pick = (value: unknown) => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
  return { ...pick(parsed.mcpServers), ...pick(parsed.servers) };
}

export interface McpLoad {
  // Kept up to date when a server announces that its tool list changed.
  readonly tools: RegisteredTool[];
  readonly errors: string[];
  close(): Promise<void>;
}

// Expands $NAME and ${NAME} from the environment. Missing names are collected, never sent as empty strings.
export function expandVariables(value: string, env: NodeJS.ProcessEnv, missing: string[]): string {
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    const resolved = env[value.slice(1)];
    if (resolved === undefined) missing.push(value.slice(1));
    return resolved ?? "";
  }
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) missing.push(name);
    return resolved ?? "";
  });
}

export async function connectMcp(servers: Record<string, unknown>): Promise<McpLoad> {
  const connections: Connection[] = [];
  const tools: RegisteredTool[] = [];
  const errors: string[] = [];
  const taken = new Set<string>();

  for (const [name, raw] of Object.entries(servers)) {
    const checked = SERVER.safeParse(raw);
    if (!checked.success) {
      errors.push(`MCP server ${name}: invalid configuration (${checked.error.issues.map((issue) => `${issue.path.join(".") || "entry"}: ${issue.message}`).join("; ")})`);
      continue;
    }
    const server = checked.data;
    const missing: string[] = [];
    const transport = buildTransport(server, missing);
    if (missing.length > 0) {
      errors.push(`MCP server ${name}: set ${[...new Set(missing)].join(", ")} in the environment`);
      continue;
    }
    const connection = new Connection(name, server, transport);
    try {
      await connection.connect();
      connections.push(connection);
      const own: RegisteredTool[] = [];
      const refresh = async () => {
        const listed = await connection.listAll();
        for (const tool of own) {
          const index = tools.indexOf(tool);
          if (index !== -1) tools.splice(index, 1);
          taken.delete(tool.name);
        }
        own.length = 0;
        for (const tool of listed) {
          const made = mcpTool(name, connection, tool, server.trust === "verified" || server.allow.includes(tool.name), taken, errors);
          if (made !== null) own.push(made);
        }
        tools.push(...own);
      };
      await refresh();
      connection.onToolsChanged(() => {
        refresh().catch((error: unknown) => errors.push(`MCP server ${name}: could not reload its tools: ${messageOf(error)}`));
      });
    } catch (error) {
      errors.push(`MCP server ${name}: ${connection.explain(error)}`);
      await connection.close();
    }
  }

  return {
    tools,
    errors,
    close: async () => {
      await Promise.all(connections.map((connection) => connection.close()));
    },
  };
}

function buildTransport(server: z.output<typeof SERVER>, missing: string[]): () => Transport {
  if ("url" in server) {
    const headers = Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, expandVariables(value, process.env, missing)]));
    const url = new URL(server.url);
    return server.type === "sse"
      ? () => new SSEClientTransport(url, { requestInit: { headers }, eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } }) } })
      : () => new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  }
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const key of EXTRA_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(server.env)) env[key] = expandVariables(value, process.env, missing);
  return () =>
    new StdioClientTransport({ command: server.command, args: server.args, env, ...(server.cwd === undefined ? {} : { cwd: server.cwd }), stderr: "pipe" });
}

const LOOSE_TOOL_LIST = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string(), description: z.string().optional(), inputSchema: z.unknown() })),
  nextCursor: z.string().optional(),
});

interface ListedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

// One server. A connection that drops is opened again on the next call, once.
class Connection {
  private client: Client | null = null;
  private stderr = "";
  private changed: (() => void) | null = null;
  readonly callTimeoutMs: number;

  constructor(
    readonly name: string,
    private readonly server: z.output<typeof SERVER>,
    private readonly makeTransport: () => Transport,
  ) {
    this.callTimeoutMs = (server.timeout ?? DEFAULT_CALL_TIMEOUT_SECONDS) * 1000;
  }

  async connect(): Promise<Client> {
    const transport = this.makeTransport();
    if (transport instanceof StdioClientTransport) {
      const stream = transport.stderr as Readable | null;
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_CHARS);
      });
    }
    const client = new Client({ name: "plif", version: "0.1.0" });
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => this.changed?.());
    client.onclose = () => {
      if (this.client === client) this.client = null;
    };
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    this.client = client;
    return client;
  }

  onToolsChanged(listener: () => void): void {
    this.changed = listener;
  }

  async active(): Promise<Client> {
    return this.client ?? (await this.connect());
  }

  async listAll(): Promise<ListedTool[]> {
    const client = await this.active();
    const all: ListedTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      // The SDK's own listTools rejects the whole list when one tool has an odd schema. This reads it loosely
      // and leaves the decision per tool to schemaFor.
      const listed = await client.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } }, LOOSE_TOOL_LIST, { timeout: CONNECT_TIMEOUT_MS });
      all.push(...listed.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })));
      cursor = listed.nextCursor;
      if (cursor === undefined) break;
    }
    return all;
  }

  async call(tool: string, args: Record<string, unknown>) {
    const client = await this.active();
    return client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: this.callTimeoutMs,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: Math.max(this.callTimeoutMs, MAX_CALL_MS),
    });
  }

  // The last lines the server wrote to stderr usually say why it did not start.
  explain(error: unknown): string {
    const base = messageOf(error);
    const auth = /\b401\b|unauthori[sz]ed/i.test(base) && this.server.type !== undefined && this.server.type !== "stdio"
      ? ". The server asks for authorization: put the token in \"headers\", for example {\"Authorization\": \"Bearer ${TOKEN}\"} (Plif does not run the OAuth login)"
      : "";
    const tail = this.stderr.trim().split("\n").slice(-5).join("\n");
    return `${base}${auth}${tail === "" ? "" : `\nserver stderr:\n${tail}`}`;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.close().catch(() => undefined);
  }
}

// Turns a name into what every provider accepts. A long one keeps a short hash so two tools never collide.
export function toolNameFor(server: string, tool: string, taken: ReadonlySet<string>): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");
  let name = `mcp__${clean(server)}__${clean(tool)}`;
  if (name.length > MAX_TOOL_NAME || taken.has(name)) {
    const hash = createHash("sha256").update(`${server}\n${tool}`).digest("hex").slice(0, 8);
    name = `${name.slice(0, MAX_TOOL_NAME - 9)}_${hash}`;
  }
  return name;
}

// Tool schemas must be a JSON Schema object. One that is not would make every model request fail, so the tool is left out.
export function schemaFor(input: unknown): Record<string, unknown> | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "the input schema is not an object";
  const { $schema: _draft, ...schema } = input as Record<string, unknown>;
  if (schema["type"] === undefined && (schema["properties"] !== undefined || Object.keys(schema).length === 0)) schema["type"] = "object";
  for (const key of ["anyOf", "oneOf", "allOf", "not", "if", "then", "else"]) {
    if (key in schema) return `the input schema uses ${key} at the top level`;
  }
  if (schema["type"] === undefined) return 'the input schema has no type; tools need "object"';
  if (schema["type"] !== "object") return `the input schema has type ${JSON.stringify(schema["type"])}; tools need "object"`;
  return schema;
}

function mcpTool(
  server: string,
  connection: Connection,
  tool: ListedTool,
  released: boolean,
  taken: Set<string>,
  errors: string[],
): RegisteredTool | null {
  const schema = schemaFor(tool.inputSchema);
  if (typeof schema === "string") {
    errors.push(`MCP server ${server}: tool ${tool.name} was left out because ${schema}`);
    return null;
  }
  const name = toolNameFor(server, tool.name, taken);
  taken.add(name);
  const renamed = name === `mcp__${server}__${tool.name}` ? "" : ` (MCP tool "${tool.name}" of server "${server}")`;
  return {
    name,
    definition: {
      name,
      description: `${tool.description ?? ""}${renamed}`.trim(),
      input_schema: schema as Anthropic.Tool["input_schema"],
      // Third-party schemas can have many optional fields; the server validates them instead.
      strict: false,
    },
    parse(raw) {
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return { ok: true, data: raw };
      return { ok: false, message: "input must be an object" };
    },
    async policy(): Promise<Verdict> {
      if (released) return { level: 1, decision: "allow", reason: `${name} released in mcp.json` };
      return { level: 3, decision: "ask_user", reason: `tool ${tool.name} from MCP server ${server}` };
    },
    async run(data) {
      const result = await connection.call(tool.name, data as Record<string, unknown>);
      return mcpOutput(result as McpResult);
    },
  };
}

interface McpResult {
  readonly content?: ReadonlyArray<Record<string, unknown>>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

// Text parts are wrapped as JSON so that they read as data, not as instructions. Images go to the model as images.
export function mcpOutput(result: McpResult): ToolOutput {
  const texts: string[] = [];
  const images: Anthropic.ImageBlockParam[] = [];
  for (const part of result.content ?? []) {
    const type = String(part["type"] ?? "");
    if (type === "text") texts.push(String(part["text"] ?? ""));
    else if (type === "image") {
      const bytes = Buffer.from(String(part["data"] ?? ""), "base64");
      const image = checkImage(bytes);
      if (typeof image === "string") texts.push(`[image left out: ${image}]`);
      else images.push(imageBlock(bytes, image.type));
    } else if (type === "resource") {
      const resource = (part["resource"] ?? {}) as Record<string, unknown>;
      texts.push(typeof resource["text"] === "string" ? `[resource ${String(resource["uri"] ?? "")}]\n${resource["text"]}` : `[binary resource ${String(resource["uri"] ?? "")}]`);
    } else if (type === "resource_link") {
      texts.push(`[resource link: ${String(part["name"] ?? "")} ${String(part["uri"] ?? "")}]`);
    } else if (type === "audio") {
      texts.push(`[audio content, ${String(part["mimeType"] ?? "unknown type")}]`);
    } else {
      texts.push(`[${type || "unknown"} content]`);
    }
  }
  if (texts.every((text) => text.trim() === "") && result.structuredContent !== undefined) texts.push(JSON.stringify(result.structuredContent));
  if (result.isError === true) throw new Error(texts.join("\n") || "the MCP tool failed");
  const text = limitOutput(JSON.stringify({ content: texts }), MAX_OUTPUT_CHARS);
  if (images.length === 0) return text;
  const blocks: ToolBlocks = [{ type: "text", text }, ...images];
  return blocks;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
