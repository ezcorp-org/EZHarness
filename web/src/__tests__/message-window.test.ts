import { test, expect, describe } from "bun:test";
import {
	INITIAL_MESSAGE_WINDOW,
	MESSAGE_LOAD_STEP,
	computeVisibleMessages,
	hasOlderMessages,
	nextWindowSize,
	anchorScrollTop,
} from "../lib/message-window.js";

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe("INITIAL_MESSAGE_WINDOW / MESSAGE_LOAD_STEP defaults", () => {
	test("initial window is reasonable for a 'last chat plus a few above' UX", () => {
		expect(INITIAL_MESSAGE_WINDOW).toBeGreaterThanOrEqual(5);
		expect(INITIAL_MESSAGE_WINDOW).toBeLessThanOrEqual(50);
	});

	test("load step is bigger than initial so each scroll feels meaningful", () => {
		expect(MESSAGE_LOAD_STEP).toBeGreaterThanOrEqual(10);
	});
});

describe("computeVisibleMessages", () => {
	test("returns the original array when message count is below the window", () => {
		const msgs = range(5);
		const result = computeVisibleMessages(msgs, 15);
		expect(result).toBe(msgs); // identity preserved — no allocation
	});

	test("returns the original array when message count equals the window", () => {
		const msgs = range(15);
		const result = computeVisibleMessages(msgs, 15);
		expect(result).toBe(msgs);
	});

	test("returns the LAST N messages when count exceeds the window (anchored to the most recent)", () => {
		const msgs = range(50);
		const result = computeVisibleMessages(msgs, 15);
		expect(result.length).toBe(15);
		// Anchored at the tail: the newest message is the last item, not a middle slice
		expect(result[result.length - 1]).toBe(49);
		expect(result[0]).toBe(35);
	});

	test("returns empty when window size is zero or negative", () => {
		const msgs = range(20);
		expect(computeVisibleMessages(msgs, 0)).toEqual([]);
		expect(computeVisibleMessages(msgs, -5)).toEqual([]);
	});

	test("an empty messages array returns empty regardless of window size", () => {
		expect(computeVisibleMessages([], 15)).toEqual([]);
		expect(computeVisibleMessages([], 0)).toEqual([]);
	});

	test("preserves message identity inside the slice (no cloning)", () => {
		const a = { id: "a" };
		const b = { id: "b" };
		const c = { id: "c" };
		const result = computeVisibleMessages([a, b, c], 2);
		expect(result.length).toBe(2);
		expect(result[0]).toBe(b);
		expect(result[1]).toBe(c);
	});
});

describe("hasOlderMessages", () => {
	test("false when total fits within the window", () => {
		expect(hasOlderMessages(10, 15)).toBe(false);
		expect(hasOlderMessages(15, 15)).toBe(false);
		expect(hasOlderMessages(0, 15)).toBe(false);
	});

	test("true when total exceeds the window", () => {
		expect(hasOlderMessages(16, 15)).toBe(true);
		expect(hasOlderMessages(100, 15)).toBe(true);
	});

	test("treats over-sized window as 'no more older' (visible was clamped to total)", () => {
		// Window=100 visible against a 50-message conversation — every message is
		// already on screen, so no "Load older" should appear.
		expect(hasOlderMessages(50, 100)).toBe(false);
	});
});

describe("nextWindowSize", () => {
	test("grows the window by `step` when there is room", () => {
		expect(nextWindowSize(15, 100, 20)).toBe(35);
	});

	test("caps growth at the total count so the window never exceeds available", () => {
		expect(nextWindowSize(70, 76, 20)).toBe(76);
	});

	test("returning the existing size is a no-op when step <= 0", () => {
		expect(nextWindowSize(15, 100, 0)).toBe(15);
		expect(nextWindowSize(15, 100, -5)).toBe(15);
	});

	test("uses the default MESSAGE_LOAD_STEP when no step argument is given", () => {
		expect(nextWindowSize(15, 100)).toBe(15 + MESSAGE_LOAD_STEP);
	});

	test("never returns a negative size, even with negative inputs", () => {
		expect(nextWindowSize(-10, 50, 20)).toBe(20);
		expect(nextWindowSize(15, -10, 20)).toBe(0);
	});
});

