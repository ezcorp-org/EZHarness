/**
 * Unit tests for chat-prompt-nav — the decision layer + DOM-glue behind
 * arrow-key navigation between chat prompts (user messages).
 *
 * The pure resolver (`resolvePromptNav`) takes pre-measured prompt offsets so
 * every branch is exercised directly; `applyPromptNav` is driven against a
 * jsdom container whose `getBoundingClientRect` / scroll geometry is stubbed.
 */
import { describe, test, expect, vi } from "vitest";
import {
	promptNavDirection,
	isTextEntryTarget,
	isNavBlockedByOverlay,
	resolvePromptNav,
	applyPromptNav,
	type PromptNavState,
} from "./chat-prompt-nav";

describe("promptNavDirection", () => {
	test("bare ArrowLeft → prev, bare ArrowRight → next", () => {
		expect(promptNavDirection({ key: "ArrowLeft" })).toBe("prev");
		expect(promptNavDirection({ key: "ArrowRight" })).toBe("next");
	});

	test("non-arrow keys → null", () => {
		expect(promptNavDirection({ key: "ArrowUp" })).toBeNull();
		expect(promptNavDirection({ key: "a" })).toBeNull();
	});

	test("each modifier individually defers to the browser (null)", () => {
		expect(promptNavDirection({ key: "ArrowLeft", altKey: true })).toBeNull();
		expect(promptNavDirection({ key: "ArrowLeft", ctrlKey: true })).toBeNull();
		expect(promptNavDirection({ key: "ArrowRight", metaKey: true })).toBeNull();
		expect(promptNavDirection({ key: "ArrowRight", shiftKey: true })).toBeNull();
	});

	test("an already-handled (defaultPrevented) arrow → null", () => {
		// A card in the thread — an image carousel, say — got there first. The
		// thread must not ALSO scroll under it.
		expect(
			promptNavDirection({ key: "ArrowLeft", defaultPrevented: true }),
		).toBeNull();
		expect(
			promptNavDirection({ key: "ArrowRight", defaultPrevented: true }),
		).toBeNull();
	});
});

describe("isNavBlockedByOverlay", () => {
	const doc = (selector: string | null) => ({
		querySelector: (q: string) => (q === selector ? ({} as Element) : null),
	});

	test("an open modal (aria-modal=true) blocks the nav", () => {
		expect(isNavBlockedByOverlay(doc('[aria-modal="true"]'))).toBe(true);
	});

	test("no modal in the DOM → not blocked", () => {
		expect(isNavBlockedByOverlay(doc(null))).toBe(false);
	});

	test("a non-modal panel (aria-modal=false, e.g. the Ez panel) → not blocked", () => {
		// Only `aria-modal="true"` is queried, so the inline panel never matches.
		expect(isNavBlockedByOverlay(doc('[aria-modal="false"]'))).toBe(false);
	});
});

describe("isTextEntryTarget", () => {
	test("null target → false", () => {
		expect(isTextEntryTarget(null)).toBe(false);
	});

	test("non-string tagName → false", () => {
		// An EventTarget without a string tagName (e.g. window/document-like).
		expect(isTextEntryTarget({} as EventTarget)).toBe(false);
		expect(isTextEntryTarget({ tagName: 123 } as unknown as EventTarget)).toBe(
			false,
		);
	});

	test("form text controls → true (incl. lowercase for the toUpperCase branch)", () => {
		for (const tag of ["INPUT", "TEXTAREA", "SELECT", "input"]) {
			const el = { tagName: tag } as unknown as EventTarget;
			expect(isTextEntryTarget(el)).toBe(true);
		}
	});

	test("contenteditable element → true", () => {
		const el = {
			tagName: "DIV",
			isContentEditable: true,
		} as unknown as EventTarget;
		expect(isTextEntryTarget(el)).toBe(true);
	});

	test("plain non-editable element → false", () => {
		const el = {
			tagName: "DIV",
			isContentEditable: false,
		} as unknown as EventTarget;
		expect(isTextEntryTarget(el)).toBe(false);
	});
});

