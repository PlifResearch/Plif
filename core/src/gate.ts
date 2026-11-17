import type { Classification, Classify, ClassifierInput } from "./classifier.js";
import type { ModelRequestOptions } from "./model.js";

const MAX_CONSECUTIVE_BLOCKS = 3;
const MAX_TOTAL_BLOCKS = 20;

export class ClassifierGate {
  private consecutive = 0;
  private total = 0;
  private paused = false;

  constructor(private readonly classify: Classify) {}

  get isPaused(): boolean {
    return this.paused;
  }

  resume(): void {
    this.consecutive = 0;
    this.total = 0;
    this.paused = false;
  }

  async review(input: ClassifierInput, options?: ModelRequestOptions): Promise<Classification | null> {
    if (this.paused) return null;

    const verdict = await this.classify(input, options).catch(
      (error: unknown): Classification => {
        options?.signal?.throwIfAborted();
        return {
          decision: "ask_user",
          rule: "unclear",
          reason: `classifier unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
      },
    );
    options?.signal?.throwIfAborted();

    if (verdict.decision === "ask_user") {
      this.consecutive++;
      this.total++;
      if (this.consecutive >= MAX_CONSECUTIVE_BLOCKS || this.total >= MAX_TOTAL_BLOCKS) this.paused = true;
    } else if (verdict.decision === "allow") {
      this.consecutive = 0;
    }
    return verdict;
  }
}
