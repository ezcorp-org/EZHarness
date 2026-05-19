import type { Message } from "$lib/api.js";

/**
 * Hooks the filter needs to consult the reactive stores that hydrate
 * historical content. All three must be wrapped so the caller can pass
 * `inlineToolStore.getByMessage` (via the page's `getHistoricalToolCalls`),
 * the page's `getHistoricalAgentCalls`, and the page's
 * `memoryCardVisibleMessageIds.has(...)` (the dedup set computed over
 * consecutive same-memory-set assistant turns). The filter only inspects
 * boolean answers from these hooks.
 */
export interface EmptyTurnFilterDeps {
	hasHistoricalToolCalls: (messageId: string) => boolean;
	hasHistoricalAgentCalls: (messageId: string) => boolean;
	/**
	 * True iff `<MemoriesCard>` will actually render for this message — i.e.
	 * the row has `memoriesUsed` AND the dedup pass elected this row as the
	 * one to surface the card on. Without this, a row with `memoriesUsed`
	 * whose card has been deduped onto an earlier turn would render as a
	 * blank bubble (avatar + toolbar + nothing), which is the user-reported
	 * regression.
	 */
	isMemoryCardVisible: (messageId: string) => boolean;
}

/**
 * True when the message is a placeholder for the run that's currently
 * streaming — it MUST always render so tokens have somewhere to land.
 * The page assigns these ids `streaming-<runId>`.
 */
function isStreamingPlaceholder(msg: Message): boolean {
	return typeof msg.id === "string" && msg.id.startsWith("streaming-");
}

/**
 * Decide whether an assistant message has nothing visible to render and
 * should be hidden from the transcript. Hidden when ALL of:
 *  - role is assistant
 *  - content is empty/whitespace
 *  - thinkingContent is empty/null
 *  - memoriesUsed is missing/empty OR the MemoriesCard is deduped onto a
 *    different (earlier) row — the deduped row by itself has nothing visible
 *  - no historical tool calls hydrated for this message
 *  - no historical agent calls (sub-conversations) anchored to this message
 *  - it is NOT the streaming placeholder
 *
 * User messages are NEVER hidden — even if `content` is empty (e.g. an
 * attachment-only turn) they convey user intent.
 *
 * The function reads `hasHistoricalToolCalls` / `hasHistoricalAgentCalls`
 * / `isMemoryCardVisible` synchronously; when the underlying stores are
 * reactive (Svelte $state / $derived), wrapping this function in a
 * `$derived` causes hidden messages to re-appear once hydration populates
 * their tool/agent data or the dedup set changes.
 */
export function shouldHideEmptyAssistantTurn(
	msg: Message,
	deps: EmptyTurnFilterDeps,
): boolean {
	if (msg.role !== "assistant") return false;
	if (isStreamingPlaceholder(msg)) return false;

	if (msg.content && msg.content.trim().length > 0) return false;
	if (msg.thinkingContent && msg.thinkingContent.length > 0) return false;
	if (
		msg.memoriesUsed &&
		msg.memoriesUsed.length > 0 &&
		deps.isMemoryCardVisible(msg.id)
	) {
		return false;
	}
	if (deps.hasHistoricalToolCalls(msg.id)) return false;
	if (deps.hasHistoricalAgentCalls(msg.id)) return false;

	return true;
}

/**
 * Filter a message list, dropping assistant turns that have nothing visible
 * to render. Returns the same array reference when no rows are removed so
 * Svelte equality checks don't trip an extra render pass.
 */
export function filterEmptyAssistantTurns<T extends Message>(
	messages: readonly T[],
	deps: EmptyTurnFilterDeps,
): readonly T[] {
	let removedAny = false;
	const out: T[] = [];
	for (const m of messages) {
		if (shouldHideEmptyAssistantTurn(m, deps)) {
			removedAny = true;
			continue;
		}
		out.push(m);
	}
	return removedAny ? out : messages;
}
