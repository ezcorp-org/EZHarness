import { stream, complete, type Context } from "@earendil-works/pi-ai";
import { resolveModel } from "../providers/router";
import { tierForModel } from "../providers/registry";
import { isRoutingTier } from "./tier-classifier";
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
  stream(
    messages: PiLlmMessage[],
    options?: PiLlmOptions,
  ): AsyncGenerator<PiLlmStreamEvent>;
}

/**
 * Build the pi-ai-backed LLM wrapper used by **code-based agents** (the
 * `runAgent` path — distinct from `streamChat`, which constructs its
 * pi-agent-core `Agent` directly).
 *
 * Pure factory — no executor state. Resolves provider + credential per
 * call so model overrides on each invocation work.
 */
export function createPiLlmAdapter(): PiLlmAdapter {
  return {
    async complete(messages, options) {
      const resolved = await resolveModel(options?.provider, options?.model);
      const cred = await getCredential(resolved.provider);
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
      const result = await complete(resolved.piModel, context, { apiKey: cred.token });
      const text = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      return { text, usage: { inputTokens: result.usage.input, outputTokens: result.usage.output } };
    },
    async *stream(messages, options) {
      const resolved = await resolveModel(options?.provider, options?.model);
      const cred = await getCredential(resolved.provider);
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
      const s = stream(resolved.piModel, context, { apiKey: cred.token, signal: options?.signal });
      for await (const event of s) {
        if (event.type === "text_delta") yield { type: "token", text: event.delta };
        if (event.type === "done") yield { type: "done", usage: { inputTokens: event.message.usage.input, outputTokens: event.message.usage.output } };
        if (event.type === "error") {
          // pi-ai's error event carries a partial AssistantMessage whose
          // content array mixes TextContent / ThinkingContent / ToolCall.
          // Filter to text parts for the surfaced error string.
          const errText = event.error.content
            ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("") ?? "Stream error";
          yield { type: "error", error: errText };
        }
      }
    },
  };
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
      .where(and(
        eq(toolCalls.conversationId, conversationId),
        eq(toolCalls.messageId, runId),
      ));
    await getDb()
      .update(toolCalls)
      .set({ messageId: errorMsg.id })
      .where(and(
        eq(toolCalls.conversationId, conversationId),
        isNull(toolCalls.messageId),
      ));
  } catch (err) {
    log.error("Failed to persist error message", { error: String(err) });
  }
}
