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
 *     timeout error so the LLM sees a concrete failure.
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

const DEFAULT_EZ_CLIENT_TOOL_TIMEOUT_MS = 5 * 60_000;
let ezClientToolTimeoutMs = DEFAULT_EZ_CLIENT_TOOL_TIMEOUT_MS;

/** Test-only: shorten the 5-minute timeout so the timeout branch can be
 *  exercised without a real wait. */
export function _setEzClientToolTimeoutForTests(ms: number): void {
  ezClientToolTimeoutMs = ms;
}

/** Test-only: reset to the production default. */
export function _resetEzClientToolTimeoutForTests(): void {
  ezClientToolTimeoutMs = DEFAULT_EZ_CLIENT_TOOL_TIMEOUT_MS;
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
