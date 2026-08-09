import { stream, streamSimple, complete, completeSimple } from "@earendil-works/pi-ai/compat";
import type { Context } from "@earendil-works/pi-ai";
import type { ModelOverride } from "../types";
import { resolveModel } from "../providers/router";
import { tierForModel } from "../providers/registry";
import { isRoutingTier } from "./tier-classifier";
import { effortIgnoredNotice, modelHonoursEffort } from "./routing/effort-support";
import { getCredential } from "../providers/credentials";
import { getDb } from "../db/connection";
import { toolCalls } from "../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "../logger";
import type { FallbackSuggestion } from "../providers/router";
import type { FailoverAttempt } from "./stream-chat/failover";

const log = logger.child("executor.helpers");

/**
 * Resolve a fallback suggestion into a full failover attempt: the resolved
 * model plus its pre-validated credential. Lives here (not inline in
 * executor.ts) so `getCredential` access stays inside the audited host-side
 * allowlist — see `get-credential-boundary.test.ts`. Used by the WS2
 * pre-stream failover loop (`runWithFailover`).
 */
export async function resolveFailoverAttempt(
  suggestion: FallbackSuggestion,
  credentialConversationId: string,
): Promise<FailoverAttempt> {
  const r = await resolveModel(suggestion.provider, suggestion.model);
  const cred = await getCredential(r.provider, credentialConversationId);
  return {
    provider: r.provider,
    model: r.model,
    resolved: {
      resolved: r,
      initialCred: cred,
      // The candidate was selected IN the loop's tier (suggestFallback
      // returns it verbatim); carry it so the rebuilt attempt's
      // SetupToolsResult stays complete. `suggestion.tier` is a plain
      // string on the wire — narrow it, falling back to the resolved
      // model's own inferred tier rather than a hardcoded default.
      effectiveTier: isRoutingTier(suggestion.tier) ? suggestion.tier : tierForModel(r.piModel),
    },
  };
}

/** Loose message shape accepted by the adapter. Code-based agents assemble
 *  plain `{role, content}` objects — we forward them verbatim to pi-ai and
 *  tack on a timestamp. `system` is passed through `options.system` instead
 *  of a message role (pi-ai's `Message` union has no system variant). */
export interface PiLlmMessage {
  role: "user" | "assistant";
  content: string;
}

/** Shared options across `complete` + `stream`. All optional — missing
 *  provider/model defaults to the router's pick; missing system prompt
 *  falls back to the model's system default. */
export interface PiLlmOptions {
  system?: string;
  provider?: string;
  model?: string;
  signal?: AbortSignal;
  /** The AGENT's own sampling ask (`AgentConfig.temperature` /
   *  `AgentConfig.maxTokens`, put here by `configToAgent`). Honoured only
   *  when a caller-level {@link ModelOverride} is silent on the same knob —
   *  see {@link resolveTuning}. */
  temperature?: number;
  maxTokens?: number;
}

/** Yielded by `stream` per-event. Token frames carry text deltas, `done`
 *  carries the final usage counts, `error` is surfaced on pi-ai's
 *  stream-error event. */
export type PiLlmStreamEvent =
  | { type: "token"; text: string }
  | { type: "done"; usage: { inputTokens: number; outputTokens: number } }
  | { type: "error"; error: string };

export interface PiLlmAdapter {
  complete(
    messages: PiLlmMessage[],
    options?: PiLlmOptions,
  ): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }>;
  stream(messages: PiLlmMessage[], options?: PiLlmOptions): AsyncGenerator<PiLlmStreamEvent>;
  /**
   * Provider + model the MOST RECENT call resolved to. Written after
   * `resolveModel`, so it reports what actually served the call — the
   * override, the caller's binding or the router's pick, already collapsed
   * into one answer. Undefined until the first call. Read by `runAgent`
   * to stamp the `AgentRun`, which is how a workflow step records the
   * model it really ran on.
   */
  lastResolved?: { provider: string; model: string };
  /**
   * Tokens reported by every call this adapter has served, SUMMED.
   *
   * Cumulative, not last-call, because one `runAgent` may drive several
   * LLM calls and the number an operator wants is what the run consumed.
   *
   * **Undefined means "no call reported usage", and that is different
   * from zero.** A provider can legitimately omit usage — a cached
   * response, a stream that errors before `done` — and a run that never
   * touched `ctx.llm` reports nothing at all. Storing 0 for those would
   * be a claim ("this cost nothing") that every SUM downstream believes;
   * undefined becomes SQL NULL, which every SQL aggregate already
   * ignores. So this field is only ever created by a call that actually
   * reported finite counts.
   */
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Fold one call's reported usage into the adapter's running total.
 *
 * Non-finite counts (a provider that omitted the field, a `NaN` from a
 * partial frame) are dropped rather than coerced: adding `NaN` once would
 * poison the total for the whole run, and adding 0 would invent a
 * measurement that was never taken.
 */
