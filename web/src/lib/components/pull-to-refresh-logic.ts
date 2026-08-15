/**
 * Pull-to-refresh decision logic (pure, dependency-free).
 *
 * Extracted from `PullToRefresh.svelte` so the gesture's state machine is
 * exercised against the SHIPPED code instead of a re-implementation. The
 * component is a thin shell that wires touch events and `location.reload()`
 * to these functions.
 *
 * Why this module exists at all (issue: "the PWA refreshes every time it is
 * opened"): the gesture ends in a full `location.reload()`, and its only
 * guard used to be `document.scrollingElement.scrollTop > 0`. The app shell is
 * a `100dvh` layout whose scrolling happens in INNER containers, so the
 * document itself never scrolls — measured on `/project/global/chat`:
 * `scrollHeight === clientHeight === 780`, `scrollTop` pinned at 0. That guard
 * could therefore never block, which armed the gesture on every route at every
 * viewport: any downward swipe past the threshold hard-reloaded the app, and
 * swiping down is exactly how a touch user scrolls UP through chat history.
 *
 * The fix is to ask the scroller the finger is actually over
 * (`nearestScrollTop`), and to arm the gesture only where its indicator is
 * visible (`isPullEnabled`).
 */

/** Pull distance (px, post-damping) at which release triggers a refresh. */
export const PULL_THRESHOLD_PX = 80;
/** Finger travel is damped by this factor, so the pull feels weighted. */
export const PULL_DAMPING = 0.4;
/** The indicator never travels further than this, however long the pull. */
export const PULL_MAX_PX = PULL_THRESHOLD_PX * 1.5;
/** Indicator resting offset while the reload is in flight. */
export const PULL_REFRESHING_PX = PULL_THRESHOLD_PX * 0.6;
/**
 * Viewport width (px) at or above which the gesture is disabled entirely.
 * Matches the indicator's `md:hidden` (Tailwind `md` = 768px), so the reload
 * can only fire where the user can actually see the affordance.
 */
export const PULL_MAX_VIEWPORT_PX = 768;

/** Damped indicator travel for a raw vertical finger delta. */
export function dampen(dy: number): number {
	if (dy < 0) return 0;
	return Math.min(dy * PULL_DAMPING, PULL_MAX_PX);
}

/** True when the gesture should be armed at this viewport width. */
export function isPullEnabled(viewportWidth: number): boolean {
	return viewportWidth < PULL_MAX_VIEWPORT_PX;
}

/**
 * Minimal structural shape of a scrollable DOM node. Declared structurally
 * (rather than as `Element`) so tests can drive it with plain objects while
 * real `Element`s still satisfy it.
 */
export interface ScrollNode {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	parentElement: ScrollNode | null;
}

/** True when this node is the one that scrolls its own overflow vertically. */
export function isScrollableY(node: ScrollNode, overflowY: string): boolean {
	if (overflowY !== "auto" && overflowY !== "scroll" && overflowY !== "overlay") return false;
	return node.scrollHeight > node.clientHeight;
}

/**
 * `scrollTop` of the nearest vertically-scrollable ancestor of `start`,
 * falling back to the document scroller.
 *
 * This is the whole point of the fix: the gesture must ask the container the
 * finger is over, not the document, because the app shell never scrolls the
 * document.
 */
export function nearestScrollTop(
	start: ScrollNode | null,
	overflowOf: (node: ScrollNode) => string,
	documentScroller: ScrollNode | null,
): number {
	for (let node: ScrollNode | null = start; node; node = node.parentElement) {
		if (isScrollableY(node, overflowOf(node))) return node.scrollTop;
	}
	return documentScroller?.scrollTop ?? 0;
}

/** In-flight gesture state. */
export interface PullState {
	pulling: boolean;
	startX: number;
	startY: number;
	distance: number;
}

/** The "no gesture in progress" state. */
export const IDLE: PullState = Object.freeze({
	pulling: false,
	startX: 0,
	startY: 0,
	distance: 0,
});

/**
 * Arm the gesture on touch start. Returns `IDLE` — a full reset, never a
 * partial one — when the gesture must not run, so a rejected touch can never
 * leave a stale `distance` behind for a later `touchend` to act on.
 */
export function beginPull(opts: {
	x: number;
	y: number;
	atTop: boolean;
	enabled: boolean;
}): PullState {
	if (!opts.enabled || !opts.atTop) return IDLE;
	return { pulling: true, startX: opts.x, startY: opts.y, distance: 0 };
}

/**
 * Track finger movement. Disarms on an upward drag, and on a
 * horizontal-dominant one so the app's swipe drawers and dock gestures can't
 * accumulate enough vertical drift to trigger a reload.
 */
export function movePull(state: PullState, x: number, y: number): PullState {
	if (!state.pulling) return state;
	const dy = y - state.startY;
	const dx = x - state.startX;
	if (dy < 0) return IDLE;
	if (Math.abs(dx) > Math.abs(dy)) return IDLE;
	return { ...state, distance: dampen(dy) };
}

/**
 * Resolve the gesture on release. `refresh` is the ONLY signal the component
 * uses to call `location.reload()`.
 */
export function endPull(state: PullState): { state: PullState; refresh: boolean } {
	if (!state.pulling) return { state: IDLE, refresh: false };
	if (state.distance >= PULL_THRESHOLD_PX) {
		return { state: { ...IDLE, distance: PULL_REFRESHING_PX }, refresh: true };
	}
	return { state: IDLE, refresh: false };
}

/**
 * Abandon the gesture. The browser fires `touchcancel` (and no `touchend`)
 * whenever it takes the gesture over — a system back-swipe, the OS overscroll,
 * an incoming call. Without this the state stayed armed.
 */
export function cancelPull(): PullState {
	return IDLE;
}
