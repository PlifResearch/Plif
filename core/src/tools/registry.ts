import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { limitOutput } from "../output.js";
import { type PolicyContext, type ToolContext, type Verdict, policyContextOf } from "../types.js";

const MAX_TOOL_OUTPUT_CHARS = 16_000;

// Most tools answer with text. A tool can also answer with blocks, so an image reaches the model as an image.
export type ToolBlocks = Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;
export type ToolOutput = string | ToolBlocks;

export interface Tool<S extends z.ZodType, O extends ToolOutput = string> {
  readonly name: string;
  readonly description: string;
  readonly schema: S;
  // Strict sampling compiles every strict schema of a request into one grammar, and the API caps its size.
  // Tools whose wrong input does no harm turn it off; zod still validates every input before it runs.
  readonly strict?: boolean;
  policy(input: z.output<S>, ctx: PolicyContext): Promise<Verdict>;
  run(input: z.output<S>, ctx: ToolContext): Promise<O>;
}

export type ParseResult = { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly message: string };

export interface RegisteredTool {
  readonly name: string;
  readonly definition: Anthropic.Tool;
  parse(raw: unknown): ParseResult;
  policy(data: unknown, ctx: ToolContext): Promise<Verdict>;
  run(data: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

// The text that stands for an output in logs, hooks and the screen. Images become a short note.
export function outputText(output: ToolOutput): string {
  if (typeof output === "string") return output;
  return output
    .map((block) => (block.type === "text" ? block.text : `[image ${block.source.type === "base64" ? block.source.media_type : "url"}]`))
    .join("\n");
}

export function register<S extends z.ZodType, O extends ToolOutput>(tool: Tool<S, O>): RegisteredTool {
  const inputSchema = strictSchema(z.toJSONSchema(tool.schema) as Record<string, unknown>);
  return {
    name: tool.name,
    definition: {
      name: tool.name,
      description: tool.description,
      input_schema: inputSchema as Anthropic.Tool["input_schema"],
      strict: tool.strict ?? true,
    },
    parse(raw) {
      const result = tool.schema.safeParse(raw);
      if (result.success) return { ok: true, data: result.data };
      const message = result.error.issues.map((issue) => `${issue.path.map(String).join(".") || "entrada"}: ${issue.message}`);
      return { ok: false, message: message.join("; ") };
    },
    policy: (data, ctx) => tool.policy(data as z.output<S>, policyContextOf(ctx)),
    run: async (data, ctx) => {
      const output = await tool.run(data as z.output<S>, ctx);
      if (typeof output === "string") return limitOutput(output, MAX_TOOL_OUTPUT_CHARS);
      return output.map((block) => (block.type === "text" ? { ...block, text: limitOutput(block.text, MAX_TOOL_OUTPUT_CHARS) } : block));
    },
  };
}

const CONSTRAINT_LABELS: Record<string, string> = {
  minimum: "minimum",
  maximum: "maximum",
  exclusiveMinimum: "exclusive minimum",
  exclusiveMaximum: "exclusive maximum",
  multipleOf: "multiple of",
  minLength: "minimum length",
  maxLength: "maximum length",
  maxItems: "maximum items",
  minItems: "minimum items",
};

// Strict tool use does not accept numeric or size constraints. Validation stays
// in zod; the model gets the limits in the field description.
function strictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _draft, ...rest } = schema;
  return stripConstraints(rest) as Record<string, unknown>;
}

function stripConstraints(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripConstraints);
  if (node === null || typeof node !== "object") return node;
  const record: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  const notes: string[] = [];
  for (const [key, label] of Object.entries(CONSTRAINT_LABELS)) {
    if (key in record) {
      notes.push(`${label} ${String(record[key])}`);
      delete record[key];
    }
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) result[key] = stripConstraints(value);
  if (notes.length > 0) {
    const base = typeof result["description"] === "string" ? `${result["description"]} ` : "";
    result["description"] = `${base}(${notes.join(", ")})`;
  }
  return result;
}
