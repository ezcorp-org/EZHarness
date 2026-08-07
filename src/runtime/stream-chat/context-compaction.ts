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
 * Independent of the budget, {@link capStaleToolResults} bounds STALE tool
 * results on every call. That one is a cost control, not an overflow guard:
 * fitting the window is free of charge, but re-sending a multi-megabyte tool
 * result on every loop iteration is not.
 *
 * Trimming is INPUT-ONLY. `model.maxTokens` is never mutated — for the
 * Codex API it is metadata only (no `max_output_tokens` is sent), and
 * for other providers pi-ai already clamps output sanely; shrinking it
 * would be a cross-provider output-truncation regression.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  Message,
  UserMessage,
  ToolResultMessage,
  TextContent,
  ImageContent,
} from "../../types";
import type { AnyModel } from "../../providers/model-types";
import { logger } from "../../logger";
import { CHARS_PER_TOKEN_ESTIMATE, DEFAULT_TOOL_RESULT_CAP } from "./tool-result-cap";

/** pi-ai's `Model` is generic over its API; we only read metadata off it.
 *  `AnyModel` is the shared alias that carries the reason that parameter
 *  can't be narrowed (src/providers/model-types.ts). */
type Model = AnyModel;

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
   * evicted. `0` (the default) disables the anchor: conventional
   * recent-only trim (evict the OLDEST turns), marker at front. The anchor
   * is opt-in because it only helps threads long enough to trigger
   * compaction, and it does so by PINNING the stalest turns (evicting the
   * more-relevant middle) — a cache-vs-recency tradeoff operators opt into.
   * The broad cache win (1h retention on the system+tools+memory prefix, see
   * cache-retention.ts) is independent of this and applies at `0`. See
   * docs/decisions/2026-07-08-compaction-cache-anchor.md. Clamped to `[0, 1]`.
   */
  cacheAnchorFraction: number;
  /**
   * Output-token cap for the `summarize` strategy's LLM summary. Doubles as
   * the budget the strategy reserves for the inserted summary marker, so the
   * recent verbatim window is sized around it. Ignored by `trim`/`none`.
   */
  summarizeMaxTokens: number;
  /**
   * Max characters of text kept in a STALE (non-newest) `toolResult`, applied
   * on EVERY call regardless of the budget — see {@link capStaleToolResults}.
   * This is a pure COST control, not an overflow guard: a fat tool result is
   * re-sent verbatim on every subsequent agentic-loop iteration and every
   * later turn, so bounding it pays even while the thread comfortably fits.
   * Strategy-independent (`strategy: "none"` does NOT disable it); `0` (or any
   * non-positive / non-finite value) disables it, restoring the pre-cap
   * behaviour byte-for-byte.
   */
  toolResultCap: number;
}

export const DEFAULTS: CompactionConfig = {
  strategy: "trim",
  responseReserveCap: 16_000,
  responseReserveFloor: 1_024,
  safetyFraction: 0.08,
  charsPerToken: CHARS_PER_TOKEN_ESTIMATE,
  imageTokens: 1_200,
  // Default 0 = conventional trim-oldest. The oldest-anchor cache
  // optimization is opt-in (see the field doc + decision record).
  cacheAnchorFraction: 0,
  // ~1k-token summaries keep the marker small on the common path; raise it
  // (`compaction:summarizeMaxTokens`) for models that need richer recall.
  summarizeMaxTokens: 1_024,
  // Defined in ./tool-result-cap alongside the settings key + validators, so
  // the number the editor shows as "the default" is the number used here.
  toolResultCap: DEFAULT_TOOL_RESULT_CAP,
};

const PER_MESSAGE_OVERHEAD = 4;
/** Shared prefix for every ephemeral context-note marker (trim omission +
 *  summarize summary), so {@link isCompactionMarker} strips both kinds. */
export const MARKER_PREFIX = "[Context note:";
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

// ── Stale tool-result cap (always-on cost control) ───────────────────

/**
 * Elision mark embedded in a capped stale tool result. Its ONLY variable is
 * the elided character count — a pure function of the text and the cap — so
 * the same input always renders the same bytes. Nothing time-, budget-,
 * position- or count-of-messages-dependent may ever go in here: Anthropic's
 * cache is prefix-matched, so a marker that changed per turn would rewrite
 * the history prefix on every send (guaranteed miss + 25% cache-write
 * surcharge) and cost MORE than the bytes it saves.
 */