function accumulateUsage(
  adapter: PiLlmAdapter,
  usage: { inputTokens: number; outputTokens: number },
): void {
  if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) return;
  const prev = adapter.usage ?? { inputTokens: 0, outputTokens: 0 };
  adapter.usage = {
    inputTokens: prev.inputTokens + usage.inputTokens,
    outputTokens: prev.outputTokens + usage.outputTokens,
  };
}

/**
 * First usable sampling value, in precedence order.
 *
 * The runtime check is NOT redundant with the types. The agent-side value
 * originates in `*.agent.yaml`, which `yaml-loader.ts` `parse()`s and
 * casts straight to `AgentConfig` with no validation — so `maxTokens: ~`
 * (null), `maxTokens: "lots"` and `temperature: .nan` all reach here
 * wearing a `number` type they do not have. Before sampling was
 * forwarded at all those were harmless; now that the value goes on the
 * wire, a non-number must be treated as "not set" rather than shipped to
 * the provider. Anything that isn't a finite number is skipped, and the
 * next candidate (or nothing) is used.
 */
function firstFiniteNumber(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return undefined;
}

/**
 * Collapse the two sampling sources into the options pi-ai actually gets.
 *
 * Precedence is the SAME rule provider/model already used: a caller-level
 * {@link ModelOverride} (a workflow step's `model:` binding) beats the
 * agent's own per-call ask, and an override that is silent on a knob
 * leaves the agent's ask standing.
 *
 * Keys are only ever created for usable values. Emitting
 * `temperature: undefined` would be a wire change for every agent that
 * sets nothing, so the absent case must produce a literally empty object.
 */
function resolveTuning(
  overrides: ModelOverride | undefined,
  options: PiLlmOptions | undefined,
): { temperature?: number; maxTokens?: number } {
  const tuning: { temperature?: number; maxTokens?: number } = {};
  const temperature = firstFiniteNumber(overrides?.temperature, options?.temperature);
  const maxTokens = firstFiniteNumber(overrides?.maxTokens, options?.maxTokens);
  if (temperature !== undefined) tuning.temperature = temperature;
  if (maxTokens !== undefined) tuning.maxTokens = maxTokens;
  return tuning;
}

/**
 * Build the pi-ai-backed LLM wrapper used by **code-based agents** (the
 * `runAgent` path — distinct from `streamChat`, which constructs its
 * pi-agent-core `Agent` directly).
 *
 * Pure factory — no executor state. Resolves provider + credential per
 * call so model overrides on each invocation work.
 *
 * `overrides`, when supplied, is a caller-level model binding that BEATS
 * whatever the agent asks for per call: a workflow step's `model`
 * reaches the LLM through this parameter and nothing else. It is the one
 * chokepoint, so an override cannot be half-applied.
 *
 * **Omitting it leaves the caller in charge**: with no override, every
 * branch below collapses to the exact same `resolveModel(...)` inputs, and
 * a caller that asks for no sampling knobs still gets the historical
 * `complete(model, context, { apiKey })` / `stream(model, context, {
 * apiKey, signal })` call, with no stray `undefined` keys on the wire.
 *
 * `onEffortIgnored`, when supplied, is told once per distinct resolved
 * model that the override's `effort` will NOT be applied — see
 * {@link modelHonoursEffort} for why a local/custom model always drops it.
 * The runtime cannot make the model reason, but it must not pretend it
 * did: an unheard effort that says nothing is the failure mode this
 * closes. Omitted ⇒ nothing is emitted and the call is byte-identical.
 */
