/**
 * Per-model conversation-history compaction.
 *
 * EZCorp re-sends the full branch history to the provider on every LLM
 * call (initial turn + every agentic tool-loop iteration). Once a thread
 * crosses the model's context window the provider rejects every
 * subsequent send (`context_length_exceeded`) and the chat dead-ends.
 *
 * This module computes a per-model input-token budget from the resolved
 * model's own `contextWindow` (reserving headroom for output/reasoning)
 * and trims history to fit BEFORE it reaches the provider. It is wired
 * via pi-agent-core's `transformContext` hook in `build-pi-agent.ts`,
 * which runs ahead of every LLM call.
 *
 * The trimming algorithm is a swappable {@link CompactionStrategy}: the
 * default `trim` evicts oldest whole turns + leaves a marker; `none`
 * disables it. A future LLM `summarize` strategy drops in via
 * {@link registerCompactionStrategy} with no rewiring.
 *
 * Trimming is INPUT-ONLY. `model.maxTokens` is never mutated — for the
 * Codex API it is metadata only (no `max_output_tokens` is sent), and
 * for other providers pi-ai already clamps output sanely; shrinking it
 * would be a cross-provider output-truncation regression.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model as PiModel, Message, UserMessage } from "../../types";
import { logger } from "../../logger";

/** pi-ai's `Model` is generic over its API; we only read metadata. */
type Model = PiModel<any>;

// ── Config ───────────────────────────────────────────────────────────

export interface CompactionConfig {
  /** Registered strategy name. `"trim"` (default) or `"none"`. */
  strategy: string;
  /** Upper bound on output headroom reserved from the context window. */
  responseReserveCap: number;
  /** Lower bound on that reservation. */
  responseReserveFloor: number;
  /** Fraction of the context window held back to absorb estimator error. */
  safetyFraction: number;
  /** Heuristic chars-per-token divisor for the token estimate. */
  charsPerToken: number;
  /** Flat token cost charged per image part. */
  imageTokens: number;
  /**
   * Fraction of the input budget the `trim` strategy reserves for a
   * BYTE-STABLE prefix of the OLDEST whole turns (the "cache anchor").
   * This bound depends only on the (per-model, per-cfg) budget and the
   * immutable oldest history, so the anchor is identical every turn and
   * stays warm in the provider's prefix cache even as newer turns are
   * evicted. `0` disables the anchor (recent-only trim, marker at front —
   * the pre-cache-aware behavior). Clamped to `[0, 1]`.
   */
  cacheAnchorFraction: number;
}

export const DEFAULTS: CompactionConfig = {
  strategy: "trim",
  responseReserveCap: 16_000,
  responseReserveFloor: 1_024,
  safetyFraction: 0.08,
  charsPerToken: 4,
  imageTokens: 1_200,
  cacheAnchorFraction: 0.5,
};

const PER_MESSAGE_OVERHEAD = 4;
const MARKER_PREFIX = "[Context note:";
const TRUNCATION_MARK = "…[truncated to fit context]…";

// ── Token estimation ─────────────────────────────────────────────────

/** LLM-visible messages — mirrors the `convertToLlm` filter in build-pi-agent. */
function isLlmMessage(m: AgentMessage): m is Message {
  return (
    "role" in m &&
    (m.role === "user" || m.role === "assistant" || m.role === "toolResult")
  );
}

export function estimateMessageTokens(
  m: AgentMessage,
  cfg: CompactionConfig = DEFAULTS,
): number {
  if (!isLlmMessage(m)) return 0;
  let chars = 0;
  let images = 0;
  const addText = (t: string | undefined) => {
    if (t) chars += t.length;
  };

  if (m.role === "user") {
    if (typeof m.content === "string") {
      addText(m.content);
    } else {
      for (const part of m.content) {
        if (part.type === "text") addText(part.text);
        else if (part.type === "image") images++;
      }
    }
  } else if (m.role === "assistant") {
    for (const part of m.content) {
      if (part.type === "text") addText(part.text);
      else if (part.type === "thinking") addText(part.thinking);
      else if (part.type === "toolCall") {
        addText(part.name);
        addText(JSON.stringify(part.arguments ?? {}));
      }
    }
  } else {
    // toolResult
    addText(m.toolName);
    for (const part of m.content) {
      if (part.type === "text") addText(part.text);
      else if (part.type === "image") images++;
    }
  }

  return (
    PER_MESSAGE_OVERHEAD +
    Math.ceil(chars / cfg.charsPerToken) +
    images * cfg.imageTokens
  );
}