function staleToolMark(elided: number): string {
  return `\n…[${elided} chars of this older tool result elided to cut re-sent context]…\n`;
}

function isToolResult(m: AgentMessage): m is ToolResultMessage {
  return "role" in m && m.role === "toolResult";
}

/**
 * Head slice that never ends on a lone high surrogate, and tail slice that
 * never starts on a lone low surrogate — an arbitrary UTF-16 cut through a
 * surrogate pair would otherwise emit invalid UTF-8 on the wire. Dropping the
 * orphan is itself deterministic, so byte-stability is preserved.
 */
function sliceHead(text: string, len: number): string {
  const s = text.slice(0, len);
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

function sliceTail(text: string, len: number): string {
  const s = text.slice(text.length - len);
  const first = s.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? s.slice(1) : s;
}

/**
 * Head+tail retention for one over-cap `toolResult`. Returns `undefined` when
 * the message already fits (so callers can preserve identity).
 *
 * Every text part is collapsed into ONE capped part, landing where the FIRST
 * text part was, with non-text (image) parts kept in their relative order — so
 * the bound is on the message's TOTAL text, not per-part (many just-under-cap
 * parts can't smuggle a megabyte through). Head+tail (not head-only) because
 * tool output usually carries its verdict at the end — the failing assertion,
 * the last log line — while the start carries the invocation shape.
 */
function capToolResult(m: ToolResultMessage, cap: number): ToolResultMessage | undefined {
  const joined = m.content
    .filter((p): p is TextContent => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  if (joined.length <= cap) return undefined;

  const headLen = Math.ceil(cap / 2);
  const head = sliceHead(joined, headLen);
  const tail = sliceTail(joined, cap - headLen);
  const text = `${head}${staleToolMark(joined.length - head.length - tail.length)}${tail}`;

  let emitted = false;
  const content: (TextContent | ImageContent)[] = [];
  for (const part of m.content) {
    if (part.type !== "text") {
      content.push(part);
    } else if (!emitted) {
      content.push({ type: "text", text });
      emitted = true;
    }
  }
  return { ...m, content };
}

/**
 * Cap the text of every `toolResult` EXCEPT the newest one, unconditionally.
 *
 * Distinct from {@link truncateOversizedToolResults}, which is the emergency
 * backstop that only fires once a conversation is already over budget and then
 * destroys the content outright. This runs on EVERY call, under budget
 * included, because that is where the money leaks: a tool result is persisted
 * once and then re-sent verbatim on every remaining agentic-loop iteration and
 * every later turn, so a single multi-MB result is billed over and over.
 *
 * The NEWEST `toolResult` is never capped — it is the output of the tool the
 * agent just ran, and the loop reasons over it in full. (Newest across the
 * whole array, not per-turn: whatever the agent last saw stays whole.) A
 * result stops being newest exactly when the next one lands, so at most one
 * uncapped fat result is in flight at a time.
 *
 * Deterministic by construction: the replacement text depends only on the
 * message's own text and `cfg.toolResultCap`, never on the budget, the model,
 * the clock, or the message's position/neighbours. So a given stale result
 * caps to identical bytes on every turn for the rest of the thread's life,
 * which is what keeps the prefix cache (and the `trim` cache anchor) warm.
 *
 * Returns the input array by identity when nothing was capped.
 */
export function capStaleToolResults(
  messages: AgentMessage[],
  cfg: CompactionConfig = DEFAULTS,
): AgentMessage[] {
  const cap = cfg.toolResultCap;
  if (!Number.isFinite(cap) || cap <= 0) return messages;

  let newest = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isToolResult(messages[i]!)) {
      newest = i;
      break;
    }
  }

  let out: AgentMessage[] | undefined;
  for (let i = 0; i < newest; i++) {
    const m = messages[i]!;
    if (!isToolResult(m)) continue;
    const capped = capToolResult(m, cap);
    if (!capped) continue;
    out ??= [...messages];
    out[i] = capped;
  }
  return out ?? messages;
}

