/**
 * Phase 48 — Ez client-side tool resumption registry.
 *
 * Mirrors `ask-user-registry.ts`. The two client-side Ez tools (`fill_form`,
 * `navigate_to`) cannot be resolved server-side: when the LLM calls them
 * the runtime emits an `ez:client-tool` event over the SSE bus, the panel
 * dispatches the call locally (filling a form / navigating), and POSTs
 * the resolution back to `/api/conversations/.../tool-results`.
 *
 * That POST handler needs an O(1) way to wake the suspended tool's
 * Promise. A `tool_calls` SELECT won't work because the row is only
 * persisted after `execute()` returns — but here `execute()` is exactly
 * what's suspended. So we keep an in-memory map keyed by `toolCallId`
 * holding `{ resolve, reject, conversationId, userId }`.
 *
 * ## Lifecycle
 *
 *   1. `createFillFormTool` / `createNavigateToTool` call `registerPendingEzClientTool`
 *      at the start of `execute`, then `await` the returned Promise.
 *   2. The runtime emits `ez:client-tool` on the bus → SSE → panel.
 *   3. Panel dispatches locally → POSTs `{ toolCallId, result }` to
 *      `/api/conversations/[id]/tool-results`.
 *   4. POST handler authorizes (conv ownership) → calls `resolveEzClientTool(toolCallId, result)`.
 *   5. The suspended `execute` resumes and returns an `AgentToolResult` with the panel's payload.
 *
 * ## Edge cases
 *
 *   - **Abort:** if `signal` aborts mid-suspend, `rejectEzClientTool(toolCallId, "aborted")`
 *     is called from the abort listener (registered in fill-form / navigate-to).
 *   - **Timeout:** a 5-minute default cap is enforced inside `register…`. If the
 *     panel never POSTs (browser closed mid-flow), the gate rejects with a
 *     timeout error so the LLM sees a concrete failure. The executor
 *     watchdog defers its idle kill for the whole of that wait — see
 *     {@link ezClientToolWatchdogBudgetMs}, which the three client-side
 *     tool defs use as their `callTimeoutMs`.
 *   - **Duplicate registration:** `register…` overwrites a prior pending entry
 *     for the same `toolCallId`. In practice toolCallIds are UUIDs minted per
 *     LLM call, so collisions can't happen — but the overwrite path is
 *     defensive and rejects the prior Promise with a "superseded" message
 *     before installing the new one.
 *   - **Late POST:** if the entry has already been cleared, the resolve helper
 *     is a no-op (mirrors ask-user-registry's late-POST contract).
 */

interface PendingEzClientToolEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  conversationId: string;
  userId: string | null;
  /** Created-at ms, primarily for tests + diagnostics. */
  createdAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

const pendingByToolCallId = new Map<string, PendingEzClientToolEntry>();

/**
 * How long a client-side Ez tool may legitimately suspend: the panel gets
 * five minutes to POST its resolution before the gate rejects with a
 * concrete timeout error.
 *
 * THE single source of truth for that wait. The three client-side tool
 * defs (`fill_form`, `navigate_to`, `read_page`) derive their watchdog
 * `callTimeoutMs` from it via {@link ezClientToolWatchdogBudgetMs} rather
 * than restating the number — a duplicated literal is exactly how the two
 * halves drifted into the 90s-vs-300s inversion that killed runs mid-wait.
 */
export const EZ_CLIENT_TOOL_TIMEOUT_MS = 5 * 60_000;
let ezClientToolTimeoutMs = EZ_CLIENT_TOOL_TIMEOUT_MS;

/** The live gate timeout — {@link EZ_CLIENT_TOOL_TIMEOUT_MS} in
 *  production, or whatever a test installed via
 *  {@link _setEzClientToolTimeoutForTests}. Read this (never the
 *  constant) when deriving anything that must track the real gate. */
export function getEzClientToolTimeoutMs(): number {
  return ezClientToolTimeoutMs;
}

/**
 * Grace added on top of the gate timeout to form the watchdog's per-call
 * deferral budget.
 *
 * **Who is meant to win the race, and why.** Two clocks bound one
 * suspended call: this registry's `setTimeout` (rejects the pending
 * promise → `runEzClientTool` turns it into a normal tool error → the LLM
 * reads "Timed out waiting for Ez client tool result" and can tell the
 * user the panel never answered), and the executor watchdog (kills the
 * whole RUN once the in-flight deferral lapses and the idle window then
 * elapses → generic error banner, turn dead, model never learns why).
 * The registry MUST win: it degrades one tool call, the watchdog
 * degrades the turn. So the watchdog budget is deliberately the LONGER
 * of the two, and the watchdog survives only as the backstop for the
 * case the registry's own timer never fires (a leaked entry, a future
 * refactor that drops the timer) — the leak detection the watchdog
 * exists for is kept, not switched off.
 *
 * **Sizing — two watchdog ticks (`WATCHDOG_TICK_MS` = 15s), and that is a
 * FLOOR, not the distance to a kill.** The deferral is re-evaluated only
 * once per tick, so the margin has to outlast the tick that straddles the
 * registry rejection, plus the reject → `tool_execution_end` →
 * `noteToolEnd` propagation on a loaded box. The watchdog does NOT kill at
 * `callTimeoutMs`: every deferring tick calls `bumpActivity`, so the clock
 * that matters starts at the LAST DEFERRING TICK and then has to run a
 * WHOLE idle window. Real kill time is
 *
 *     callTimeoutMs + idleThreshold ± one tick
 *
 * — measured at **405s** for a non-reasoning run (330 + 90 − 15), and up to
 * ~21 min on a reasoning-high run (900s idle window). That hold is
 * deliberate and bounded; the per-tier table, and the tests that pin these
 * numbers, are in `docs/features/chat/runs-lifecycle.md`.
 *
 * Not imported from the watchdog module on purpose — the tools layer never
 * depends on the watchdog (same posture as `LONG_BLOCKING_WATCHDOG_BUDGET_MS`
 * in `runtime/tools/filter.ts`), and this module is dependency-free so the
 * `tool-results` API route can import it cheaply.
 */
