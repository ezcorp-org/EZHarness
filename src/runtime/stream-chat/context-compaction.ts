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
}

export const DEFAULTS: CompactionConfig = {
  strategy: "trim",
  responseReserveCap: 16_000,
  responseReserveFloor: 1_024,
  safetyFraction: 0.08,
  charsPerToken: 4,
  imageTokens: 1_200,
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

class TrimStrategy implements CompactionStrategy {
  readonly name = "trim";

  async compact(
    messages: AgentMessage[],
    ctx: CompactionContext,
  ): Promise<CompactionResult> {
    // Drop prior markers so they neither accumulate nor skew estimates.
    const base = messages.filter((m) => !isCompactionMarker(m));
    const blocks = ctx.splitTurnBlocks(base);
    if (blocks.length === 0) {
      return { messages, droppedCount: 0, droppedTokens: 0, strategy: this.name };
    }

    const lastBlock = blocks[blocks.length - 1]!;
    const kept = blocks.slice(0, -1);
    const dropped: AgentMessage[][] = [];

    // Reserve the marker's own token cost so the composed result
    // (marker + survivors) — not just the survivors — fits the budget.
    // Use the message count as an upper bound on the count digits.
    const markerCost = estimateMessageTokens(
      makeMarker(base.length, ctx.budget),
      ctx.cfg,
    );
    const effectiveBudget = Math.max(1, ctx.budget - markerCost);

    // Evict oldest whole turns while still over budget.
    while (
      kept.length > 0 &&
      ctx.estimateTokens([...kept.flat(), ...lastBlock]) > effectiveBudget
    ) {
      dropped.push(kept.shift()!);
    }

    const droppedMsgs = dropped.flat();
    const droppedTokens = ctx.estimateTokens(droppedMsgs);

    if (droppedMsgs.length === 0) {
      // Either it already fits (no-op), or only the active turn remains
      // and it alone is too big → degenerate tool-result truncation.
      if (ctx.estimateTokens([...kept.flat(), ...lastBlock]) <= ctx.budget) {
        return { messages, droppedCount: 0, droppedTokens: 0, strategy: this.name };
      }
      const t = truncateOversizedToolResults([...kept.flat(), ...lastBlock], ctx);
      return {
        messages: t.messages,
        droppedCount: 0,
        droppedTokens: t.truncatedTokens,
        strategy: this.name,
      };
    }

    const marker = makeMarker(droppedMsgs.length, ctx.budget);
    let result: AgentMessage[] = [marker, ...kept.flat(), ...lastBlock];

    // Dropped every evictable turn and still over → truncate tool
    // results in what remains (keeps the marker first).
    if (ctx.estimateTokens(result) > ctx.budget) {
      const t = truncateOversizedToolResults([...kept.flat(), ...lastBlock], ctx);
      result = [marker, ...t.messages];
      return {
        messages: result,
        droppedCount: droppedMsgs.length,
        droppedTokens: droppedTokens + t.truncatedTokens,
        strategy: this.name,
      };
    }

    return {
      messages: result,
      droppedCount: droppedMsgs.length,
      droppedTokens,
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
