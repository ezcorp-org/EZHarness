/**
 * DOM-touching tests for the message-anchor helpers in
 * `chat-scroll-restore.ts`. These exercise `getBoundingClientRect` and
 * `querySelectorAll`, so they need jsdom (vitest), unlike the pure-logic
 * tests next door which run under `bun:test`.
 *
 * Anchors are the fix for the "refresh lands in the wrong place when the
 * conversation has tool calls or images" bug: a numeric scrollTop becomes
 * stale as soon as content above the viewport renders to a different
 * height, but the message-id + offset survives those layout shifts.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
	computeAnchor,
	scrollTopForAnchor,
	MESSAGE_ANCHOR_ATTR,
} from "$lib/chat-scroll-restore.js";

interface FakeMessage {
	id: string;
	height: number;
}

/**
 * Build a scroll container with N stacked message wrappers of given heights
 * and stub `getBoundingClientRect` so positions are deterministic.
 *
 * Container's top edge is at viewport y=0. Messages stack starting at
 * `firstMessageTop` (default 0), each with the requested height. We can
 * shift their reported `rect.top` by simulating a scroll via the
 * `scrollOffset` parameter to model what the user sees after scrolling.
 */
function buildContainer(
	messages: FakeMessage[],
	opts: { containerTop?: number; scrollOffset?: number; firstMessageTop?: number } = {},
): HTMLDivElement {
	const containerTop = opts.containerTop ?? 0;
	const scrollOffset = opts.scrollOffset ?? 0;
	const firstTop = opts.firstMessageTop ?? 0;

	const container = document.createElement("div");
	container.style.height = "500px";
	container.style.overflow = "auto";
	(container as { scrollTop: number }).scrollTop = scrollOffset;

	let cursorY = firstTop;
	for (const m of messages) {
		const wrapper = document.createElement("div");
		wrapper.setAttribute(MESSAGE_ANCHOR_ATTR, m.id);
		const top = cursorY - scrollOffset;
		const bottom = top + m.height;
		(wrapper as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
			({ top, bottom, left: 0, right: 0, width: 0, height: m.height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
		container.appendChild(wrapper);
		cursorY += m.height;
	}

	(container as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
		({
			top: containerTop, bottom: containerTop + 500, left: 0, right: 0, width: 800, height: 500,
			x: 0, y: containerTop, toJSON: () => ({}),
		}) as DOMRect;

	document.body.appendChild(container);
	return container;
}

describe("MESSAGE_ANCHOR_ATTR", () => {
	test("is `data-message-id` — the attribute ChatMessage.svelte writes", () => {
		// Locked in: changing this without updating ChatMessage.svelte (or
		// vice versa) silently breaks anchor capture/restore everywhere.
		expect(MESSAGE_ANCHOR_ATTR).toBe("data-message-id");
	});
});

describe("computeAnchor", () => {
	beforeEach(() => { document.body.innerHTML = ""; });
	afterEach(() => { document.body.innerHTML = ""; });

	test("returns null when no message wrappers are mounted", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		expect(computeAnchor(container)).toBeNull();
	});

	test("picks the message straddling the container's top edge", () => {
		// Three 200px messages, scrolled 250px. msg-1 (0..200) is gone,
		// msg-2 (200..400) straddles the top at offset -50.
		const container = buildContainer(
			[{ id: "msg-1", height: 200 }, { id: "msg-2", height: 200 }, { id: "msg-3", height: 200 }],
			{ scrollOffset: 250 },
		);
		const anchor = computeAnchor(container);
		expect(anchor).toEqual({ messageId: "msg-2", offset: -50 });
	});

	test("when scrolled to the top, picks the first message at offset 0", () => {
		const container = buildContainer(
			[{ id: "msg-1", height: 200 }, { id: "msg-2", height: 200 }],
			{ scrollOffset: 0 },
		);
		const anchor = computeAnchor(container);
		expect(anchor).toEqual({ messageId: "msg-1", offset: 0 });
	});

	test("when no message straddles the top, falls back to the first one below", () => {
		// Simulate a gap above msg-1 (firstMessageTop=100, no scroll). The
		// container top is at 0 and msg-1 starts at 100 — nothing straddles.
		const container = buildContainer(
			[{ id: "msg-1", height: 200 }, { id: "msg-2", height: 200 }],
			{ firstMessageTop: 100 },
		);
		const anchor = computeAnchor(container);
		expect(anchor).toEqual({ messageId: "msg-1", offset: 100 });
	});

	test("ignores wrappers without a usable id (defensive)", () => {
		const container = buildContainer([{ id: "msg-1", height: 200 }]);
		// Add a sibling wrapper that doesn't have the data-message-id attr —
		// querySelectorAll filters it out, so the anchor is still msg-1.
		const stray = document.createElement("div");
		container.appendChild(stray);
		expect(computeAnchor(container)?.messageId).toBe("msg-1");
	});
});

describe("scrollTopForAnchor", () => {
	beforeEach(() => { document.body.innerHTML = ""; });
	afterEach(() => { document.body.innerHTML = ""; });

	test("returns null when the message id isn't in the DOM", () => {
		const container = buildContainer([{ id: "msg-1", height: 200 }]);
		expect(scrollTopForAnchor(container, "missing", 0)).toBeNull();
	});

	test("computes the scrollTop that places the message at the saved offset", () => {
		// msg-2 starts at y=200 (no scroll yet). To put its top at offset
		// -50 from the container's top (i.e. straddling), scrollTop must
		// be 250.
		const container = buildContainer(
			[{ id: "msg-1", height: 200 }, { id: "msg-2", height: 200 }, { id: "msg-3", height: 200 }],
		);
		expect(scrollTopForAnchor(container, "msg-2", -50)).toBe(250);
	});

	test("round-trip: capturing then re-applying lands on the same offset (the bug we're fixing)", () => {
		// "Before reload" layout: msg-1 (200), msg-2 (200), msg-3 (400),
		// scrolled 350px. msg-2 spans y=200..400 → with scrollOffset 350 its
		// top is at -150 from the container top.
		const container = buildContainer(
			[
				{ id: "msg-1", height: 200 },
				{ id: "msg-2", height: 200 },
				{ id: "msg-3", height: 400 },
			],
			{ scrollOffset: 350 },
		);
		const anchor = computeAnchor(container)!;
		expect(anchor).toEqual({ messageId: "msg-2", offset: -150 });

		// "After reload" layout: msg-1's image expanded 200→300px. With a
		// stale numeric scrollTop of 350 the user would land 100px earlier
		// than they were. The anchor restore corrects for this — msg-2 must
		// re-land at offset -150 from the container top, which means
		// scrollTop = msg-2's new offsetTop (300) - (-150) = 450.
		document.body.innerHTML = "";
		const after = buildContainer(
			[
				{ id: "msg-1", height: 300 },
				{ id: "msg-2", height: 200 },
				{ id: "msg-3", height: 400 },
			],
			{ scrollOffset: 0 },
		);
		const target = scrollTopForAnchor(after, anchor.messageId, anchor.offset)!;
		expect(target).toBe(450);
		expect(target - 350).toBe(100); // exactly compensates for msg-1's growth
	});

	test("messageId values containing CSS-special characters are handled", () => {
		// IDs are persisted UUIDs, but the helper accepts arbitrary strings;
		// pass one with quotes/brackets to verify CSS.escape covers it.
		const container = buildContainer([{ id: 'weird"id[1]', height: 200 }]);
		// CSS.escape lets querySelector accept the string literally.
		expect(scrollTopForAnchor(container, 'weird"id[1]', 0)).toBe(0);
	});
});
