import { Agent } from "@earendil-works/pi-agent-core";
import type { Message } from "../../types";
import { resolveOAuthModel } from "../../providers/registry";
import { getCredential } from "../../providers/credentials";
import type { StreamChatContext } from "./context";
import type { SetupToolsResult } from "./setup-tools";
import { makeCompactionTransform, type CompactionConfig } from "./context-compaction";
import { makeSummarizer } from "./context-summarize";
import {
  applyCacheRetention,
  DEFAULT_CACHE_RETENTION,
  type CacheRetention,
} from "./cache-retention";
import { appendMemoryTailBlock } from "./system-cache-split";

/** Subset of streamChat's options the pi-agent construction reads. */
export interface BuildPiAgentOptions {
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /**
   * Per-model history-compaction overrides (resolved from settings by
   * the streamChat entry). Omitted keys fall back to module DEFAULTS.
   */
  compaction?: Partial<CompactionConfig>;
  /**
   * Prompt-cache retention for the stable prefix (resolved from the
   * `compaction:cacheRetention` setting). Omitted → {@link DEFAULT_CACHE_RETENTION}
   * (`"long"` — keep the system/tools/anchor prefix warm for ~1h).
   */
  cacheRetention?: CacheRetention;
}

/**
 * Resolve the OAuth-compatible model (when applicable) and construct the
 * pi-agent for this turn. The OAuth swap is necessary because the
 * standard API endpoints (google-generative-ai, openai-responses) use
 * API key auth which is incompatible with OAuth tokens — we need the
 * subscription-eligible Model object so the correct API + endpoint +
 * metadata is wired in.
 *
 * Pure function — touches `ctx.system` + `ctx.systemMemoryTail` +
 * `ctx.agentTools` for read only,
 * does NOT subscribe (that's {@link subscribeBridge}'s job). Callers
 * register the agent on the host's `activeAgents` map themselves so the
 * cancel + watchdog paths can `.abort()` it.
 */
