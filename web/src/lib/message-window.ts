/**
 * Pure helpers for client-side message-list pagination ("infinite scroll"
 * upward). Used by the chat page to render only the last N messages of a
 * conversation path, then progressively reveal older ones as the user
 * scrolls up.
 *
 * The chat page must keep the full message tree in memory for branching and
 * tool-call hydration — so pagination is a *render-layer* slice, not a
 * fetch-layer optimisation. These functions encode that slice.
 */

/** How many messages to render initially when a chat is first opened. */
export const INITIAL_MESSAGE_WINDOW = 15;

/** How many additional messages to reveal each time the user scrolls up. */
export const MESSAGE_LOAD_STEP = 20;

/**
 * Return the tail slice of `messages` containing at most `windowSize` items.
 * If `windowSize` is >= total, returns the original array (no allocation).
 *
 * Negative or zero `windowSize` returns an empty array — callers that pass
 * such values almost always want "render nothing", not "render everything".
 */
export function computeVisibleMessages<T>(messages: readonly T[], windowSize: number): readonly T[] {
	if (windowSize <= 0) return [];
	if (messages.length <= windowSize) return messages;
	return messages.slice(messages.length - windowSize);
}

/** True when not all messages are visible — used to gate the "Load older" UI. */
export function hasOlderMessages(totalCount: number, visibleCount: number): boolean {
	return totalCount > Math.min(visibleCount, totalCount);
}

/**
 * Compute the next window size after a "load older" trigger. Grows the window
 * by `step`, capped at `totalCount`. Never shrinks; never exceeds `totalCount`.
 */
export function nextWindowSize(currentSize: number, totalCount: number, step = MESSAGE_LOAD_STEP): number {
	if (step <= 0) return currentSize;
	return Math.min(Math.max(currentSize, 0) + step, Math.max(totalCount, 0));
}

/**
 * Compute the new `scrollTop` that keeps the user's viewport anchored on the
 * same message after older messages are prepended above. Without this, the
 * browser would visually jump as new DOM nodes shift the existing content
 * downward.
 */
export function anchorScrollTop(beforeTop: number, beforeHeight: number, afterHeight: number): number {
	const delta = afterHeight - beforeHeight;
	// Clamp to a non-negative result; a negative delta (content shrunk) would
	// only happen if something else removed DOM during the load, in which
	// case we just preserve the user's offset.
	return Math.max(0, beforeTop + Math.max(0, delta));
}
