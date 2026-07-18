import type { EventBus } from "../../runtime/events";
import type { AgentEvents } from "../../types";

/**
 * Pure parser for {@link MAX_TOOL_CALLS_PER_TURN}. Mirrors
 * {@link parseHostReverseRpcTimeoutMs} so the env-parsing contract is
 * unit-testable without process.env mutation:
 *   - `undefined` (env unset) → 100 default
 *   - a finite, strictly-positive number → `Math.floor` of it
 *   - NaN / non-numeric / `Infinity` → 100 default
 *   - zero or negative → 100 default
 */
export function parseMaxToolCallsPerTurn(raw: string | undefined): number {
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 100;
}

/**
 * Per-conversation per-turn tool-call cap. Default 100 (raised from the
 * original Phase 6 floor of 10, which killed legitimate multi-step
 * agentic turns). This is a coarse runaway-loop backstop — *what* each
 * call may do is already bounded by the per-call PDP gate, the
 * per-chain `MAX_CALL_DEPTH`, and the executor watchdog — so a generous
 * count is safe. Overridable via `EZCORP_MAX_TOOL_CALLS_PER_TURN`
 * (positive integer); an invalid / non-positive value falls back to
 * the 100 default.
 */
export const MAX_TOOL_CALLS_PER_TURN: number = parseMaxToolCallsPerTurn(
  process.env.EZCORP_MAX_TOOL_CALLS_PER_TURN,
);

/**
 * Phase 6 (finding M3) — process-singleton per-conversation per-turn
 * counter. A single LLM turn that fans out more than
 * {@link MAX_TOOL_CALLS_PER_TURN} tool calls in the same conversation
 * throws on the call past the cap, preventing runaway loops in a
 * compromised or buggy extension chain.
 *
 * Reset on `run:complete` for the conversation (wired below in
 * `wireMaxToolCallsCounter`). The counter is in-memory only — process
 * restart clears it, which is fine; a runaway turn that survives a
 * restart restarts at zero anyway because `run:complete` would have
 * fired during shutdown.
 *
 * Module-level singleton because `ToolExecutor` is constructed per-turn
 * by `setup-tools.ts`; a per-instance Map would reset on every turn
 * and never trigger the cap. The bus subscription (also process
 * singleton, attached on first `wireMaxToolCallsCounter` call) clears
 * the count when the run completes.
 */
export const toolCallsThisTurn = new Map<string, number>();
let toolCallsCounterWired = false;

/**
 * Phase 6 (M3): wire the per-turn counter to reset on run:complete.
 * Idempotent — a module-level flag ensures a single bus subscription
 * even though many ToolExecutor instances are constructed per-turn.
 *
 * NOTE (reviewer S2): the module-level `toolCallsCounterWired`
 * binds to the FIRST `bus` instance that gets here. Production is
 * single-bus by design (one `host.bus` lives on `setup-tools.ts`'s
 * shared host), so this is a documentation requirement, not a code
 * change. If the runtime ever transitions to multi-bus topology
 * (e.g. per-tenant or per-process buses), this single-flag pattern
 * would silently bind the counter to one bus and orphan the rest.
 * Test-only `_resetToolCallsCounterForTests` resets the flag so
 * each test's `makeBus()` rewires correctly.
 */
export function wireMaxToolCallsCounter(bus: EventBus<AgentEvents>): void {
  if (toolCallsCounterWired) return;
  toolCallsCounterWired = true;
  bus.on("run:complete", (data) => {
    const cid = (data as { conversationId?: string } | null | undefined)?.conversationId;
    if (cid) toolCallsThisTurn.delete(cid);
  });
  // Also clear on cancel/error so a turn aborted mid-flight
  // doesn't keep its stale count tying up the next turn's budget.
  bus.on("run:cancel", (data) => {
    const cid = (data as { conversationId?: string } | null | undefined)?.conversationId;
    if (cid) toolCallsThisTurn.delete(cid);
  });
  bus.on("run:error", (data) => {
    const cid = (data as { conversationId?: string } | null | undefined)?.conversationId;
    if (cid) toolCallsThisTurn.delete(cid);
  });
}

/** Test-only: reset the per-turn counter + un-wire the bus listener. */
export function _resetToolCallsCounterForTests(): void {
  toolCallsThisTurn.clear();
  toolCallsCounterWired = false;
}

/** Read-only test peek at the per-conversation tool call count. */
export function _getToolCallsThisTurnForTests(conversationId: string): number {
  return toolCallsThisTurn.get(conversationId) ?? 0;
}

/**
 * Phase 54 SEC-03 — per-conversation cross-ext call-depth cap.
 *
 * Replaces the pre-CC3 caller-supplied `_depth` param (per-CHAIN) with a
 * server-side counter (per-CONVERSATION). 50 parallel chains can no
 * longer collectively bypass the 10-deep per-chain cap by spawning
 * sibling chains.
 *
 * The map key is the parent conversation id (`this.currentConversationId`,
 * or a `cross-ext-<reqId>` synthetic when there's truly no parent — the
 * synthetic ids are unique per request, so they don't accidentally
 * collide and trigger false caps). Increment fires before the
 * handlePiInvoke body; decrement fires in `finally` so the slot is
 * reusable after the call settles.
 *
 * See tasks/v1.3-security-review.md CC3.
 */
export const MAX_CALL_DEPTH_PER_CONVERSATION = 50;
export const conversationCallDepth = new Map<string, number>();

/** Test-only: drop the per-conversation depth counter. */
export function _resetConversationCallDepthForTests(): void {
  conversationCallDepth.clear();
}

/**
 * Test-only: peek at the module-scope Map's entry count so the
 * lazy-delete path (invoke.ts `Map.delete` when count decrements to 0)
 * can be asserted directly rather than inferred from absence of growth.
 * Locking this in prevents a future "decrement-but-don't-delete" refactor
 * from silently leaking 0-count entries.
 */
export function _peekConversationCallDepthMapSizeForTests(): number {
  return conversationCallDepth.size;
}

/**
 * Phase 6 — error type thrown when a single LLM turn exceeds the
 * `MAX_TOOL_CALLS_PER_TURN` cap. Carries the conversationId + count so
 * the audit row + UI surface name the offending conversation.
 */
export class MaxToolCallsExceededError extends Error {
  constructor(public readonly conversationId: string, public readonly count: number) {
    super(
      `Max tool calls per turn exceeded for conversation "${conversationId}" ` +
        `(count=${count}, limit=${MAX_TOOL_CALLS_PER_TURN})`,
    );
    this.name = "MaxToolCallsExceededError";
  }
}
