import { describe, expect, test } from "vitest";
import {
	IDLE,
	PULL_DAMPING,
	PULL_MAX_PX,
	PULL_MAX_VIEWPORT_PX,
	PULL_REFRESHING_PX,
	PULL_THRESHOLD_PX,
	beginPull,
	cancelPull,
	dampen,
	endPull,
	isPullEnabled,
	isScrollableY,
	movePull,
	nearestScrollTop,
	type PullState,
	type ScrollNode,
} from "../lib/components/pull-to-refresh-logic";

/**
 * These tests drive the REAL module the component ships. The previous
 * PullToRefresh suite re-implemented `computePullDistance`/`shouldTrigger`
 * locally, so it stayed green while the shipped guard was reloading the app on
 * every downward swipe — the whole bug this module exists to fix.
 */

/** Build a parent-linked chain of fake scroll nodes, innermost first. */
function chain(...nodes: Array<Partial<ScrollNode>>): ScrollNode {
	const built = nodes.map((n) => ({
		scrollTop: 0,
		scrollHeight: 100,
		clientHeight: 100,
		parentElement: null as ScrollNode | null,
		...n,
	}));
	for (let i = 0; i < built.length - 1; i++) built[i]!.parentElement = built[i + 1]!;
	return built[0]!;
}

describe("dampen", () => {
	test("applies the damping factor to downward travel", () => {
		expect(dampen(100)).toBe(100 * PULL_DAMPING);
		expect(dampen(50)).toBe(20);
		expect(dampen(10)).toBe(4);
	});

	test("clamps to PULL_MAX_PX", () => {
		expect(dampen(500)).toBe(PULL_MAX_PX);
		expect(dampen(1000)).toBe(PULL_MAX_PX);
		expect(dampen(300)).toBe(PULL_MAX_PX);
	});

	test("just below the clamp is not clamped", () => {
		expect(dampen(299)).toBeCloseTo(119.6, 1);
	});

	test("upward and zero travel produce no pull", () => {
		expect(dampen(-10)).toBe(0);
		expect(dampen(-1)).toBe(0);
		expect(dampen(0)).toBe(0);
	});

	test("the threshold is reached at exactly 200px of travel", () => {
		expect(dampen(200)).toBe(PULL_THRESHOLD_PX);
		expect(dampen(199)).toBeLessThan(PULL_THRESHOLD_PX);
	});
});

describe("isPullEnabled", () => {
	test("armed below the md breakpoint, where the indicator is visible", () => {
		expect(isPullEnabled(390)).toBe(true);
		expect(isPullEnabled(767)).toBe(true);
	});

	test("disarmed at and above the md breakpoint", () => {
		// Regression: the indicator is `md:hidden`, but the reload used to fire
		// at every width — an invisible full reload on desktop.
		expect(isPullEnabled(PULL_MAX_VIEWPORT_PX)).toBe(false);
		expect(isPullEnabled(1280)).toBe(false);
	});
});

describe("isScrollableY", () => {
	test("only overflow values that actually scroll count", () => {
		const overflowing = { scrollHeight: 500, clientHeight: 100 } as ScrollNode;
		expect(isScrollableY(overflowing, "auto")).toBe(true);
		expect(isScrollableY(overflowing, "scroll")).toBe(true);
		expect(isScrollableY(overflowing, "overlay")).toBe(true);
		expect(isScrollableY(overflowing, "visible")).toBe(false);
		expect(isScrollableY(overflowing, "hidden")).toBe(false);
		expect(isScrollableY(overflowing, "clip")).toBe(false);
	});

	test("a scrollable overflow with no overflowing content does not count", () => {
		const fits = { scrollHeight: 100, clientHeight: 100 } as ScrollNode;
		expect(isScrollableY(fits, "auto")).toBe(false);
	});
});

describe("nearestScrollTop", () => {
	const overflowAuto = () => "auto";

	test("reads the nearest scrollable ancestor, not the document", () => {
		// The exact production shape: an inner list scrolled down inside a
		// 100dvh shell whose document scroller is pinned at 0.
		const node = chain(
			{ scrollHeight: 100, clientHeight: 100 },
			{ scrollTop: 200, scrollHeight: 900, clientHeight: 400 },
		);
		expect(nearestScrollTop(node, overflowAuto, { scrollTop: 0 } as ScrollNode)).toBe(200);
	});

	test("skips ancestors whose content does not overflow", () => {
		const node = chain(
			{ scrollHeight: 50, clientHeight: 50 },
			{ scrollHeight: 100, clientHeight: 100 },
			{ scrollTop: 42, scrollHeight: 900, clientHeight: 400 },
		);
		expect(nearestScrollTop(node, overflowAuto, { scrollTop: 0 } as ScrollNode)).toBe(42);
	});

	test("skips ancestors whose overflow is not scrollable", () => {
		const node = chain(
			{ scrollTop: 99, scrollHeight: 900, clientHeight: 100 },
			{ scrollTop: 7, scrollHeight: 900, clientHeight: 100 },
		);
		const overflowOf = (n: ScrollNode) => (n.scrollTop === 99 ? "hidden" : "auto");
		expect(nearestScrollTop(node, overflowOf, { scrollTop: 0 } as ScrollNode)).toBe(7);
	});

	test("falls back to the document scroller when nothing scrolls", () => {
		const node = chain({ scrollHeight: 100, clientHeight: 100 });
		expect(nearestScrollTop(node, overflowAuto, { scrollTop: 13 } as ScrollNode)).toBe(13);
	});

	test("returns 0 with no start node and no document scroller", () => {
		expect(nearestScrollTop(null, overflowAuto, null)).toBe(0);
	});
});