export function createPiLlmAdapter(
  overrides?: ModelOverride,
  onEffortIgnored?: (message: string) => void,
): PiLlmAdapter {
  // Reasoning effort has no home on the raw `stream`/`complete` options —
  // each provider spells it differently. pi-ai's `*Simple` entrypoints are
  // the normalizer, so an effort-bearing call routes through those and
  // every other call keeps the raw path it has always used.
  const reasoning = overrides?.effort;

  // Reported from the RESOLVED model, never from the binding: the same
  // object the call is about to ship is the only thing that can answer
  // whether the effort survives, and asking anything else would be a
  // second opinion that could disagree with the request we actually make.
  //
  // Deduped per provider+model rather than per call — a code-based agent
  // may call `complete` in a loop, and the same sentence a hundred times
  // is how a true warning becomes noise. Per MODEL, not once outright,
  // because a caller may vary `options.provider`/`options.model` between
  // calls and each distinct drop is its own fact.
  const noticed = new Set<string>();
  const noteEffortIfIgnored = (resolved: Awaited<ReturnType<typeof resolveModel>>): void => {
    if (reasoning === undefined || onEffortIgnored === undefined) return;
    if (modelHonoursEffort(resolved.piModel)) return;
    const key = `${resolved.provider}/${resolved.model}`;
    if (noticed.has(key)) return;
    noticed.add(key);
    onEffortIgnored(
      effortIgnoredNotice({
        provider: resolved.provider,
        model: resolved.model,
        effort: reasoning,
      }),
    );
  };

  const adapter: PiLlmAdapter = {
    async complete(messages, options) {
      const resolved = await resolveModel(
        overrides?.provider ?? options?.provider,
        overrides?.model ?? options?.model,
      );
      const cred = await getCredential(resolved.provider);
      adapter.lastResolved = { provider: resolved.provider, model: resolved.model };
      noteEffortIfIgnored(resolved);
      // Only `role: "user"` carries a plain string `content` in pi-ai's
      // UserMessage shape; assistant turns would need the full pi-ai
      // AssistantMessage (api/provider/model/usage/stopReason). Code-based
      // agents never replay assistant turns, so we type-narrow on role to
      // stay within UserMessage's contract.
      const context: Context = {
        systemPrompt: options?.system,
        messages: messages
          .filter((m): m is PiLlmMessage & { role: "user" } => m.role === "user")
          .map((m) => ({ role: "user" as const, content: m.content, timestamp: Date.now() })),
      };
      const callOpts = { apiKey: cred.token, ...resolveTuning(overrides, options) };
      const result = reasoning
        ? await completeSimple(resolved.piModel, context, { ...callOpts, reasoning })
        : await complete(resolved.piModel, context, callOpts);
      const text = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      const usage = { inputTokens: result.usage.input, outputTokens: result.usage.output };
      accumulateUsage(adapter, usage);
      return { text, usage };
    },
    async *stream(messages, options) {
      const resolved = await resolveModel(
        overrides?.provider ?? options?.provider,
        overrides?.model ?? options?.model,
      );
      const cred = await getCredential(resolved.provider);
      adapter.lastResolved = { provider: resolved.provider, model: resolved.model };
      noteEffortIfIgnored(resolved);
      // Only `role: "user"` carries a plain string `content` in pi-ai's
      // UserMessage shape; assistant turns would need the full pi-ai
      // AssistantMessage (api/provider/model/usage/stopReason). Code-based
      // agents never replay assistant turns, so we type-narrow on role to
      // stay within UserMessage's contract.
      const context: Context = {
        systemPrompt: options?.system,
        messages: messages
          .filter((m): m is PiLlmMessage & { role: "user" } => m.role === "user")
          .map((m) => ({ role: "user" as const, content: m.content, timestamp: Date.now() })),
      };
      const callOpts = {
        apiKey: cred.token,
        signal: options?.signal,
        ...resolveTuning(overrides, options),
      };
      const s = reasoning
        ? streamSimple(resolved.piModel, context, { ...callOpts, reasoning })
        : stream(resolved.piModel, context, callOpts);
      for await (const event of s) {
        if (event.type === "text_delta") yield { type: "token", text: event.delta };
        // A stream that errors before `done` never reaches this line, so
        // it contributes nothing — which is the honest reading: no usage
        // was reported for it.
        if (event.type === "done") {
          const usage = {
            inputTokens: event.message.usage.input,
            outputTokens: event.message.usage.output,
          };
          accumulateUsage(adapter, usage);
          yield { type: "done", usage };
        }
        if (event.type === "error") {
          // pi-ai's error event carries a partial AssistantMessage whose
          // content array mixes TextContent / ThinkingContent / ToolCall.
          // Filter to text parts for the surfaced error string.
          const errText =
            event.error.content
              ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("") ?? "Stream error";
          yield { type: "error", error: errText };
        }
      }
    },
  };
  return adapter;
}

/**
 * Persist an error as an assistant message + re-anchor any orphan tool_calls
 * to that message. Shared by the streamChat error paths (provider-unavailable,
 * generic error, top-level setup error). No-op when persist=false.
 *
 * Imported lazily to keep startup quick — `createMessage` pulls a chunk
 * of the conversations module into the executor's bundle otherwise.
 */
export async function persistErrorMessage(
  conversationId: string,
  errorContent: string,
  options: { model?: string; provider?: string; parentMessageId?: string },
  runId: string,
  persist: boolean,
): Promise<void> {
  if (!persist) return;
  try {
    const { createMessage } = await import("../db/queries/conversations");
    const errorMsg = await createMessage(conversationId, {
      role: "assistant",
      content: errorContent,
      model: options.model,
      provider: options.provider,
      runId,
      parentMessageId: options.parentMessageId,
    });

    // Fix tool call anchoring for error messages too
    await getDb()
      .update(toolCalls)
      .set({ messageId: errorMsg.id })
      .where(and(eq(toolCalls.conversationId, conversationId), eq(toolCalls.messageId, runId)));
    await getDb()
      .update(toolCalls)
      .set({ messageId: errorMsg.id })
      .where(and(eq(toolCalls.conversationId, conversationId), isNull(toolCalls.messageId)));
  } catch (err) {
    log.error("Failed to persist error message", { error: String(err) });
  }
}