export const EZ_CLIENT_TOOL_WATCHDOG_MARGIN_MS = 30_000;

/**
 * Watchdog `callTimeoutMs` for a client-side Ez tool def: the live gate
 * timeout plus {@link EZ_CLIENT_TOOL_WATCHDOG_MARGIN_MS}. Called by each
 * client-tool factory at def-construction time (once per turn), so a
 * test that shrinks the gate gets a proportionally shrunk watchdog
 * budget with no second knob to set.
 */
export function ezClientToolWatchdogBudgetMs(): number {
  return getEzClientToolTimeoutMs() + EZ_CLIENT_TOOL_WATCHDOG_MARGIN_MS;
}

/** Test-only: shorten the 5-minute timeout so the timeout branch can be
 *  exercised without a real wait. */
export function _setEzClientToolTimeoutForTests(ms: number): void {
  ezClientToolTimeoutMs = ms;
}

/** Test-only: reset to the production default. */
export function _resetEzClientToolTimeoutForTests(): void {
  ezClientToolTimeoutMs = EZ_CLIENT_TOOL_TIMEOUT_MS;
}

export interface RegisterPendingEzClientToolOptions {
  toolCallId: string;
  conversationId: string;
  /** Owner of the conversation, captured at wire time so the POST endpoint's
   *  auth check is O(1). May be null in test contexts. */
  userId: string | null;
}

/**
 * Register a pending client-side tool call and return a Promise that
 * resolves when the panel POSTs the result, or rejects on timeout / abort.
 *
 * Callers MUST also clear the registration in their `finally` (via
 * {@link clearPendingEzClientTool}) so the timeout handle and the map
 * entry don't outlive the underlying tool call.
 */
export function registerPendingEzClientTool(
  options: RegisterPendingEzClientToolOptions,
): Promise<unknown> {
  const { toolCallId, conversationId, userId } = options;
  // Defensive: if a duplicate id arrives, supersede the prior Promise.
  // This shouldn't happen in production (toolCallIds are unique per call)
  // but mirrors how ask-user-registry handles re-entry.
  const prior = pendingByToolCallId.get(toolCallId);
  if (prior) {
    clearTimeout(prior.timeoutHandle);
    prior.reject(new Error("Ez client tool call superseded by a new registration"));
    pendingByToolCallId.delete(toolCallId);
  }

  return new Promise<unknown>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      const entry = pendingByToolCallId.get(toolCallId);
      if (entry) {
        pendingByToolCallId.delete(toolCallId);
        entry.reject(new Error("Timed out waiting for Ez client tool result"));
      }
    }, ezClientToolTimeoutMs);
    pendingByToolCallId.set(toolCallId, {
      resolve,
      reject,
      conversationId,
      userId,
      createdAt: Date.now(),
      timeoutHandle,
    });
  });
}

/**
 * Resolve a pending client-side tool call with the panel's result.
 * No-op when the entry is missing (gate already cleared — late POST).
 *
 * Returns true if a pending call was found + resolved, false otherwise.
 */
export function resolveEzClientTool(toolCallId: string, result: unknown): boolean {
  const entry = pendingByToolCallId.get(toolCallId);
  if (!entry) return false;
  clearTimeout(entry.timeoutHandle);
  pendingByToolCallId.delete(toolCallId);
  entry.resolve(result);
  return true;
}

/**
 * Reject a pending client-side tool call. Used by abort listeners on the
 * tool side and by the POST handler if the supplied result is malformed.
 *
 * Returns true if a pending call was found + rejected, false otherwise.
 */
export function rejectEzClientTool(toolCallId: string, err: Error | string): boolean {
  const entry = pendingByToolCallId.get(toolCallId);
  if (!entry) return false;
  clearTimeout(entry.timeoutHandle);
  pendingByToolCallId.delete(toolCallId);
  entry.reject(err instanceof Error ? err : new Error(err));
  return true;
}

/**
 * Read the registered conversation owner for a pending tool call. The
 * POST endpoint uses this to confirm the acting user owns the conversation
 * before resolving. Returns undefined when no entry exists.
 */
export function getPendingEzClientTool(
  toolCallId: string,
): { conversationId: string; userId: string | null } | undefined {
  const entry = pendingByToolCallId.get(toolCallId);
  if (!entry) return undefined;
  return { conversationId: entry.conversationId, userId: entry.userId };
}

/**
 * Defensive clear without resolving / rejecting. Used by the tool-side
 * `finally` if the Promise already settled (timeout race). Subsequent
 * resolve/reject calls become no-ops.
 */
export function clearPendingEzClientTool(toolCallId: string): void {
  const entry = pendingByToolCallId.get(toolCallId);
  if (!entry) return;
  clearTimeout(entry.timeoutHandle);
  pendingByToolCallId.delete(toolCallId);
}

/** Test-only: wipe the map between tests. */
export function _resetPendingEzClientToolsForTests(): void {
  for (const entry of pendingByToolCallId.values()) {
    clearTimeout(entry.timeoutHandle);
  }
  pendingByToolCallId.clear();
}
