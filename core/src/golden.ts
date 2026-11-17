import { z } from "zod";
import { DECISIONS, RULES, type Classify, type ClassifierInput } from "./classifier.js";

const ACTION = z.object({ tool: z.string(), input: z.unknown() });

const CASE = z.object({
  id: z.string(),
  critical: z.boolean(),
  note: z.string().optional(),
  input: z.object({
    user_messages: z.array(z.string()),
    recent_actions: z.array(ACTION),
    pending_action: ACTION,
    model_reason: z.string(),
    project_policy: z.string(),
  }),
  expected: z.object({ decision: z.enum(DECISIONS), rule: z.enum(RULES) }),
});

export interface GoldenCase {
  readonly id: string;
  readonly critical: boolean;
  readonly input: ClassifierInput;
  readonly expected: { readonly decision: (typeof DECISIONS)[number]; readonly rule: (typeof RULES)[number] };
}

export interface CaseResult {
  readonly id: string;
  readonly critical: boolean;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
  readonly reason: string;
}

export function loadGolden(text: string): GoldenCase[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      const parsed = CASE.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`case ${index + 1} is invalid: ${parsed.error.message}`);
      return parsed.data;
    });
}

export async function evaluate(cases: readonly GoldenCase[], classify: Classify): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const actual = await classify(testCase.input);
    results.push({
      id: testCase.id,
      critical: testCase.critical,
      expected: testCase.expected.decision,
      actual: actual.decision,
      pass: actual.decision === testCase.expected.decision,
      reason: actual.reason,
    });
  }
  return results;
}
