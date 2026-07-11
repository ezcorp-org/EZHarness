/**
 * The `summarize` context-compaction strategy.
 *
 * Where the default `trim` strategy (context-compaction.ts) evicts whole
 * turn blocks and leaves a "N messages omitted" marker, `summarize`
 * replaces the evicted OLDER turns with an LLM-generated summary, keeping as
 * much RECENT verbatim context as the per-model budget allows:
 *
 *   [ summary marker ][ …recent turns… ][ active turn ]
 *
 * It reuses the shared turn-block + budget machinery from
 * context-compaction.ts; the only new behavior is summarizing the older
 * body via pi-agent-core's `generateSummary` helper, whose actual network
 * call is routed through the mockable compat `complete` seam (see
 * {@link makeSummarizer}) so tests stay deterministic.
 *
 * Guarantees carried over from `trim`:
 * - INPUT-ONLY: only the message array handed to the provider for one call
 *   is rewritten; `model.maxTokens` is never mutated. The summary marker,
 *   like the trim marker, is ephemeral — never persisted, never rendered.
 * - FAIL-OPEN: any summarization failure/timeout falls back to the `trim`
 *   strategy for that call, so a wedged summarizer never blocks the turn.
 *
 * MEMOIZATION (v1): a bounded, in-process memo keyed by conversation + a
 * fingerprint of the exact messages being summarized avoids re-calling the
 * LLM across the many `transformContext` invocations WITHIN a turn (the
 * agentic tool loop + retries) and across short-term identical cut points.
 * Durable / cross-turn incremental summaries (pi's `previousSummary`
 * threading) are OUT of scope — see docs/context-compaction.md.
 *
 * Unlike anchored `trim`, `summarize` is NOT prompt-cache-friendly: the
 * summary marker leads and its text changes as the thread grows, so it
 * shifts the cached prefix. Operators who need cache stability on long
 * threads should use `trim` with `cacheAnchorFraction > 0`.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  Models,
  Context,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { Model as PiModel } from "../../types";
import { logger } from "../../logger";
import {
  estimateMessageTokens,
  getCompactionStrategy,
  isCompactionMarker,
  registerCompactionStrategy,
  MARKER_PREFIX,
  type CompactionContext,
  type CompactionResult,
  type CompactionStrategy,
  type SummarizeFn,
} from "./context-compaction";

/** pi-ai's `Model` is generic over its API; we only read metadata. */
type Model = PiModel<any>;
const log = logger.child("compaction.summarize");

/** Token pad reserved for the summary marker's prefix text (on top of the
 *  summary body, which is bounded by `cfg.summarizeMaxTokens`). */
const SUMMARY_MARKER_OVERHEAD = 32;

// ── Ephemeral summary marker ─────────────────────────────────────────
// Shares the trim marker's `[Context note:` prefix so isCompactionMarker
// strips it too — a stray marker never accumulates or skews estimates.
function makeSummaryMarker(count: number, summary: string, budget: number): AgentMessage {
  const plural = count === 1 ? "" : "s";
  const content = `${MARKER_PREFIX} ${count} earlier message${plural} summarized to fit this model's ~${budget}-token context window.]\n\n${summary}`;
  return { role: "user", content, timestamp: Date.now() };
}

// ── Bounded in-process summary memo ──────────────────────────────────
const SUMMARY_MEMO = new Map<string, string>();
const SUMMARY_MEMO_CAP = 256;

function memoSet(key: string, value: string): void {
  // Insertion-ordered eviction: drop the oldest entry once full.
  if (SUMMARY_MEMO.size >= SUMMARY_MEMO_CAP && !SUMMARY_MEMO.has(key)) SUMMARY_MEMO.delete(SUMMARY_MEMO.keys().next().value as string);
  SUMMARY_MEMO.set(key, value);
}

/**
 * Cheap deterministic fingerprint of the exact messages to summarize:
 * role + per-message token estimate, FNV-1a hashed, plus the count. The
 * same cut point → same key → memo hit. A hash collision only reuses a
 * stale summary within one conversation (bounded, low harm).
 */
