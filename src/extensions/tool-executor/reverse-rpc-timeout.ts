import type { JsonRpcResponse } from "../types";
import { rpcError } from "../json-rpc";
import { logger } from "../../logger";

const log = logger.child("ext.tool-executor");

/**
 * Bounded timeout (ms) for HOST handling of a single inbound child→host
 * reverse-RPC request (the `setRequestHandler` dispatch in
 * {@link ToolExecutor.ensureSubprocessRpcWired}).
 *
 * Why this exists: a host reverse-RPC handler that never settles (e.g.
 * `ezcorp/drafts.create`'s `getDb().insert().returning()` stalling under
 * external Postgres) leaves the child's `getChannel().request(...)`
 * un-resolved → `proc.callTool` hangs → the ONLY safety net is the 90s
 * executor watchdog, which kills the whole run with a misleading
 * "exceeded its 90000ms call timeout" reason and an empty chat bubble.
 *
 * 20_000ms is deliberately:
 *   - comfortably BELOW the 90s watchdog idle threshold
 *     (`WATCHDOG_IDLE_MS`) so the failure is fast & visible as a normal
 *     `tool:error` card instead of a watchdog kill, AND
 *   - comfortably ABOVE any legitimate host DB/fs/network op (drafts,
 *     fs.*, storage, memory, lessons, schedule, agent-configs,
 *     task-event, append-message, finalize-tool-call, cancel-run,
 *     network.internal all complete in well under a second normally).
 *
 * On timeout the host replies `rpcError(req.id, -32603, …)` so the
 * child's `request()` REJECTS (not hangs) → the calling tool's existing
 * `catch` returns a `toolError(...)` → fast `tool:error` card. No new
 * child-side code is required.
 *
 * Overridable via `EZCORP_HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS` (positive
 * integer ms) for operators on pathologically slow external DBs; an
 * invalid / non-positive value falls back to the 20s default.
 */
/**
 * Pure parser for {@link HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS}. Extracted
 * from the module-level IIFE so the env-parsing contract is unit-testable
 * without process.env mutation. Behavior is byte-for-byte identical to
 * the previous inline IIFE:
 *   - `undefined` (env unset) → 20_000 default
 *   - a finite, strictly-positive number → `Math.floor` of it
 *   - NaN / non-numeric / `Infinity` → 20_000 default
 *   - zero or negative → 20_000 default
 */
export function parseHostReverseRpcTimeoutMs(raw: string | undefined): number {
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 20_000;
}

export const HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS: number =
  parseHostReverseRpcTimeoutMs(
    process.env.EZCORP_HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS,
  );

/**
 * Reverse-RPC methods EXEMPT from {@link HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS}.
 *
 * Audit result (Phase 1, Locked decision 5 — "no behavior change on the
 * healthy path"; `requiresUserInput`/legitimately-long handlers must be
 * exempt or budgeted):
 *
 *   - `ezcorp/invoke` — recursively dispatches ANOTHER extension's tool
 *     via `executeToolCall`. That nested tool may legitimately be a slow
 *     LLM-backed / shell-build tool carrying its own large
 *     `callTimeoutMs`; it is already bounded by its own per-call
 *     watchdog budget plus the per-chain (`MAX_CALL_DEPTH`) and
 *     per-conversation (`MAX_CALL_DEPTH_PER_CONVERSATION`) caps. A flat
 *     20s cap here would wrongly kill legitimate cross-extension chains.
 *
 *   - `ezcorp/llm-complete` — a full provider LLM completion round-trip
 *     (`ctx.llm.complete()`); long generations legitimately exceed 20s.
 *     Bounded by the provider/abort-signal, not by a host DB op.
 *
 * Every other host handler is a bounded DB/fs/network op and IS subject
 * to the timeout. Keep this set MINIMAL — adding an entry re-opens the
 * stuck-chat hole for that method.
 */
const REVERSE_RPC_HANDLER_TIMEOUT_EXEMPT: ReadonlySet<string> = new Set([
  "ezcorp/invoke",
  "ezcorp/llm-complete",
]);

/**
 * Sentinel returned by the timeout arm of the bounded-dispatch race.
 * A unique object reference so a handler that legitimately resolves to
 * `undefined`/`null` can never be mistaken for a timeout.
 */
const REVERSE_RPC_TIMEOUT = Symbol("reverse-rpc-handler-timeout");

/**
 * Race a host reverse-RPC handler against
 * {@link HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS}. On timeout, resolves to a
 * `-32603` JSON-RPC error response (NOT a rejection — the caller writes
 * it back to the child verbatim so the child's `request()` rejects fast
 * instead of hanging until the 90s watchdog). Exempt methods bypass the
 * race entirely and are awaited unbounded.
 *
 * The losing arm's promise is intentionally left to settle on its own
 * (a stalled DB call may never settle — that's the whole bug); we only
 * clear the timer so a fast handler doesn't leak an active timeout.
 */
export async function dispatchReverseRpcWithTimeout(
  method: string,
  extensionId: string,
  reqId: number | string,
  handler: () => Promise<JsonRpcResponse>,
  /**
   * Caller-computed exemption for methods that multiplex
   * legitimately-long actions behind one method name. `ezcorp/drafts`
   * `verify`/`install` run a sandboxed `verifyExtension` smoke-test
   * round-trip (can exceed 20s) and `install` only ever runs AFTER an
   * explicit user-approval gate — the per-call watchdog is the correct
   * backstop there, not this flat per-handler cap. The fast drafts
   * actions (create/consume/resolveDir/listForUser/discard) stay
   * bounded. Keeping this caller-scoped (vs. adding `ezcorp/drafts` to
   * the global set) preserves the "set stays minimal" invariant.
   */
  exemptOverride = false,
): Promise<JsonRpcResponse> {
  if (exemptOverride || REVERSE_RPC_HANDLER_TIMEOUT_EXEMPT.has(method)) {
    return handler();
  }
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof REVERSE_RPC_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(REVERSE_RPC_TIMEOUT), HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS);
  });
  try {
    const winner = await Promise.race([handler(), timeoutPromise]);
    if (winner === REVERSE_RPC_TIMEOUT) {
      const elapsed = Date.now() - startedAt;
      log.error("Host reverse-RPC handler timed out — replying -32603", {
        method,
        extensionId,
        elapsedMs: elapsed,
        timeoutMs: HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS,
      });
      return rpcError(
        reqId,
        -32603,
        `Host handler for "${method}" timed out after ${HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS}ms`,
      );
    }
    return winner;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
