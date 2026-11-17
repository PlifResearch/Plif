import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { setTimeout as sleep } from "node:timers/promises";

export const MAX_API_RETRIES = 5;
export const MAX_STREAM_RETRIES = 3;

export type ApiFailureKind = "rate_limit" | "usage_limit" | "authentication" | "permission" | "not_found" | "invalid_request" | "server" | "connection" | "timeout" | "incomplete_stream" | "compatibility" | "cancelled";

export interface RetryEvent {
  readonly retry: number;
  readonly maxRetries: number;
  readonly delayMs: number;
  readonly kind: ApiFailureKind;
  readonly message: string;
  readonly streamRetry?: number;
}

export interface RetryOptions {
  readonly signal?: AbortSignal;
  readonly onRetry?: (event: RetryEvent) => void;
}

export interface RetryRuntime {
  readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

interface FailureDetails {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

export class ApiFailure extends Error {
  constructor(
    readonly kind: ApiFailureKind,
    message: string,
    readonly details: FailureDetails = {},
  ) {
    super(message, { cause: details.cause });
    this.name = "ApiFailure";
  }

  get retryable(): boolean {
    return this.details.retryable ?? ["rate_limit", "server", "connection", "timeout", "incomplete_stream", "compatibility"].includes(this.kind);
  }
}

export function incompleteStream(): ApiFailure {
  return new ApiFailure("incomplete_stream", "Incomplete API stream: missing finish_reason or message_stop; partial tool calls were discarded.");
}

export async function retryApiCall<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
  runtime: RetryRuntime = {},
): Promise<T> {
  let retries = 0;
  let streamRetries = 0;
  let previousDelay = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      const result = await operation();
      options.signal?.throwIfAborted();
      return result;
    } catch (error) {
      options.signal?.throwIfAborted();
      const failure = apiFailure(error, (runtime.now ?? Date.now)());
      if (failure === null) throw error;
      const streamLimit = failure.kind === "incomplete_stream" && streamRetries >= MAX_STREAM_RETRIES;
      if (!failure.retryable || retries >= MAX_API_RETRIES || streamLimit) {
        const exhausted = streamLimit
          ? ` Request stopped after ${streamRetries} incomplete-stream retries.`
          : retries >= MAX_API_RETRIES ? ` Request stopped after ${retries} retries.` : "";
        const id = failure.details.requestId === undefined ? "" : ` Request ID: ${failure.details.requestId}.`;
        throw new ApiFailure(failure.kind, `${failure.message}${exhausted}${id}`, failure.details);
      }
      const delayMs = failure.kind === "compatibility"
        ? 0
        : Math.max(2_000 * 2 ** retries, previousDelay === 0 ? 0 : previousDelay + 1_000, failure.details.retryAfterMs ?? 0);
      retries++;
      if (failure.kind === "incomplete_stream") streamRetries++;
      if (delayMs > 0) previousDelay = delayMs;
      options.onRetry?.({ retry: retries, maxRetries: MAX_API_RETRIES, delayMs, kind: failure.kind, message: failure.message, ...(failure.kind === "incomplete_stream" ? { streamRetry: streamRetries } : {}) });
      options.signal?.throwIfAborted();
      if (delayMs > 0) await (runtime.wait ?? waitForRetry)(delayMs, options.signal);
    }
  }
}

export function retryNotice(event: RetryEvent): string {
  const stream = event.streamRetry === undefined ? "" : `; incomplete stream ${event.streamRetry}/${MAX_STREAM_RETRIES}`;
  return `${event.message} Retrying in ${Math.ceil(event.delayMs / 1_000)}s (${event.retry}/${event.maxRetries}${stream}).`;
}

// Node timers overflow above 2^31-1 ms. Long provider cooldowns stay cancellable without firing immediately.
async function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 2_147_483_647);
    await sleep(chunk, undefined, { signal });
    remaining -= chunk;
  }
}