describe("anchorScrollTop", () => {
	test("preserves the user's vertical offset by adding the height delta when content is prepended", () => {
		// Before: user is 800px down in a 2000px-tall scrollable. After loading
		// older messages, the scrollable grew to 5000px (3000px of new content
		// added at the top). The user should still be reading the same message,
		// which is now at offset 800 + 3000 = 3800.
		expect(anchorScrollTop(800, 2000, 5000)).toBe(3800);
	});

	test("keeps the user pinned when the user was scrolled to the very top", () => {
		// beforeTop=0 means the user just hit the sentinel. After a 3000px load,
		// the user lands at offset 3000 — i.e. the same message is at the top.
		expect(anchorScrollTop(0, 2000, 5000)).toBe(3000);
	});

	test("returns the original offset when the layout did not grow", () => {
		// Should never happen in practice but guards against weird transitions.
		expect(anchorScrollTop(800, 2000, 2000)).toBe(800);
	});

	test("never returns a negative scrollTop, even for shrunken layouts", () => {
		// If something else simultaneously removed content, do not produce a
		// negative scrollTop — clamp at 0 so the browser doesn't snap weirdly.
		expect(anchorScrollTop(800, 2000, 1500)).toBe(800);
		expect(anchorScrollTop(0, 2000, 0)).toBe(0);
	});
});

describe("end-to-end window flow (simulates a chat with > window-size messages)", () => {
	test("opens at the latest, then progressively reveals older on each scroll-up", () => {
		const allMsgs = range(76); // mirrors our real test conversation (76 msgs)

		// First render after open
		let visible = computeVisibleMessages(allMsgs, INITIAL_MESSAGE_WINDOW);
		expect(visible.length).toBe(15);
		expect(visible[visible.length - 1]).toBe(75); // newest at the bottom
		expect(hasOlderMessages(allMsgs.length, INITIAL_MESSAGE_WINDOW)).toBe(true);

		// Scroll-up #1
		let count = nextWindowSize(INITIAL_MESSAGE_WINDOW, allMsgs.length); // 15 + 20 = 35
		visible = computeVisibleMessages(allMsgs, count);
		expect(visible.length).toBe(35);
		expect(hasOlderMessages(allMsgs.length, count)).toBe(true);

		// Scroll-up #2
		count = nextWindowSize(count, allMsgs.length); // 35 + 20 = 55
		visible = computeVisibleMessages(allMsgs, count);
		expect(visible.length).toBe(55);
		expect(hasOlderMessages(allMsgs.length, count)).toBe(true);

		// Scroll-up #3 — 55 + 20 = 75, one short of the total
		count = nextWindowSize(count, allMsgs.length);
		visible = computeVisibleMessages(allMsgs, count);
		expect(visible.length).toBe(75);
		expect(hasOlderMessages(allMsgs.length, count)).toBe(true);

		// Scroll-up #4 — should saturate at the total (75 + 20 capped at 76)
		count = nextWindowSize(count, allMsgs.length);
		visible = computeVisibleMessages(allMsgs, count);
		expect(visible.length).toBe(76);
		expect(hasOlderMessages(allMsgs.length, count)).toBe(false);
	});

	test("a small chat (under the initial window) needs no pagination", () => {
		const allMsgs = range(4); // mirrors our small test convo
		const visible = computeVisibleMessages(allMsgs, INITIAL_MESSAGE_WINDOW);
		expect(visible.length).toBe(4);
		expect(hasOlderMessages(allMsgs.length, INITIAL_MESSAGE_WINDOW)).toBe(false);
	});
});