describe("resolvePromptNav", () => {
	const ANCHOR = 80;
	// Helper: parallel ids/positions in top→bottom render order.
	const layout = (positions: number[]): PromptNavState => ({
		ids: positions.map((_, i) => `p${i}`),
		positions,
	});
	// The scroll state the pointer was recorded in. Every "pointer is live" case
	// passes the same state back in as the container's live view; a user scroll
	// is a different `scrollTop` at the SAME `scrollHeight`, and a reflow is a
	// different `scrollHeight`.
	const AT = 500;
	const HEIGHT = 4000;
	const view = (scrollTop = AT, scrollHeight = HEIGHT) => ({ scrollTop, scrollHeight });
	const at = (id: string) => ({ id, scrollTop: AT, scrollHeight: HEIGHT });

	test("no prompts → null", () => {
		expect(
			resolvePromptNav({ ids: [], positions: [] }, "next", null, view(0), ANCHOR),
		).toBeNull();
	});

	test("next from a fresh (no pointer) state picks the first prompt below the fold", () => {
		// All three prompts are below the fold (nothing parked yet → current -1).
		const state = layout([200, 400, 600]);
		expect(resolvePromptNav(state, "next", null, view(0), ANCHOR)).toEqual({
			kind: "prompt",
			index: 0,
			id: "p0",
		});
	});

	test("prev from a fresh state above all prompts → null (nothing higher)", () => {
		const state = layout([200, 400, 600]);
		expect(resolvePromptNav(state, "prev", null, view(0), ANCHOR)).toBeNull();
	});

	test("re-derives current as the last prompt at/above the fold, then steps both ways", () => {
		// p0 above fold (-120), p1 parked near fold (80), p2 below (280).
		const state = layout([-120, 80, 280]);
		// next → the prompt below the current (p1) → p2.
		expect(resolvePromptNav(state, "next", null, view(0), ANCHOR)).toEqual({
			kind: "prompt",
			index: 2,
			id: "p2",
		});
		// prev → the prompt above the current (p1) → p0.
		expect(resolvePromptNav(state, "prev", null, view(0), ANCHOR)).toEqual({
			kind: "prompt",
			index: 0,
			id: "p0",
		});
	});

	test("trusts a live pointer over the scroll-derived current", () => {
		// p1 is the pointer and nothing has scrolled → step strictly from it,
		// even though the fold-derived current would be p0.
		const state = layout([-500, -300, 280]);
		expect(resolvePromptNav(state, "next", at("p1"), view(), ANCHOR)).toEqual({
			kind: "prompt",
			index: 2,
			id: "p2",
		});
		expect(resolvePromptNav(state, "prev", at("p1"), view(), ANCHOR)).toEqual({
			kind: "prompt",
			index: 0,
			id: "p0",
		});
	});

	test("a pointer whose prompt drifted off the fold is STILL live (layout moved, not the user)", () => {
		// p1 was parked at the fold; a card above it grew and pushed it to 600.
		// Nothing scrolled, so the pointer still decides — the regression this
		// guards is the nav re-deriving p0 and refusing to move past p1.
		const state = layout([-120, 600, 900]);
		expect(resolvePromptNav(state, "next", at("p1"), view(), ANCHOR)).toEqual({
			kind: "prompt",
			index: 2,
			id: "p2",
		});
	});

	test("stale pointer (the user scrolled since) falls back to scroll-derived current", () => {
		// Same layout, but the container has moved 40px from where the nav left
		// it → the pointer is dropped and the fold decides (current = p1).
		const state = layout([-120, 80, 600]);
		expect(resolvePromptNav(state, "next", at("p2"), view(AT + 40), ANCHOR)).toEqual({
			kind: "prompt",
			index: 2,
			id: "p2",
		});
		expect(resolvePromptNav(state, "prev", at("p2"), view(AT + 40), ANCHOR)).toEqual({
			kind: "prompt",
			index: 0,
			id: "p0",
		});
	});

	test("sub-pixel scroll drift keeps the pointer live", () => {
		const state = layout([-500, -300, 280]);
		expect(resolvePromptNav(state, "next", at("p1"), view(AT + 1), ANCHOR)).toEqual({
			kind: "prompt",
			index: 2,
			id: "p2",
		});
	});

	test("a scroll that came WITH a reflow is the browser, not the user — pointer stays live", () => {
		// A card mounted above the fold and the thread got taller; the browser's
		// scroll anchoring shifted scrollTop to hold the view steady. That must
		// not read as "the user scrolled" — it is the exact case where the fold
		// re-derive hands back a prompt the user already walked past (p0 → the
		// press skips p1 entirely).
		const state = layout([-120, 280, 900]);
		expect(
			resolvePromptNav(
				state,
				"prev",
				at("p1"),
				view(AT + 201, HEIGHT + 402),
				ANCHOR,
			),
		).toEqual({ kind: "prompt", index: 0, id: "p0" });
	});

	test("pointer id absent from the list falls back to scroll-derived current", () => {
		const state = layout([-120, 80, 280]);
		expect(
			resolvePromptNav(
				state,
				"next",
				{ id: "ghost", scrollTop: AT, scrollHeight: HEIGHT },
				view(),
				ANCHOR,
			),
		).toEqual({ kind: "prompt", index: 2, id: "p2" });
	});

	test("next on/past the last prompt → { kind: 'bottom' }", () => {
		// All prompts at/above the fold; current = last index → next overflows.
		const state = layout([-280, -120, 40]);
		expect(resolvePromptNav(state, "next", null, view(0), ANCHOR)).toEqual({
			kind: "bottom",
		});
		// prev still works (steps up off the last index).
		expect(resolvePromptNav(state, "prev", null, view(0), ANCHOR)).toEqual({
			kind: "prompt",
			index: 1,
			id: "p1",
		});
	});

	test("prev at the top → null (never wrap)", () => {
		// Single prompt parked at the fold → current 0, prev underflows.
		const state = layout([80]);
		expect(resolvePromptNav(state, "prev", null, view(0), ANCHOR)).toBeNull();
	});

	test("band tolerance: a prompt just outside anchor+band is not the current", () => {
		// p0 at anchor+band+1 (just below the line) → current stays -1.
		const state = layout([ANCHOR + 24 + 1, 400]);
		expect(resolvePromptNav(state, "next", null, view(0), ANCHOR)).toEqual({
			kind: "prompt",
			index: 0,
			id: "p0",
		});
		expect(resolvePromptNav(state, "prev", null, view(0), ANCHOR)).toBeNull();
	});
});

