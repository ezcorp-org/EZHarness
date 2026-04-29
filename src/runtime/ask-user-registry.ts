/**
 * Host-side registry tracking pending `ask_user_question` tool calls so
 * the POST endpoint at `/api/ask-user/answer/+server.ts` can resolve
 * `toolCallId → conversationId` (and verify the acting user owns the
 * conversation) without querying the `tool_calls` DB table.
 *
 * Why an in-memory map and NOT a DB lookup:
 *   The `tool_calls` row is written by `ToolExecutor.recordToolCall()`
 *   AFTER the subprocess returns. For `ask_user_question`, the
 *   subprocess does not return until the user answers — so during the
 *   ENTIRE window the user can click an option, the row doesn't yet
 *   exist. A SELECT-by-id would silently miss every legitimate POST,
 *   the endpoint would no-op, and the card would hang at "Sending…"
 *   until the 5-minute gate timeout fires.
 *
 *   This registry is populated by `wireAskUserToolForTurn` when it
 *   wraps the extension tool's `execute`, and cleared in the wrapper's
 *   `finally`. Lookup is O(1), there's no race with persistence.
 *
 * Shape:
 *   - Key: host-minted `toolCallId` (also = `tool_calls.id` at end of
 *     run, but we don't depend on that here).
 *   - Value: { conversationId, userId } — `userId` is the conversation
 *     owner's id, captured at wire time so the POST endpoint's owner
 *     check doesn't need a second DB hop.
 *
 * Stale entries: impossible in production. Every entry is set+cleared
 * by the same `try/finally` in the wire wrapper. A subprocess crash
 * during a gate would cause the wrapper's promise to reject, which
 * still runs the `finally`. The 5-min `callTimeoutMs` is the longest
 * any entry can live.
 *
 * Test surface: `_resetPendingAskUserForTests()` clears between tests.
 */

interface PendingAskUserEntry {
  conversationId: string;
  /** Owner of the conversation, for the POST endpoint's auth check. */
  userId: string | null;
  /** LLM-supplied prompt — captured so the GET active-run endpoint can
   *  re-hydrate the inline question card on a refreshed client without
   *  a DB hop. Optional for callers (e.g. tests) that only need the
   *  conversation/user mapping. */
  question?: string;
  options?: string[];
}

export interface PendingAskUserSummary {
  toolCallId: string;
  question?: string;
  options?: string[];
  userId: string | null;
}

const pendingByToolCallId = new Map<string, PendingAskUserEntry>();

/** Record that a `ask_user_question` invocation is pending. Called by
 *  `wireAskUserToolForTurn` at the START of the wrapper's `execute`. */
export function registerPendingAskUser(
  toolCallId: string,
  conversationId: string,
  userId: string | null,
  details?: { question?: string; options?: string[] },
): void {
  pendingByToolCallId.set(toolCallId, {
    conversationId,
    userId,
    question: details?.question,
    options: details?.options,
  });
}

/** Read the pending entry. Returns `undefined` for an unknown
 *  toolCallId (gate already cleared, or never registered — both treat
 *  as "no-op" in the POST handler). */
export function getPendingAskUser(
  toolCallId: string,
): PendingAskUserEntry | undefined {
  return pendingByToolCallId.get(toolCallId);
}

/** Clear the entry — called by the wire wrapper's `finally` regardless
 *  of success / error / timeout / abort. */
export function clearPendingAskUser(toolCallId: string): void {
  pendingByToolCallId.delete(toolCallId);
}

/** Test-only: wipe the map between tests. */
export function _resetPendingAskUserForTests(): void {
  pendingByToolCallId.clear();
}
