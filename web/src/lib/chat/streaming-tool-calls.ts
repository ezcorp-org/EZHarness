/**
 * Pure helper for the live streaming tool-call list
 * (`store.streamingToolCalls[runId]`).
 *
 * Why this exists: a tool call's card can be pushed into that list from
 * TWO independent code paths —
 *
 *   1. the live SSE `tool:start` handler (stores.svelte.ts), and
 *   2. the resume / active-run path (stream-resume.svelte.ts), which
 *      re-injects open `pendingAskUser` / `pendingPermissions` gates from
 *      the in-memory registry (the `tool_calls` DB row doesn't exist while
 *      an `ask_user_question` gate is open — it's written only after the
 *      user answers).
 *
 * The resume path already dedups by id ("re-pushing an already-streamed
 * entry doubles the rendered card"), but the live `tool:start` handler used
 * to blind-append — so when resume injected first and the live event
 * arrived second (a WS reconnect while a question gate is open), the SAME
 * tool call ended up in the list twice and the question card rendered
 * twice. This helper makes the live path's dedup symmetric with the resume
 * path's: an append whose `id` is already present is a no-op.
 */

/** Append `entry` to `existing`, deduped by `id`. `added` is false when an
 *  entry with the same id is already present (the caller then skips the
 *  content-block tool_ref push that pairs with a genuinely-new card). An
 *  entry with no `id` can't be deduped and is always appended. */
export function appendStreamingToolCall<T extends { id?: string }>(
	existing: readonly T[],
	entry: T,
): { calls: T[]; added: boolean } {
	if (entry.id != null && existing.some((tc) => tc.id === entry.id)) {
		return { calls: existing as T[], added: false };
	}
	return { calls: [...existing, entry], added: true };
}