describe("beginPull", () => {
	test("arms the gesture at the top of the scroller", () => {
		expect(beginPull({ x: 5, y: 10, atTop: true, enabled: true })).toEqual({
			pulling: true,
			startX: 5,
			startY: 10,
			distance: 0,
		});
	});

	test("stays idle when the scroller is not at the top", () => {
		// The core regression: mid-list, the gesture must not arm at all.
		expect(beginPull({ x: 5, y: 10, atTop: false, enabled: true })).toEqual(IDLE);
	});

	test("stays idle when disabled by viewport", () => {
		expect(beginPull({ x: 5, y: 10, atTop: true, enabled: false })).toEqual(IDLE);
	});

	test("a rejected touch clears an already-armed state", () => {
		// Guards the stale-state hole: a rejected touchstart used to `return`
		// early, leaving `pulling`/`distance` armed for the next touchend to
		// act on. Starting from a fully-armed, past-threshold state, a rejected
		// touchstart must wipe it so the following release cannot refresh.
		const armed: PullState = { pulling: true, startX: 0, startY: 0, distance: PULL_MAX_PX };
		expect(endPull(armed).refresh).toBe(true); // it really was armed to fire
		const afterReject = beginPull({ x: 1, y: 1, atTop: false, enabled: true });
		expect(afterReject).toEqual(IDLE);
		expect(endPull(afterReject).refresh).toBe(false);
	});
});

describe("movePull", () => {
	const armed = (): PullState => beginPull({ x: 100, y: 100, atTop: true, enabled: true });

	test("tracks damped downward travel", () => {
		expect(movePull(armed(), 100, 300).distance).toBe(PULL_THRESHOLD_PX);
	});

	test("ignores movement when not armed", () => {
		expect(movePull(IDLE, 100, 900)).toEqual(IDLE);
	});

	test("disarms on upward travel", () => {
		expect(movePull(armed(), 100, 40)).toEqual(IDLE);
	});

	test("disarms a horizontal-dominant swipe", () => {
		// The app has swipe drawers and a dock swipe; a mostly-sideways gesture
		// must never accumulate enough vertical drift to reload.
		expect(movePull(armed(), 400, 220)).toEqual(IDLE);
	});

	test("keeps a vertical-dominant swipe that drifts sideways", () => {
		expect(movePull(armed(), 150, 400).distance).toBe(dampen(300));
	});
});

describe("endPull", () => {
	test("triggers a refresh at or past the threshold", () => {
		const pulled = movePull(beginPull({ x: 0, y: 0, atTop: true, enabled: true }), 0, 200);
		const resolved = endPull(pulled);
		expect(resolved.refresh).toBe(true);
		expect(resolved.state.pulling).toBe(false);
		expect(resolved.state.distance).toBe(PULL_REFRESHING_PX);
	});

	test("does not trigger below the threshold, and resets", () => {
		const pulled = movePull(beginPull({ x: 0, y: 0, atTop: true, enabled: true }), 0, 199);
		expect(endPull(pulled)).toEqual({ state: IDLE, refresh: false });
	});

	test("an unarmed release never refreshes", () => {
		expect(endPull(IDLE)).toEqual({ state: IDLE, refresh: false });
	});

	test("a release with a stale distance but no arming never refreshes", () => {
		const stale: PullState = { pulling: false, startX: 0, startY: 0, distance: PULL_MAX_PX };
		expect(endPull(stale)).toEqual({ state: IDLE, refresh: false });
	});
});

describe("cancelPull", () => {
	test("touchcancel fully disarms", () => {
		// The browser fires touchcancel and no touchend when it takes over the
		// gesture; without this the state stayed armed for the next release.
		expect(cancelPull()).toEqual(IDLE);
		expect(endPull(cancelPull()).refresh).toBe(false);
	});
});

describe("end-to-end gesture sequences", () => {
	/** Replay a touch sequence through the state machine. */
	function replay(
		steps: Array<["start" | "move" | "end" | "cancel", number, number]>,
		opts: { atTop: boolean; width: number },
	): boolean {
		let state = IDLE;
		let refreshed = false;
		for (const [kind, x, y] of steps) {
			if (kind === "start") {
				state = beginPull({ x, y, atTop: opts.atTop, enabled: isPullEnabled(opts.width) });
			} else if (kind === "move") {
				state = movePull(state, x, y);
			} else if (kind === "cancel") {
				state = cancelPull();
			} else {
				const r = endPull(state);
				state = r.state;
				refreshed ||= r.refresh;
			}
		}
		return refreshed;
	}

	const bigSwipeDown: Array<["start" | "move" | "end" | "cancel", number, number]> = [
		["start", 100, 200],
		["move", 100, 320],
		["move", 100, 450],
		["end", 100, 450],
	];

	test("the intended pull at the top of a mobile list still refreshes", () => {
		expect(replay(bigSwipeDown, { atTop: true, width: 390 })).toBe(true);
	});

	test("the same swipe mid-list does NOT refresh", () => {
		expect(replay(bigSwipeDown, { atTop: false, width: 390 })).toBe(false);
	});

	test("the same swipe on desktop does NOT refresh", () => {
		expect(replay(bigSwipeDown, { atTop: true, width: 1280 })).toBe(false);
	});

	test("a cancelled pull followed by a tap does NOT refresh", () => {
		expect(
			replay(
				[
					["start", 100, 200],
					["move", 100, 450],
					["cancel", 100, 450],
					["start", 100, 400],
					["end", 100, 400],
				],
				{ atTop: true, width: 390 },
			),
		).toBe(false);
	});

	test("a short pull does not refresh", () => {
		expect(
			replay(
				[
					["start", 100, 200],
					["move", 100, 260],
					["end", 100, 260],
				],
				{ atTop: true, width: 390 },
			),
		).toBe(false);
	});
});