describe("applyPromptNav (DOM glue)", () => {
	const ATTR = "data-message-id";
	const OFFSET = 80;

	/**
	 * Build a container of message rows. Each entry is `[id, top]`; an id of
	 * `null` produces a row with NO anchor attribute (to hit the `!id` skip).
	 * `top` is the node's `getBoundingClientRect().top`; the container's own top
	 * is fixed at 0 so the measured position equals `top`.
	 */
	function buildContainer(rows: Array<[string | null, number]>): HTMLElement {
		const container = document.createElement("div");
		stubRect(container, 0);
		for (const [id, top] of rows) {
			const node = document.createElement("div");
			if (id !== null) node.setAttribute(ATTR, id);
			stubRect(node, top);
			container.appendChild(node);
		}
		return container;
	}

	function stubRect(el: HTMLElement, top: number): void {
		Object.defineProperty(el, "getBoundingClientRect", {
			configurable: true,
			value: () => ({
				top,
				left: 0,
				right: 0,
				bottom: 0,
				width: 0,
				height: 0,
				x: 0,
				y: 0,
				toJSON() {},
			}),
		});
	}

	/**
	 * Give the container a scroll range. `clientHeight` (default 0, i.e. the
	 * whole `scrollHeight` is scrollable) sets the browser's clamp: a write past
	 * `scrollHeight - clientHeight` comes to rest AT that maximum, exactly as a
	 * real element does.
	 */
	function setScroll(
		container: HTMLElement,
		scrollHeight: number,
		clientHeight = 0,
	): void {
		Object.defineProperty(container, "scrollHeight", {
			configurable: true,
			value: scrollHeight,
		});
		Object.defineProperty(container, "clientHeight", {
			configurable: true,
			value: clientHeight,
		});
		let scrollTop = 0;
		Object.defineProperty(container, "scrollTop", {
			configurable: true,
			get: () => scrollTop,
			set: (v: number) => {
				scrollTop = Math.max(0, Math.min(v, scrollHeight - clientHeight));
			},
		});
	}

	// Only "u*" ids are user prompts.
	const isUserPrompt = (id: string) => id.startsWith("u");

	test("prompt step → onPromptScroll fires, scrollTop = max(0, stub), pointer records where we landed", () => {
		// u0 below fold (200), u1 (400). Fresh pointer → next picks u0.
		const container = buildContainer([
			["u0", 200],
			["u1", 400],
		]);
		setScroll(container, 5000);
		const onPromptScroll = vi.fn();
		const onBottomScroll = vi.fn();
		const scrollTopForAnchor = vi.fn(() => 333);

		const result = applyPromptNav({
			container,
			direction: "next",
			pointer: null,
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			scrollTopForAnchor,
			onPromptScroll,
			onBottomScroll,
		});

		expect(onPromptScroll).toHaveBeenCalledTimes(1);
		expect(onBottomScroll).not.toHaveBeenCalled();
		expect(scrollTopForAnchor).toHaveBeenCalledWith(container, "u0", OFFSET);
		expect(container.scrollTop).toBe(333);
		expect(result).toEqual({
			acted: true,
			pointer: { id: "u0", scrollTop: 333, scrollHeight: 5000 },
		});
	});

	test("stub returns a negative number → scrollTop clamps to 0", () => {
		const container = buildContainer([
			["u0", 200],
			["u1", 400],
		]);
		setScroll(container, 5000);
		const scrollTopForAnchor = vi.fn(() => -50);

		const result = applyPromptNav({
			container,
			direction: "next",
			pointer: null,
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			scrollTopForAnchor,
		});

		expect(container.scrollTop).toBe(0);
		expect(result).toEqual({ acted: true, pointer: { id: "u0", scrollTop: 0, scrollHeight: 5000 } });
	});

	test("stub returns null → scrollTop unchanged but still acted", () => {
		const container = buildContainer([
			["u0", 200],
			["u1", 400],
		]);
		setScroll(container, 5000);
		container.scrollTop = 999; // pre-existing scroll position
		const scrollTopForAnchor = vi.fn(() => null);

		const result = applyPromptNav({
			container,
			direction: "next",
			pointer: null,
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			scrollTopForAnchor,
		});

		expect(container.scrollTop).toBe(999); // untouched
		expect(result).toEqual({
			acted: true,
			pointer: { id: "u0", scrollTop: 999, scrollHeight: 5000 },
		});
	});

	test("a live pointer keeps stepping even when the prompt could not be parked at the fold", () => {
		// u0/u1 sit in the final screenful; u1 is 300px below the fold because
		// the scroll clamped. Nothing has scrolled since, so the pointer holds
		// and `prev` walks back up instead of re-deriving the same prompt.
		const container = buildContainer([
			["u0", 100],
			["u1", 380],
		]);
		setScroll(container, 2000, 1200); // max scroll 800
		container.scrollTop = 800;
		const scrollTopForAnchor = vi.fn(() => 120);

		const result = applyPromptNav({
			container,
			direction: "prev",
			pointer: { id: "u1", scrollTop: 800, scrollHeight: 2000 },
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			scrollTopForAnchor,
		});

		expect(scrollTopForAnchor).toHaveBeenCalledWith(container, "u0", OFFSET);
		expect(result).toEqual({
			acted: true,
			pointer: { id: "u0", scrollTop: 120, scrollHeight: 2000 },
		});
	});

	test("next onto a prompt that cannot be parked (past the scroll range) → bottom", () => {
		// The next prompt is inside the last screenful: parking it at the fold
		// would need scrollTop 900 but the range ends at 800. It is already
		// visible down there, so go to the bottom rather than freeze in place —
		// the stall this whole fix is about.
		const container = buildContainer([
			["u0", 40],
			["u1", 300],
		]);
		setScroll(container, 2000, 1200); // max scroll 800
		const onPromptScroll = vi.fn();
		const onBottomScroll = vi.fn();
		const scrollTopForAnchor = vi.fn(() => 900);

		const result = applyPromptNav({
			container,
			direction: "next",
			pointer: null,
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			scrollTopForAnchor,
			onPromptScroll,
			onBottomScroll,
		});

		expect(onBottomScroll).toHaveBeenCalledTimes(1);
		expect(onPromptScroll).not.toHaveBeenCalled();
		expect(container.scrollTop).toBe(800); // the clamped bottom
		expect(result).toEqual({ acted: true, pointer: null });
	});

	test("a next step that exactly reaches the end of the range still parks (no off-by-one to bottom)", () => {
		const container = buildContainer([
			["u0", 40],
			["u1", 300],
		]);
		setScroll(container, 2000, 1200); // max scroll 800
		const onBottomScroll = vi.fn();
		const scrollTopForAnchor = vi.fn(() => 800);

		const result = applyPromptNav({
			container,
			direction: "next",
			pointer: null,
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			scrollTopForAnchor,
			onBottomScroll,
		});

		expect(onBottomScroll).not.toHaveBeenCalled();
		expect(result).toEqual({
			acted: true,
			pointer: { id: "u1", scrollTop: 800, scrollHeight: 2000 },
		});
	});

	test("prev is never redirected to the bottom, even past the scroll range", () => {
		// Same unparkable target, going UP: falling through to the bottom would
		// be backwards, so we scroll as far as we can and keep the pointer.
		const container = buildContainer([
			["u0", 40],
			["u1", 300],
		]);
		setScroll(container, 2000, 1200); // max scroll 800
		container.scrollTop = 800;
		const onBottomScroll = vi.fn();
		const scrollTopForAnchor = vi.fn(() => 900);

		const result = applyPromptNav({
			container,
			direction: "prev",
			pointer: { id: "u1", scrollTop: 800, scrollHeight: 2000 },
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			scrollTopForAnchor,
			onBottomScroll,
		});

		expect(onBottomScroll).not.toHaveBeenCalled();
		expect(result).toEqual({
			acted: true,
			pointer: { id: "u0", scrollTop: 800, scrollHeight: 2000 },
		});
	});

	test("next past the last prompt → onBottomScroll fires, scrollTop = scrollHeight, pointer null", () => {
		// Both prompts at/above fold → current = last → next overflows to bottom.
		const container = buildContainer([
			["u0", -200],
			["u1", -50],
		]);
		setScroll(container, 4242);
		const onPromptScroll = vi.fn();
		const onBottomScroll = vi.fn();
		const scrollTopForAnchor = vi.fn(() => 0);

		const result = applyPromptNav({
			container,
			direction: "next",
			pointer: null,
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			scrollTopForAnchor,
			onPromptScroll,
			onBottomScroll,
		});

		expect(onBottomScroll).toHaveBeenCalledTimes(1);
		expect(onPromptScroll).not.toHaveBeenCalled();
		expect(scrollTopForAnchor).not.toHaveBeenCalled();
		expect(container.scrollTop).toBe(4242);
		expect(container.scrollTop).toBe(container.scrollHeight);
		expect(result).toEqual({ acted: true, pointer: null });
	});

	test("no-op (prev at the top) → not acted, pointer unchanged, no scroll, no callbacks", () => {
		// Single prompt parked at the fold → current 0, prev underflows → null.
		const container = buildContainer([["u0", OFFSET]]);
		setScroll(container, 5000);
		container.scrollTop = 123;
		const onPromptScroll = vi.fn();
		const onBottomScroll = vi.fn();
		const scrollTopForAnchor = vi.fn(() => 0);

		const result = applyPromptNav({
			container,
			direction: "prev",
			pointer: { id: "u0", scrollTop: 123, scrollHeight: 5000 },
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			scrollTopForAnchor,
			onPromptScroll,
			onBottomScroll,
		});

		expect(result).toEqual({
			acted: false,
			pointer: { id: "u0", scrollTop: 123, scrollHeight: 5000 },
		});
		expect(container.scrollTop).toBe(123); // no scroll
		expect(onPromptScroll).not.toHaveBeenCalled();
		expect(onBottomScroll).not.toHaveBeenCalled();
		expect(scrollTopForAnchor).not.toHaveBeenCalled();
	});

	test("non-user-prompt rows and attribute-less rows are skipped during measurement", () => {
		// Row order: assistant (a0, skipped by isUserPrompt), no-attr (null,
		// skipped by !id), then the user prompts u0/u1. Only u0/u1 are measured,
		// so a fresh `next` resolves to u0 (proving the others were filtered out).
		const container = buildContainer([
			["a0", 100],
			[null, 150],
			["u0", 200],
			["u1", 400],
		]);
		setScroll(container, 5000);
		const scrollTopForAnchor = vi.fn(() => 0);

		const result = applyPromptNav({
			container,
			direction: "next",
			pointer: null,
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			band: 24,
			scrollTopForAnchor,
		});

		expect(scrollTopForAnchor).toHaveBeenCalledWith(container, "u0", OFFSET);
		expect(result).toEqual({ acted: true, pointer: { id: "u0", scrollTop: 0, scrollHeight: 5000 } });
	});

	test("missing onPromptScroll / onBottomScroll callbacks (optional-chaining no-ops)", () => {
		// Prompt step without onPromptScroll.
		const promptContainer = buildContainer([
			["u0", 200],
			["u1", 400],
		]);
		setScroll(promptContainer, 5000);
		const promptResult = applyPromptNav({
			container: promptContainer,
			direction: "next",
			pointer: null,
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			scrollTopForAnchor: () => 10,
		});
		expect(promptResult).toEqual({
			acted: true,
			pointer: { id: "u0", scrollTop: 10, scrollHeight: 5000 },
		});
		expect(promptContainer.scrollTop).toBe(10);

		// Bottom fall-through without onBottomScroll.
		const bottomContainer = buildContainer([
			["u0", -200],
			["u1", -50],
		]);
		setScroll(bottomContainer, 7777);
		const bottomResult = applyPromptNav({
			container: bottomContainer,
			direction: "next",
			pointer: null,
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			scrollTopForAnchor: () => 0,
		});
		expect(bottomResult).toEqual({ acted: true, pointer: null });
		expect(bottomContainer.scrollTop).toBe(7777);
	});
});
