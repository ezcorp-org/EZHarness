/**
 * Stick-to-bottom gate for the chat thread.
 *
 * When the user is following the bottom of the message list, the view must
 * stay pinned to the bottom as new content arrives — streamed tokens,
 * tool/agent cards, post-turn loadMessages/hydrate growth, or async reflow
 * (images, code highlight, KaTeX). A `ResizeObserver` in ChatThread.svelte
 * fires on any of those height changes and calls {@link shouldStickToBottom}
 * to decide whether to re-pin.
 *
 * ## Why `stuck` (and not the old `userScrolledUp` + `slack`)
 *
 * The decision must distinguish two situations that look identical after
 * the DOM has grown:
 *
 *   1. The user deliberately scrolled up to read  → must NOT yank them.
 *   2. A single large insert (a whole new turn / a turn-completion
 *      reconcile, >{@link STICK_TO_BOTTOM_THRESHOLD_PX}px) pushed the
 *      bottom out of view while the user was at the bottom → must re-pin.
 *
 * The previous design fed the gate the bottom-sentinel
 * `IntersectionObserver`'s `userScrolledUp` flag plus a post-growth
 * `slack` measurement. Both cases yield `userScrolledUp === true` (the
 * sentinel left the viewport) and a large `slack`, so correctness relied
 * on the `ResizeObserver` callback winning a race against the
 * `IntersectionObserver` — an ordering the platform does not guarantee.
 * When the IntersectionObserver fired first, a real new turn was wrongly
 * treated as "user scrolled up" and the thread did not follow.
 *
 * The fix: the caller tracks a single `stuck` boolean **synchronously
 * from real scroll events** (a scroll landing within
 * {@link STICK_TO_BOTTOM_THRESHOLD_PX} of the bottom ⇒ following; a scroll
 * measurably away from the bottom ⇒ broke away). A programmatic pin lands
 * at the bottom and keeps `stuck` true; a user drag flips it false
 * synchronously before any later resize tick. The async sentinel observer
 * is no longer consulted for the pin decision, so observer ordering can no
 * longer break stick-to-bottom.
 *
 * This module is the single source of truth for that decision; the
 * component is a thin caller (it owns the DOM refs, the rAF, the observer
 * lifecycle, and the `stuck` bookkeeping). Keeping the logic here lets the
 * unit + integration suites exercise the *real* function, so any drift
 * from the call site shows up as a test failure (same strategy as
 * `chat-scroll-restore.ts`).
 */

/**
 * Distance in px from the bottom under which the view counts as "at
 * bottom" when classifying a scroll event. A scroll that leaves the
 * viewport within this many px of the bottom keeps the thread `stuck`;
 * a scroll further than this means the user broke away to read.
 */
export const STICK_TO_BOTTOM_THRESHOLD_PX = 80;

/**
 * Vertical slack: pixels of scrollable content remaining below the
 * viewport. `0` ⇒ scrolled to the very bottom; larger ⇒ further from the
 * bottom. Used by the caller's scroll handler to classify a scroll as
 * "still following" vs "broke away" (it is NOT a gate input — see the
 * module docstring for why a post-growth slack measurement is unsafe).
 */
export function bottomSlack(el: {
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
}): number {
	return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export interface StickGateInput {
	/**
	 * False until the open-time scroll-restore effect has decided this
	 * conversation's initial position. While false the gate is inert so the
	 * observer never fights scroll-restore on open.
	 */
	initialScrollDone: boolean;
	/** A rAF pin is already scheduled — don't double-schedule. */
	rafPending: boolean;
	/**
	 * `stopAnchorWatch !== null` — an anchor-reapply restore is in progress.
	 * Bottom-stick and anchor-restore are mutually exclusive scroll intents;
	 * standing down here avoids tripping the anchor watch's onScroll
	 * early-stop and leaving the restored anchor unconverged.
	 */
	anchorWatchActive: boolean;
	/**
	 * Synchronous "the user is following the bottom" intent, tracked by the
	 * caller from real `scroll` events (and set directly on send / jump /
	 * open-to-bottom). Unlike the old async `userScrolledUp` flag this is
	 * never set by the bottom-sentinel IntersectionObserver, so a one-shot
	 * large turn-completion insert cannot stale-flip it and the pin
	 * decision no longer depends on observer ordering.
	 */
	stuck: boolean;
}

/**
 * Whether the stick-to-bottom observer should re-pin the thread to the
 * bottom on this resize.
 *
 * Pins iff the open decision is settled, no pin is pending, no anchor
 * restore owns the scroll, and the user is currently following the bottom
 * (`stuck`). Because `stuck` is derived synchronously from scroll events
 * rather than from the async sentinel observer, a genuine "scrolled up to
 * read" is left alone and a large new-turn insert while following still
 * pins — regardless of ResizeObserver/IntersectionObserver ordering.
 */
export function shouldStickToBottom(i: StickGateInput): boolean {
	if (!i.initialScrollDone || i.rafPending) return false;
	if (i.anchorWatchActive) return false;
	return i.stuck;
}
