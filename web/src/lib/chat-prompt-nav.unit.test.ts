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

	test("no prompts → null", () => {
		expect(
			resolvePromptNav({ ids: [], positions: [] }, "next", null, ANCHOR),
		).toBeNull();
	});

	test("next from a fresh (no pointer) state picks the first prompt below the fold", () => {
		// All three prompts are below the fold (nothing parked yet → current -1).
		const state = layout([200, 400, 600]);
		expect(resolvePromptNav(state, "next", null, ANCHOR)).toEqual({
			kind: "prompt",
			index: 0,
			id: "p0",
		});
	});

	test("prev from a fresh state above all prompts → null (nothing higher)", () => {
		const state = layout([200, 400, 600]);
		expect(resolvePromptNav(state, "prev", null, ANCHOR)).toBeNull();
	});

	test("re-derives current as the last prompt at/above the fold, then steps both ways", () => {
		// p0 above fold (-120), p1 parked near fold (80), p2 below (280).
		const state = layout([-120, 80, 280]);
		// next → the prompt below the current (p1) → p2.
		expect(resolvePromptNav(state, "next", null, ANCHOR)).toEqual({
			kind: "prompt",
			index: 2,
			id: "p2",
		});
		// prev → the prompt above the current (p1) → p0.
		expect(resolvePromptNav(state, "prev", null, ANCHOR)).toEqual({
			kind: "prompt",
			index: 0,
			id: "p0",
		});
	});

	test("trusts a still-parked pointer over the scroll-derived current", () => {
		// p1 is parked at the fold AND is the pointer → step strictly from it.
		const state = layout([-120, 80, 280]);
		expect(resolvePromptNav(state, "next", "p1", ANCHOR)).toEqual({
			kind: "prompt",
			index: 2,
			id: "p2",
		});
		expect(resolvePromptNav(state, "prev", "p1", ANCHOR)).toEqual({
			kind: "prompt",
			index: 0,
			id: "p0",
		});
	});

	test("stale pointer (scrolled far from anchor) falls back to scroll-derived current", () => {
		// Pointer p2, but p2 is far from the fold (user mouse-scrolled). Derive
		// from positions instead: last prompt <= anchor+band is p1.
		const state = layout([-120, 80, 600]);
		expect(resolvePromptNav(state, "next", "p2", ANCHOR)).toEqual({
			kind: "prompt",
			index: 2,
			id: "p2",
		});
		expect(resolvePromptNav(state, "prev", "p2", ANCHOR)).toEqual({
			kind: "prompt",
			index: 0,
			id: "p0",
		});
	});

	test("pointer id absent from the list falls back to scroll-derived current", () => {
		const state = layout([-120, 80, 280]);
		expect(resolvePromptNav(state, "next", "ghost", ANCHOR)).toEqual({
			kind: "prompt",
			index: 2,
			id: "p2",
		});
	});

	test("next on/past the last prompt → { kind: 'bottom' }", () => {
		// All prompts at/above the fold; current = last index → next overflows.
		const state = layout([-280, -120, 40]);
		expect(resolvePromptNav(state, "next", null, ANCHOR)).toEqual({
			kind: "bottom",
		});
		// prev still works (steps up off the last index).
		expect(resolvePromptNav(state, "prev", null, ANCHOR)).toEqual({
			kind: "prompt",
			index: 1,
			id: "p1",
		});
	});

	test("prev at the top → null (never wrap)", () => {
		// Single prompt parked at the fold → current 0, prev underflows.
		const state = layout([80]);
		expect(resolvePromptNav(state, "prev", null, ANCHOR)).toBeNull();
	});

	test("band tolerance: a prompt just outside anchor+band is not the current", () => {
		// p0 at anchor+band+1 (just below the line) → current stays -1.
		const state = layout([ANCHOR + 24 + 1, 400]);
		expect(resolvePromptNav(state, "next", null, ANCHOR)).toEqual({
			kind: "prompt",
			index: 0,
			id: "p0",
		});
		expect(resolvePromptNav(state, "prev", null, ANCHOR)).toBeNull();
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

	function setScroll(container: HTMLElement, scrollHeight: number): void {
		Object.defineProperty(container, "scrollHeight", {
			configurable: true,
			value: scrollHeight,
		});
		let scrollTop = 0;
		Object.defineProperty(container, "scrollTop", {
			configurable: true,
			get: () => scrollTop,
			set: (v: number) => {
				scrollTop = v;
			},
		});
	}

	// Only "u*" ids are user prompts.
	const isUserPrompt = (id: string) => id.startsWith("u");

	test("prompt step → onPromptScroll fires, scrollTop = max(0, stub), returns the prompt id", () => {
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
			pointerId: null,
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
		expect(result).toEqual({ acted: true, pointerId: "u0" });
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
			pointerId: null,
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			scrollTopForAnchor,
		});

		expect(container.scrollTop).toBe(0);
		expect(result).toEqual({ acted: true, pointerId: "u0" });
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
			pointerId: null,
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			scrollTopForAnchor,
		});

		expect(container.scrollTop).toBe(999); // untouched
		expect(result).toEqual({ acted: true, pointerId: "u0" });
	});

	test("next past the last prompt → onBottomScroll fires, scrollTop = scrollHeight, pointerId null", () => {
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
			pointerId: null,
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
		expect(result).toEqual({ acted: true, pointerId: null });
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
			pointerId: "u0",
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			scrollTopForAnchor,
			onPromptScroll,
			onBottomScroll,
		});

		expect(result).toEqual({ acted: false, pointerId: "u0" });
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
			pointerId: null,
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			band: 24,
			scrollTopForAnchor,
		});

		expect(scrollTopForAnchor).toHaveBeenCalledWith(container, "u0", OFFSET);
		expect(result).toEqual({ acted: true, pointerId: "u0" });
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
			pointerId: null,
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			scrollTopForAnchor: () => 10,
		});
		expect(promptResult).toEqual({ acted: true, pointerId: "u0" });
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
			pointerId: null,
			isUserPrompt,
			anchorAttr: ATTR,
			offset: OFFSET,
			scrollTopForAnchor: () => 0,
		});
		expect(bottomResult).toEqual({ acted: true, pointerId: null });
		expect(bottomContainer.scrollTop).toBe(7777);
	});
});