export function buildPiAgent(
  ctx: StreamChatContext,
  history: Message[],
  options: BuildPiAgentOptions,
  resolvedModel: SetupToolsResult,
  credentialConversationId: string,
  // The TRUE conversation id (a sub-agent's `credentialConversationId` is its
  // parent's). Used to namespace the summarizer's memo so sibling
  // sub-conversations don't read each other's summaries.
  conversationId: string,
): Agent {
  const { resolved, initialCred } = resolvedModel;

  // When using OAuth, the standard API endpoints (google-generative-ai, openai-responses)
  // use API key auth which is incompatible with OAuth tokens. Resolve the actual
  // OAuth-compatible Model object so the correct API + endpoint + metadata is used.
  let model = resolved.piModel;
  if (initialCred.type === "oauth") {
    const oauthModel = resolveOAuthModel(resolved.provider, model.id);
    if (oauthModel) {
      // Keep the original provider name so credential lookups (getApiKey callback)
      // resolve against "openai"/"google", not "openai-codex"/"google-gemini-cli".
      // `Provider = KnownProvider | string` in pi-ai, so the assignment is safe
      // without a cast.
      model = { ...oauthModel, provider: resolved.provider };
    } else if (resolved.provider === "google" || resolved.provider === "openai") {
      throw new Error(
        `Model "${model.id}" is not supported with ${resolved.provider} OAuth. ` +
        `Only subscription-eligible models are available with OAuth authentication.`,
      );
    }
  }

  // Prefix-cache retention for THIS turn. Anthropic caches the system
  // prompt + tools + conversation prefix; a long TTL keeps that stable
  // prefix warm across inter-turn pauses. `compat.supportsLongCacheRetention`
  // mirrors pi-ai's own guard (undefined ⇒ supported for non-Fireworks).
  const cacheRetention = options.cacheRetention ?? DEFAULT_CACHE_RETENTION;
  const supportsLongRetention =
    (model as { compat?: { supportsLongCacheRetention?: boolean } }).compat
      ?.supportsLongCacheRetention !== false;

  // System-block cache split (see system-cache-split.ts). pi-ai stamps
  // `api: "anthropic-messages"` on every Anthropic Model (its provider
  // registration in providers/anthropic.js), including the OAuth swap above.
  // Failover-correct by construction: each attempt calls buildPiAgent with
  // its own resolved model, so the closures below capture THAT attempt's
  // gate — an Anthropic→OpenAI fallback merges the tail into the prompt
  // string, never leaving it behind in a stale onPayload.
  //
  // - Anthropic: systemPrompt = frozen ctx.system only; the query-dependent
  //   memory/KB tail is appended in onPayload as a separate UNCACHED
  //   trailing system block, so region-1 (system + tools) stays byte-stable.
  // - Non-Anthropic: no cache_control concept to protect — merge the tail
  //   into the systemPrompt string. Memory lands after the task block
  //   (a benign reorder vs the pre-split concatenation); onPayload stays a
  //   strict wire no-op for these providers, like applyCacheRetention.
  const isAnthropic = model.api === "anthropic-messages";
  const memoryTail = ctx.systemMemoryTail;

  return new Agent({
    initialState: {
      systemPrompt: isAnthropic ? (ctx.system ?? "") : (ctx.system ?? "") + (memoryTail ?? ""),
      model,
      tools: ctx.agentTools,
      messages: history,
      thinkingLevel: options.thinkingLevel ?? (model.reasoning ? "medium" : "off"),
    },
    // Pin pi's default retry-delay cap (60s) explicitly — a purely
    // DEFENSIVE pin, not a behavior change. What this knob actually does
    // (verified against pi-ai source): only the openai-codex provider
    // reads it, and only for 429s — it caps the server-requested backoff
    // at min(delay, cap) and then SLEEPS + RETRIES IN-BAND (it does NOT
    // fail fast to our failover; 5xx retry-after is honored uncapped).
    // Pinning the current default means an upstream default change can't
    // silently lengthen how long a codex 429 blocks before pi's own
    // retries exhaust and runWithFailover finally sees the error. See
    // @earendil-works/pi-ai providers/openai-codex-responses capRetryDelayMs.
    maxRetryDelayMs: 60_000,
    // Per-model context-window compaction. Runs before every LLM call
    // (initial turn + each agentic tool-loop iteration + retries), so a
    // long thread no longer dead-ends on `context_length_exceeded`.
    // Input-only — the model is never mutated. The summarizer is bound to
    // this turn's model + credential; it is only invoked when the
    // `summarize` strategy is selected (a no-op closure otherwise).
    transformContext: makeCompactionTransform(model, options.compaction, {
      summarize: makeSummarizer(model, conversationId, credentialConversationId),
    }),
    convertToLlm: (messages) => {
      return messages.filter((m) =>
        "role" in m && (m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
      ) as Message[];
    },
    getApiKey: async (provider) => {
      const freshCred = await getCredential(provider, credentialConversationId);
      return freshCred.token;
    },
    onPayload: async (body) => {
      // Force reasoning summaries so thinking text is visible to the user.
      // pi-ai types `body` as `unknown` — narrow to the loose provider
      // payload shape before poking at the reasoning sub-object.
      const payload = body as { reasoning?: { summary?: string } } | undefined;
      if (payload?.reasoning && payload.reasoning.summary === "auto") {
        payload.reasoning.summary = "detailed";
      }
      // Anthropic only: append the volatile memory/KB tail as the LAST
      // system block, with NO cache_control — BEFORE retention shaping so
      // the frozen prefix blocks keep their breakpoints untouched.
      if (isAnthropic) appendMemoryTailBlock(body, memoryTail);
      // Shape prompt-cache retention: 1h TTL on the stable prefix (system +
      // tools), tail stays short. No-op for non-Anthropic payloads.
      return applyCacheRetention(body, supportsLongRetention, cacheRetention);
    },
  });
}