export function apiFailure(error: unknown, now = Date.now()): ApiFailure | null {
  if (error instanceof ApiFailure) return error;
  if (error instanceof OpenAI.APIUserAbortError || error instanceof Anthropic.APIUserAbortError) {
    return new ApiFailure("cancelled", "API request cancelled.", { cause: error });
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError || error instanceof Anthropic.APIConnectionTimeoutError || (error instanceof Error && error.name === "TimeoutError")) {
    return new ApiFailure("timeout", "API request timed out.", { cause: error });
  }
  if (error instanceof OpenAI.APIConnectionError || error instanceof Anthropic.APIConnectionError) {
    return new ApiFailure("connection", "Could not connect to the API. Check the proxy, network and provider.base_url.", { cause: error });
  }
  if (error instanceof Error && /stream ended without producing a Message|request ended without sending any chunks|malformed server-sent event JSON|^terminated$/.test(error.message)) return incompleteStream();
  if (!(error instanceof OpenAI.APIError) && !(error instanceof Anthropic.APIError)) return null;

  const status = error.status;
  const body = object(error.error);
  const nested = object(body["error"]);
  const detail = object(nested["details"]);
  const codes = [body["code"], body["type"], nested["code"], nested["type"], detail["error_code"]].filter((value) => typeof value === "string").join(" ");
  // Proxy messages have no stable code on some servers. They inform classification only; raw bodies and keys never reach the UI.
  const said = `${codes} ${error.message}`;
  const retryAfterMs = retryAfter(error.headers, now);
  const requestId = error.requestID;
  const details: FailureDetails = {
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(typeof requestId === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(requestId) && !/^(?:sk-|gh[pousr]_|AKIA|eyJ)/i.test(requestId) ? { requestId } : {}),
    ...(error.headers?.get("x-should-retry") === "false" ? { retryable: false } : {}),
    cause: error,
  };
  const http = status === undefined ? "" : ` (HTTP ${status})`;
  if (status === 401 || /authentication_error|invalid_api_key/.test(codes)) return new ApiFailure("authentication", `API authentication failed${http}. Check the provider API key.`, details);
  if (status === 403) return new ApiFailure("permission", `API access denied${http}. Check account and model permissions.`, details);
  if (status === 404) return new ApiFailure("not_found", `API model or endpoint not found${http}. Check the model ID and provider.base_url.`, details);
  const hardQuota = status === 402 || /insufficient_quota|quota_exceeded|billing[_ ]hard[_ ]limit|credit[_ ]balance|insufficient[_ ](?:credit|balance)|out of credits|exceeded.*(?:current quota|spend limit)/i.test(said);
  if (hardQuota || /(?:usage|spend|billing|daily|monthly)[_ ]limit[_ ](?:reached|exceeded)/i.test(said)) {
    return new ApiFailure("usage_limit", `API usage or billing limit reached${http}. Check the account balance or usage allowance.`, { ...details, retryable: !hardQuota && retryAfterMs !== undefined && error.headers?.get("x-should-retry") !== "false" });
  }
  if (status === 429 || /rate_limit|rate limit|too many requests|(?:5.hour|usage) limit/i.test(said)) return new ApiFailure("rate_limit", `API rate limit reached${http}.`, details);
  if (status === 413) return new ApiFailure("invalid_request", `API request too large${http}. Reduce attachments or conversation size.`, details);
  if (status === 408 || status === 504) return new ApiFailure("timeout", `API request timed out${http}.`, details);
  if (status === 409 || (status !== undefined && status >= 500) || /overloaded_error|server_error|\bapi_error\b/.test(codes)) return new ApiFailure("server", `API temporarily unavailable${http}.`, details);
  return new ApiFailure("invalid_request", `API rejected the request${http}. Check the model and request parameters.`, details);
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function retryAfter(headers: Headers | undefined, now: number): number | undefined {
  if (headers === undefined) return undefined;
  const waits: number[] = [];
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds !== null && /^\d+(?:\.\d+)?$/.test(milliseconds)) waits.push(Number(milliseconds));
  const seconds = headers.get("retry-after");
  if (seconds !== null) {
    const wait = /^\d+(?:\.\d+)?$/.test(seconds) ? Number(seconds) * 1_000 : Date.parse(seconds) - now;
    if (Number.isFinite(wait) && wait >= 0) waits.push(wait);
  }
  for (const resource of ["requests", "tokens"]) {
    for (const vendor of ["openai", "anthropic"]) {
      const reset = vendor === "openai" ? `x-ratelimit-reset-${resource}` : `anthropic-ratelimit-${resource}-reset`;
      const left = vendor === "openai" ? `x-ratelimit-remaining-${resource}` : `anthropic-ratelimit-${resource}-remaining`;
      const value = headers.get(reset);
      if (value === null || (headers.has(left) && headers.get(left) !== "0")) continue;
      const wait = durationMs(value) ?? Date.parse(value) - now;
      if (Number.isFinite(wait) && wait >= 0) waits.push(wait);
    }
  }
  const valid = waits.filter((ms) => Number.isFinite(ms) && ms >= 0);
  return valid.length === 0 ? undefined : Math.max(...valid);
}

function durationMs(value: string): number | undefined {
  if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(value)) return undefined;
  const unit: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)].reduce((total, match) => total + Number(match[1]) * (unit[match[2] ?? ""] ?? 0), 0);
}