function fingerprint(messages: AgentMessage[]): string {
  let h = 0x811c9dc5;
  for (const m of messages) {
    const sig = `${"role" in m ? m.role : "?"}:${estimateMessageTokens(m)}`;
    for (let i = 0; i < sig.length; i++) {
      h ^= sig.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return `${messages.length}:${(h >>> 0).toString(16)}`;
}

// ── Strategy ─────────────────────────────────────────────────────────

class SummarizeStrategy implements CompactionStrategy {
  readonly name = "summarize";

  async compact(
    messages: AgentMessage[],
    ctx: CompactionContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    // Every degenerate / failure path falls open to the deterministic trim
    // strategy, which can always fit the budget (evicting + truncating).
    const trim = () => getCompactionStrategy("trim").compact(messages, ctx, signal);
    if (!ctx.summarize) return trim();

    // Drop prior markers so they neither accumulate nor skew estimates.
    const base = messages.filter((m) => !isCompactionMarker(m));
    const blocks = ctx.splitTurnBlocks(base);
    // Need at least one older block beyond the always-kept active turn;
    // otherwise there is nothing to summarize that trim can't handle.
    if (blocks.length <= 1) return trim();

    const active = blocks[blocks.length - 1]!;
    const body = blocks.slice(0, -1);

    // Keep as much RECENT verbatim context as fits after reserving room for
    // the (mandatory) active turn + the summary marker; summarize the rest.
    const summaryReserve = ctx.cfg.summarizeMaxTokens + SUMMARY_MARKER_OVERHEAD;
    const recentBudget = Math.max(1, ctx.budget - summaryReserve - ctx.estimateTokens(active));
    let tail: AgentMessage[] = [...active];
    let t = body.length - 1;
    while (t >= 0) {
      const candidate = [...body[t]!, ...tail];
      if (ctx.estimateTokens(candidate) > recentBudget) break;
      tail = candidate;
      t--;
    }

    const toSummarize = body.slice(0, t + 1).flat();
    if (toSummarize.length === 0) return trim();

    const summary = await ctx.summarize(toSummarize, {
      reserveTokens: ctx.cfg.summarizeMaxTokens,
      signal,
    });
    if (!summary) return trim();

    const droppedTokens = ctx.estimateTokens(toSummarize);
    const assembled = [makeSummaryMarker(toSummarize.length, summary, ctx.budget), ...tail];
    // Summary + recent + active must still fit; if the summary overshot its
    // reserve (or the active turn alone is oversized), fall open to trim,
    // which truncates oversized toolResults as a last resort.
    if (ctx.estimateTokens(assembled) > ctx.budget) return trim();
    return { messages: assembled, droppedCount: toSummarize.length, droppedTokens, strategy: this.name };
  }
}

registerCompactionStrategy(new SummarizeStrategy());

// ── Default LLM summarizer ───────────────────────────────────────────

/**
 * Resolve the model + credential the summarizer should use: the
 * `compaction:summarizeModel` setting (`"provider/modelId"`) when set and
 * resolvable, else the conversation's own turn model. Reusing the turn
 * model is the zero-config default and is always available — the turn is
 * already streaming with it.
 */
async function resolveSummarizerModel(
  turnModel: Model,
  conversationId: string,
): Promise<{ model: Model; apiKey: string }> {
  const { getSetting } = await import("../../db/queries/settings");
  const { getCredential } = await import("../../providers/credentials");
  const pick = await getSetting("compaction:summarizeModel");
  if (typeof pick === "string" && pick.indexOf("/") > 0) {
    const slash = pick.indexOf("/");
    const provider = pick.slice(0, slash);
    const modelId = pick.slice(slash + 1);
    try {
      const { resolveModel } = await import("../../providers/router");
      const r = await resolveModel(provider, modelId);
      const cred = await getCredential(r.provider, conversationId);
      return { model: r.piModel, apiKey: cred.token };
    } catch (err) {
      log.warn("summarizeModel resolve failed; using the turn model", { pick, error: String(err) });
    }
  }
  const cred = await getCredential(turnModel.provider, conversationId);
  return { model: turnModel, apiKey: cred.token };
}

/**
 * Build the default {@link SummarizeFn} bound to this turn's model +
 * credential conversation. Produces a summary of the given older messages,
 * or `null` on any failure (the strategy then fails open to `trim`).
 *
 * Routes through pi's `generateSummary` over a minimal `Models` shim that
 * injects the resolved credential and delegates to the mockable compat
 * `complete`. `generateSummary` only ever calls `models.completeSimple`, so
 * the single-method shim is sufficient. Summaries run with thinking off
 * (cheap, deterministic-ish) and are memoized per conversation + cut point.
 */
export function makeSummarizer(turnModel: Model, conversationId: string): SummarizeFn {
  return async (messages, opts) => {
    const key = `${conversationId} ${fingerprint(messages)}`;
    const cached = SUMMARY_MEMO.get(key);
    if (cached !== undefined) return cached;
    try {
      const { model, apiKey } = await resolveSummarizerModel(turnModel, conversationId);
      const { generateSummary } = await import("@earendil-works/pi-agent-core");
      const { complete } = await import("@earendil-works/pi-ai/compat");
      const models = {
        completeSimple: (m: Model, context: Context, o?: SimpleStreamOptions) =>
          complete(m, context, { ...o, apiKey }),
      } as unknown as Models;
      const result = await generateSummary(messages, models, model, opts.reserveTokens, opts.signal, undefined, undefined, "off");
      if (!result.ok) {
        log.warn("summary generation failed; falling back to trim", { reason: result.error.message });
        return null;
      }
      const text = result.value.trim();
      if (!text) return null;
      memoSet(key, text);
      return text;
    } catch (err) {
      log.warn("summary generation threw; falling back to trim", { error: String(err) });
      return null;
    }
  };
}