// ── Strategy interface + registry ────────────────────────────────────

/**
 * Injectable LLM summarizer used by the `summarize` strategy. Given the
 * older messages to condense, resolves to summary text — or `null` on any
 * failure/timeout so the strategy can fail open to `trim`. Bound per-turn to
 * the turn's model + credential in build-pi-agent.ts; absent when no
 * summarizer is wired. Kept as an injected seam so tests stay deterministic.
 */
export type SummarizeFn = (
  messages: AgentMessage[],
  opts: { reserveTokens: number; signal?: AbortSignal },
) => Promise<string | null>;

export interface CompactionContext {
  /**
   * Compaction is input-only: a strategy reads the model to size its budget
   * and never writes to it. `Readonly` makes that a compile error rather than
   * a convention — it is shallow on purpose, so every read stays legal while
   * `model.maxTokens = …` stops type-checking.
   *
   * @see docs/context-compaction.md ("Input-only invariant")
   */
  model: Readonly<Model>;
  budget: number;
  cfg: CompactionConfig;
  estimateTokens: (m: AgentMessage[]) => number;
  splitTurnBlocks: (m: AgentMessage[]) => AgentMessage[][];
  /** Present only when a summarizer was wired (see {@link SummarizeFn}). */
  summarize?: SummarizeFn;
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

/** Per-turn dependencies injected into strategies that need side effects. */
export interface CompactionDeps {
  /**
   * LLM summarizer for the `summarize` strategy (build-pi-agent binds it to
   * the turn's model + credential). Absent → `summarize` falls back to
   * `trim`. Ignored by `trim`/`none`.
   */
  summarize?: SummarizeFn;
}

/**
 * Build the pi-agent-core `transformContext` hook for `model`. Applies the
 * always-on {@link capStaleToolResults} cost control, then returns messages
 * untouched while under budget; otherwise runs the configured strategy.
 * Resolved once per turn in `build-pi-agent.ts`.
 *
 * `model` is `Readonly` because compaction trims input only and never writes
 * back to the model (notably not `maxTokens`) — the shallow `Readonly` turns
 * that invariant into a compile error while leaving every read legal.
 *
 * @see docs/context-compaction.md ("Input-only invariant")
 */
export function makeCompactionTransform(
  model: Readonly<Model>,
  override?: Partial<CompactionConfig>,
  deps?: CompactionDeps,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const cfg: CompactionConfig = { ...DEFAULTS, ...(override ?? {}) };
  const budget = computeInputBudget(model, cfg);
  const strategy = getCompactionStrategy(cfg.strategy);

  return async (messages, signal) => {
    // Always-on cost control, deliberately AHEAD of the budget check: stale
    // fat tool results are re-sent on every call whether or not the thread
    // fits, and a capped history may now fit and skip compaction entirely.
    const capped = capStaleToolResults(messages, cfg);
    const cappedTokens = estimateTokens(capped, cfg);
    if (capped !== messages) {
      logger.debug("stale tool results capped", {
        model: model.id,
        cap: cfg.toolResultCap,
        savedTokens: estimateTokens(messages, cfg) - cappedTokens,
      });
    }
    if (cappedTokens <= budget) return capped;

    const ctx: CompactionContext = {
      model,
      budget,
      cfg,
      estimateTokens: (m) => estimateTokens(m, cfg),
      splitTurnBlocks,
      summarize: deps?.summarize,
    };
    // Last-resort fail-open net: a compaction strategy must NEVER fail the
    // user's turn. `trim`/`none` can't throw today and `summarize` catches
    // internally, so this only fires on a future custom-strategy bug — pass
    // the history through unchanged (pi-ai's `isContextOverflow` backstop
    // still surfaces a precise overflow rather than an opaque failure).
    let res: CompactionResult;
    try {
      res = await strategy.compact(capped, ctx, signal);
    } catch (err) {
      logger.warn("compaction strategy threw; passing history through unchanged", {
        strategy: cfg.strategy,
        model: model.id,
        error: String(err),
      });
      // "Unchanged" apart from the tool-result cap: that is a deterministic
      // pure transform, not the thing that failed, so a strategy bug must not
      // silently switch the cost control off.
      return capped;
    }

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