export function estimateTokens(
  messages: AgentMessage[],
  cfg: CompactionConfig = DEFAULTS,
): number {
  let sum = 0;
  for (const m of messages) sum += estimateMessageTokens(m, cfg);
  return sum;
}

// ── Turn blocks ──────────────────────────────────────────────────────

/**
 * Split into turn blocks. A block = a `user` message + every following
 * non-user message (assistant / toolResult / custom) up to the next
 * `user` message. The LAST block is the active turn (current user
 * prompt + its in-flight tool loop); evicting whole blocks keeps
 * toolCall/toolResult pairs intact.
 */
export function splitTurnBlocks(messages: AgentMessage[]): AgentMessage[][] {
  const blocks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  for (const m of messages) {
    const isUser = "role" in m && m.role === "user";
    if (isUser && current.length > 0) {
      blocks.push(current);
      current = [];
    }
    current.push(m);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

// ── Budget math ──────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Clamp a fraction into `[0, 1]` (a non-finite value floors to 0). */
function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Output headroom subtracted from the context window. Derived from the
 * model's own `maxTokens`, clamped to [floor, cap]. Never written back
 * to the model — budgeting only.
 */
export function computeResponseReserve(
  model: Pick<Model, "maxTokens">,
  cfg: CompactionConfig = DEFAULTS,
): number {
  const maxOut =
    typeof model.maxTokens === "number" && model.maxTokens > 0
      ? model.maxTokens
      : cfg.responseReserveCap;
  return clamp(maxOut, cfg.responseReserveFloor, cfg.responseReserveCap);
}

/** Per-model input-token budget: contextWindow − reserve − safety margin. */
export function computeInputBudget(
  model: Pick<Model, "maxTokens" | "contextWindow">,
  cfg: CompactionConfig = DEFAULTS,
): number {
  const ctxWindow =
    typeof model.contextWindow === "number" && model.contextWindow > 0
      ? model.contextWindow
      : 128_000;
  const reserve = computeResponseReserve(model, cfg);
  const margin = Math.ceil(ctxWindow * cfg.safetyFraction);
  return Math.max(1, ctxWindow - reserve - margin);
}

// ── Marker ───────────────────────────────────────────────────────────

function makeMarker(droppedCount: number, budget: number): UserMessage {
  const plural = droppedCount === 1 ? "" : "s";
  return {
    role: "user",
    content: `${MARKER_PREFIX} ${droppedCount} earlier message${plural} omitted to fit this model's ~${budget}-token context window.]`,
    timestamp: Date.now(),
  };
}

/** A previously-injected compaction marker (so they never accumulate). */
export function isCompactionMarker(m: AgentMessage): boolean {
  return (
    "role" in m &&
    m.role === "user" &&
    typeof (m as UserMessage).content === "string" &&
    ((m as UserMessage).content as string).startsWith(MARKER_PREFIX)
  );
}

// ── Strategy interface + registry ────────────────────────────────────

export interface CompactionContext {
  model: Model;
  budget: number;
  cfg: CompactionConfig;
  estimateTokens: (m: AgentMessage[]) => number;
  splitTurnBlocks: (m: AgentMessage[]) => AgentMessage[][];
}

export interface CompactionResult {
  messages: AgentMessage[];
  droppedCount: number;
  droppedTokens: number;
  strategy: string;
}

export interface CompactionStrategy {
  readonly name: string;
  compact(
    messages: AgentMessage[],
    ctx: CompactionContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult>;
}

const REGISTRY = new Map<string, CompactionStrategy>();

export function registerCompactionStrategy(strategy: CompactionStrategy): void {
  REGISTRY.set(strategy.name, strategy);
}

export function getCompactionStrategy(name: string): CompactionStrategy {
  const found = REGISTRY.get(name);
  if (found) return found;
  logger.warn("unknown compaction strategy; falling back to 'trim'", {
    requested: name,
  });
  return REGISTRY.get("trim")!;
}

export function listCompactionStrategies(): string[] {
  return [...REGISTRY.keys()];
}

// ── Built-in strategies ──────────────────────────────────────────────

/**
 * Truncate the oldest oversized `toolResult` text contents in-place
 * (oldest-first) until the array fits, or no more candidates remain.
 * Never touches user-prompt or assistant text — silently mangling the
 * user's actual question is worse than a precise overflow error, which
 * the pi-ai `isContextOverflow` path still surfaces as a backstop.
 */
function truncateOversizedToolResults(
  messages: AgentMessage[],
  ctx: CompactionContext,
): { messages: AgentMessage[]; truncatedTokens: number } {
  const out = [...messages];
  let truncatedTokens = 0;
  for (let i = 0; i < out.length; i++) {
    if (ctx.estimateTokens(out) <= ctx.budget) break;
    const m = out[i]!;
    if (!("role" in m) || m.role !== "toolResult") continue;
    const before = ctx.estimateTokens([m]);
    const truncated: AgentMessage = {
      ...m,
      content: [{ type: "text", text: TRUNCATION_MARK }],
    };
    out[i] = truncated;
    truncatedTokens += before - ctx.estimateTokens([truncated]);
  }
  return { messages: out, truncatedTokens };
}

/**
 * Cache-aware trim.
 *
 * Anthropic's prompt cache is PREFIX-matched: the provider serves from
 * cache the longest byte-identical leading run of a request that a recent
 * request already cached. The naive trim (evict the OLDEST turns, prepend
 * a per-turn-changing marker at index 0) mutates that prefix on every
 * compacted turn → a guaranteed cache MISS on the whole conversation body
 * plus a 25% cache-WRITE surcharge, i.e. a possible net cost *increase* on
 * long threads.
 *
 * This strategy keeps a BYTE-STABLE prefix so caching pays off:
 *
 *   [ …oldest anchor blocks… ][ marker ][ …recent blocks… ][ active turn ]
 *     └── stable across turns ┘           └── shifts (uncached) ──┘
 *
 *   1. ANCHOR — the oldest whole turn blocks, greedily kept up to
 *      `cacheAnchorFraction × budget`. That bound depends only on the
 *      per-model budget and the immutable oldest history, so the anchor is
 *      byte-identical every turn and its prefix stays warm in the cache.
 *   2. RECENT window + the (always-kept) active turn fill the remaining
 *      budget from the NEWEST blocks, so recent context is preserved.
 *   3. The MIDDLE is evicted; the omission marker is placed AFTER the
 *      anchor (never at index 0 when an anchor exists) so its
 *      per-turn-changing text can't shift the cached region.
 *
 * The system prompt + tool/RBAC schemas + extension registry (pi-ai's
 * separate `system`/`tools` cache breakpoints) are never touched by trim
 * and remain the outermost stable prefix; this strategy additionally keeps
 * the FRONT of the conversation body stable. Retention (1h vs 5m) for the
 * stable prefix is wired separately in `cache-retention.ts`.
 */
class TrimStrategy implements CompactionStrategy {
  readonly name = "trim";

  async compact(
    messages: AgentMessage[],
    ctx: CompactionContext,
  ): Promise<CompactionResult> {
    const noop: CompactionResult = {
      messages,
      droppedCount: 0,
      droppedTokens: 0,
      strategy: this.name,
    };

    // Drop prior markers so they neither accumulate nor skew estimates.
    const base = messages.filter((m) => !isCompactionMarker(m));
    const blocks = ctx.splitTurnBlocks(base);
    if (blocks.length === 0) return noop;

    // The active turn (current prompt + its in-flight tool loop) is ALWAYS
    // kept intact; the rest of the history is the droppable/anchorable body.
    const active = blocks[blocks.length - 1]!;
    const body = blocks.slice(0, -1);

    // Reserve the marker's own token cost so [anchor + marker + tail] — not
    // just the survivors — fits the budget. The message count bounds its digits.
    const markerCost = estimateMessageTokens(
      makeMarker(base.length, ctx.budget),
      ctx.cfg,
    );

    // ── 1. Stable oldest ANCHOR ───────────────────────────────────────
    // Cap the anchor by BOTH the configured fraction AND the room left for
    // the (mandatory) active turn + marker, so the anchor can never starve
    // the active turn. For a small active turn + a sane fraction (≤ ~0.5)
    // the fraction term binds — a per-model-budget constant — keeping the
    // anchor byte-stable across turns; the active-room term only binds in
    // the pathological "active turn ≈ the whole budget" case.
    const anchorCap = Math.min(
      Math.floor(ctx.budget * clamp01(ctx.cfg.cacheAnchorFraction)),
      Math.max(0, ctx.budget - markerCost - ctx.estimateTokens(active)),
    );
    const anchorBlocks: AgentMessage[][] = [];
    let a = 0;
    while (a < body.length) {
      const candidate = [...anchorBlocks.flat(), ...body[a]!];
      if (ctx.estimateTokens(candidate) > anchorCap) break;
      anchorBlocks.push(body[a]!);
      a++;
    }
    const anchor = anchorBlocks.flat();

    // ── 2. Recent WINDOW (newest droppable blocks) + the active turn ──
    const tailBudget = Math.max(
      1,
      ctx.budget - markerCost - ctx.estimateTokens(anchor),
    );
    let tail: AgentMessage[] = [...active];
    let t = body.length - 1;
    while (t >= a) {
      const candidate = [...body[t]!, ...tail];
      if (ctx.estimateTokens(candidate) > tailBudget) break;
      tail = candidate;
      t--;
    }

    // Evicted middle = the blocks between the anchor and the recent window.
    const droppedMsgs = body.slice(a, t + 1).flat();
    const droppedTokens = ctx.estimateTokens(droppedMsgs);

    // Nothing to drop and it already fits → identity no-op.
    if (
      droppedMsgs.length === 0 &&
      ctx.estimateTokens([...anchor, ...tail]) <= ctx.budget
    ) {
      return noop;
    }

    // Marker sits AFTER the stable anchor (only when we actually dropped
    // something). With an empty anchor (`cacheAnchorFraction: 0` or a
    // single oversized oldest block) it naturally lands at the front —
    // the cache can't be helped there anyway.
    const marker =
      droppedMsgs.length > 0 ? makeMarker(droppedMsgs.length, ctx.budget) : undefined;
    const assemble = (tailPart: AgentMessage[]): AgentMessage[] =>
      marker ? [...anchor, marker, ...tailPart] : [...anchor, ...tailPart];

    const assembled = assemble(tail);
    if (ctx.estimateTokens(assembled) <= ctx.budget) {
      return {
        messages: assembled,
        droppedCount: droppedMsgs.length,
        droppedTokens,
        strategy: this.name,
      };
    }

    // Still over budget (a single oversized block in the recent window, or
    // the active turn alone). Truncate oversized toolResults in the
    // NON-anchor region so the stable anchor stays byte-identical.
    const truncated = truncateOversizedToolResults(tail, ctx);
    return {
      messages: assemble(truncated.messages),
      droppedCount: droppedMsgs.length,
      droppedTokens: droppedTokens + truncated.truncatedTokens,
      strategy: this.name,
    };
  }
}

class NoneStrategy implements CompactionStrategy {
  readonly name = "none";
  async compact(messages: AgentMessage[]): Promise<CompactionResult> {
    return { messages, droppedCount: 0, droppedTokens: 0, strategy: this.name };
  }
}

registerCompactionStrategy(new TrimStrategy());
registerCompactionStrategy(new NoneStrategy());

// ── transformContext factory ─────────────────────────────────────────

/**
 * Build the pi-agent-core `transformContext` hook for `model`. Returns
 * messages untouched while under budget; otherwise runs the configured
 * strategy. Resolved once per turn in `build-pi-agent.ts`.
 */
export function makeCompactionTransform(
  model: Model,
  override?: Partial<CompactionConfig>,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const cfg: CompactionConfig = { ...DEFAULTS, ...(override ?? {}) };
  const budget = computeInputBudget(model, cfg);
  const strategy = getCompactionStrategy(cfg.strategy);

  return async (messages, signal) => {
    if (estimateTokens(messages, cfg) <= budget) return messages;

    const ctx: CompactionContext = {
      model,
      budget,
      cfg,
      estimateTokens: (m) => estimateTokens(m, cfg),
      splitTurnBlocks,
    };
    const res = await strategy.compact(messages, ctx, signal);

    logger.warn("context compaction applied", {
      strategy: res.strategy,
      model: model.id,
      budget,
      before: messages.length,
      after: res.messages.length,
      droppedCount: res.droppedCount,
      droppedTokens: res.droppedTokens,
    });
    return res.messages;
  };
}
