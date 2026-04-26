/**
 * Decision logic + in-memory cache for "open chat → where do we land?".
 *
 * Rules (see plan):
 *   - If a run is currently streaming for this conversation → scroll to bottom.
 *   - Else if we have a remembered scroll position → restore it.
 *   - Else (first visit in this SPA session) → scroll to bottom.
 *
 * The cache also tracks the user's expanded message-window size
 * (`visibleMessageCount`) so that when they paginated older messages into
 * view and then come back, the same set of messages is rendered — otherwise
 * a restored `scrollTop` would land on a totally different message because
 * the page would have collapsed back to the default window.
 *
 * Both fields are independently optional: `windowSize` may be cached without
 * `scrollTop`, which preserves first-visit semantics in `decideOpenScroll`
 * (it only checks `cachedScrollTop`).
 *
 * The cache is module-scoped and lives only in-memory: we deliberately do not
 * persist across full page reloads, matching the lifetime of
 * `store.streamingRunToConversation`.
 */

export function hasActiveStreamForConversation(
	convId: string,
	streamingRunToConversation: Record<string, string>,
): boolean {
	for (const c of Object.values(streamingRunToConversation)) {
		if (c === convId) return true;
	}
	return false;
}

export type OpenScrollDecision =
	| { kind: "scroll-to-bottom"; reason: "active-stream" | "first-visit" }
	| { kind: "restore"; scrollTop: number };

export function decideOpenScroll(args: {
	convId: string;
	streamingRunToConversation: Record<string, string>;
	cachedScrollTop: number | undefined;
}): OpenScrollDecision {
	if (hasActiveStreamForConversation(args.convId, args.streamingRunToConversation)) {
		return { kind: "scroll-to-bottom", reason: "active-stream" };
	}
	if (args.cachedScrollTop === undefined) {
		return { kind: "scroll-to-bottom", reason: "first-visit" };
	}
	return { kind: "restore", scrollTop: args.cachedScrollTop };
}

export interface ScrollState {
	scrollTop?: number;
	windowSize?: number;
}

const stateByConv = new Map<string, ScrollState>();

export function getCachedScrollState(convId: string): ScrollState | undefined {
	return stateByConv.get(convId);
}

/** Merge a partial update into the conversation's cached state. */
export function updateCachedScrollState(convId: string, partial: ScrollState): void {
	const existing = stateByConv.get(convId) ?? {};
	stateByConv.set(convId, { ...existing, ...partial });
}

/** Test-only — clear the in-memory cache. */
export function _resetScrollCache(): void {
	stateByConv.clear();
}
