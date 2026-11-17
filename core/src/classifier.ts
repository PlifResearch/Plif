import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ModelClient, ModelRequestOptions } from "./model.js";

export const CLASSIFIER_MODEL = "claude-haiku-5-5";

export const DECISIONS = ["allow", "ask_user", "deny"] as const;
export const RULES = [
  "authorized_scope",
  "outside_scope",
  "irreversible",
  "outward_facing",
  "protected_path",
  "secret_exposure",
  "unclear",
  "clearly_safe",
] as const;

export interface ClassifierInput {
  readonly user_messages: readonly string[];
  readonly recent_actions: readonly { readonly tool: string; readonly input: unknown }[];
  readonly pending_action: { readonly tool: string; readonly input: unknown };
  readonly model_reason: string;
  readonly project_policy: string;
}

export interface Classification {
  readonly decision: (typeof DECISIONS)[number];
  readonly rule: (typeof RULES)[number];
  readonly reason: string;
}

export type Classify = (input: ClassifierInput, options?: ModelRequestOptions) => Promise<Classification>;

const OUTPUT = z.object({
  decision: z.enum(DECISIONS),
  rule: z.enum(RULES),
  reason: z.string().min(1).max(200),
});

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: [...DECISIONS] },
    rule: { type: "string", enum: [...RULES] },
    reason: { type: "string" },
  },
  required: ["decision", "rule", "reason"],
  additionalProperties: false,
};

export function classifierRequest(
  input: ClassifierInput,
  systemPrompt: string,
  modelId = CLASSIFIER_MODEL,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: modelId,
    max_tokens: 400,
    system: systemPrompt,
    cache_control: { type: "ephemeral" },
    messages: [{ role: "user", content: JSON.stringify(input) }],
    thinking: { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
  };
}

export function classificationFrom(message: Anthropic.Message): Classification {
  if (message.stop_reason !== "end_turn") {
    return unclear(`classifier did not finish (${message.stop_reason ?? "no reason"})`);
  }
  return parseOutput(message.content);
}

export function createClassifier(model: ModelClient, systemPrompt: string, modelId = CLASSIFIER_MODEL): Classify {
  return async (input, options) => classificationFrom(await model.create(classifierRequest(input, systemPrompt, modelId), options));
}

function parseOutput(content: readonly Anthropic.ContentBlock[]): Classification {
  const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return unclear("classifier response is not in the expected format");
  }
  const parsed = OUTPUT.safeParse(raw);
  return parsed.success ? parsed.data : unclear("classifier response is not in the expected format");
}

export function unclear(reason: string): Classification {
  return { decision: "ask_user", rule: "unclear", reason };
}
