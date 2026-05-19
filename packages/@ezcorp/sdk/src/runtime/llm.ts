// ── Llm — typed client for ezcorp/llm-complete reverse RPC ─────
//
// The defining contract: **the API token NEVER reaches this code.**
// `ctx.llm.complete()` issues an `ezcorp/llm-complete` RPC; the host
// resolves credentials, calls `pi-ai`'s `complete()` directly, and
// returns ONLY the result fields. The subprocess (this code) sees
// no token at any point.
//
// Soft-fail error mapping (host → SDK class):
//   -32101  →  LlmProviderError  (provider not granted / model not allowed)
//   -32103  →  LlmQuotaError      (calls-per-hour | calls-per-day | tokens-per-day)
//   -32104  →  LlmCredentialError (host has no credentials for provider)
//   -32105  →  LlmProviderError   (upstream call failed)
//
// Streaming: `ctx.llm.stream()` is stub-only — it throws
// `NotImplementedError` immediately. Real backpressure-aware streaming
// is a v1.4 phase.

import { getChannel, JsonRpcError } from "./channel";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
  blocks?: unknown[];
}

export interface LlmCompleteOpts {
  provider: string;
  model: string;
  systemPrompt?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  jsonSchema?: unknown;
  timeoutMs?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  estCostCents?: number;
}

export interface LlmCompleteResult {
  content: string;
  blocks: unknown[];
  usage: LlmUsage;
  finishReason: "stop" | "max_tokens" | "tool_use" | "error" | "filtered";
  model: string;
}

export interface LlmBudgetSnapshot {
  callsRemaining: { hour: number; day: number };
  tokensRemaining: { day: number };
}

export class LlmQuotaError extends Error {
  readonly code = "LLM_QUOTA_EXCEEDED";
  readonly reason: "calls-per-hour" | "calls-per-day" | "tokens-per-day";
  readonly retryAfterMs: number;
  constructor(reason: LlmQuotaError["reason"], retryAfterMs: number, message?: string) {
    super(message ?? `LLM quota exceeded: ${reason}`);
    this.name = "LlmQuotaError";
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

export class LlmProviderError extends Error {
  readonly code = "LLM_PROVIDER_NOT_GRANTED";
  readonly provider: string;
  constructor(provider: string, message?: string) {
    super(message ?? `LLM provider not granted: ${provider}`);
    this.name = "LlmProviderError";
    this.provider = provider;
  }
}

export class LlmCredentialError extends Error {
  readonly code = "LLM_CREDENTIAL_MISSING";
  readonly provider: string;
  constructor(provider: string, message?: string) {
    super(message ?? `LLM credential missing for provider: ${provider}`);
    this.name = "LlmCredentialError";
    this.provider = provider;
  }
}

export class NotImplementedError extends Error {
  readonly code = "NOT_IMPLEMENTED";
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

function rpcCode(err: unknown): number | null {
  if (err instanceof JsonRpcError) return err.code;
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code: unknown }).code;
    if (typeof c === "number") return c;
  }
  return null;
}

function rpcData(err: unknown): unknown {
  if (err instanceof JsonRpcError) return err.data;
  return undefined;
}

export class Llm {
  async complete(opts: LlmCompleteOpts): Promise<LlmCompleteResult> {
    try {
      return await getChannel().request<LlmCompleteResult>("ezcorp/llm-complete", {
        op: "complete",
        provider: opts.provider,
        model: opts.model,
        ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
        messages: opts.messages,
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.jsonSchema !== undefined ? { jsonSchema: opts.jsonSchema } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
    } catch (err) {
      const code = rpcCode(err);
      const message = (err as Error)?.message ?? String(err);
      if (code === -32101) throw new LlmProviderError(opts.provider, message);
      if (code === -32103) {
        const data = rpcData(err) as { reason?: string; retryAfterMs?: number } | undefined;
        throw new LlmQuotaError(
          (data?.reason as LlmQuotaError["reason"]) ?? "calls-per-hour",
          data?.retryAfterMs ?? 0,
          message,
        );
      }
      if (code === -32104) throw new LlmCredentialError(opts.provider, message);
      if (code === -32105) throw new LlmProviderError(opts.provider, message);
      throw err;
    }
  }

  // biome-ignore lint/correctness/useYield: stub-only; throws before any yield is meaningful.
  async *stream(_opts: LlmCompleteOpts): AsyncIterable<{ delta: string; usage?: LlmUsage }> {
    // The throw makes the generator unreachable past this point; we
    // need the `yield` to satisfy the AsyncIterable protocol shape so
    // the type-narrowing for callers works.
    if (false as boolean) {
      yield { delta: "" };
    }
    throw new NotImplementedError(
      "ctx.llm.stream() is not implemented — streaming deferred to v1.4. Use ctx.llm.complete() instead.",
    );
  }

  async getBudget(provider: string): Promise<LlmBudgetSnapshot> {
    return getChannel().request<LlmBudgetSnapshot>("ezcorp/llm-complete", {
      op: "budget",
      provider,
      // model required by the type contract; budget op ignores it.
      model: "",
      messages: [],
    });
  }
}
