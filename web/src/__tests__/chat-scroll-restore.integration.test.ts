/**
 * Integration test: chat-scroll-restore + the streaming store + the
 * pagination window.
 *
 * Mirrors the realistic chat-page flow:
 *   1. user opens conv-A → no stream, no cache → first-visit (scroll to bottom)
 *   2. user expands the message-window via loadOlderMessages → windowSize cached
 *   3. user scrolls up among the older messages → scrollTop cached
 *   4. user switches to conv-B → no stream, no cache → first-visit
 *   5. user goes back to A while stream-A is NOT active → both windowSize
 *      AND scrollTop restored, so the user lands on the SAME message they
 *      were reading
 *   6. while user is on A, a stream starts → after switching away and back,
 *      the active-stream branch wins and we scroll to bottom (windowSize is
 *      still restored — only the scrollTop changes)
 *
 * The decision flow used here matches the call site in the chat
 * +page.svelte exactly, so any drift between the helper and the page would
 * show up as a test discrepancy.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
	decideOpenScroll,
	getCachedScrollState,
	updateCachedScrollState,
	_resetScrollCache,
	type ScrollState,
} from "$lib/chat-scroll-restore.js";
import { INITIAL_MESSAGE_WINDOW, nextWindowSize, MESSAGE_LOAD_STEP } from "$lib/message-window.js";

interface StreamingStoreShape {
	streamingRunToConversation: Record<string, string>;
}

function makeStreamingStore(): StreamingStoreShape {
	return { streamingRunToConversation: {} };
}

function startStream(store: StreamingStoreShape, runId: string, convId: string) {
	store.streamingRunToConversation = {
		...store.streamingRunToConversation,
		[runId]: convId,
	};
}

function stopStream(store: StreamingStoreShape, runId: string) {
	const next = { ...store.streamingRunToConversation };
	delete next[runId];
	store.streamingRunToConversation = next;
}

/** Mirror of the call site in +page.svelte's initial-scroll effect. */
function decideForOpen(store: StreamingStoreShape, convId: string) {
	const cached = getCachedScrollState(convId);
	return decideOpenScroll({
		convId,
		streamingRunToConversation: store.streamingRunToConversation,
		cachedScrollTop: cached?.scrollTop,
	});
}

/** Mirror of the convId-reset effect in +page.svelte:
 *  visibleMessageCount = cached?.windowSize ?? INITIAL_MESSAGE_WINDOW. */
function restoreWindowSize(convId: string): number {
	return getCachedScrollState(convId)?.windowSize ?? INITIAL_MESSAGE_WINDOW;
}

/** Mirror of loadOlderMessages: bump the window AND persist it. */
function expandWindow(convId: string, currentSize: number, totalCount: number): number {
	const next = nextWindowSize(currentSize, totalCount, MESSAGE_LOAD_STEP);
	updateCachedScrollState(convId, { windowSize: next });
	return next;
}

describe("chat-scroll-restore — integration with streaming store + pagination", () => {
	let store: StreamingStoreShape;

	beforeEach(() => {
		_resetScrollCache();
		store = makeStreamingStore();
	});

	test("full lifecycle: first visit → scroll up → switch away → return → restore", () => {
		// 1. First visit to conv-A
		expect(decideForOpen(store, "conv-A")).toEqual({
			kind: "scroll-to-bottom",
			reason: "first-visit",
		});

		// 2. User scrolls up (simulates the scroll-listener effect firing).
		updateCachedScrollState("conv-A", { scrollTop: 420 });

		// 3. User opens conv-B for the first time.
		expect(decideForOpen(store, "conv-B")).toEqual({
			kind: "scroll-to-bottom",
			reason: "first-visit",
		});

		// 4. User returns to conv-A; no stream on A → restore cached position.
		expect(decideForOpen(store, "conv-A")).toEqual({
			kind: "restore",
			scrollTop: 420,
		});
	});

	test("active stream on this conv overrides cached position (windowSize still restored)", () => {
		updateCachedScrollState("conv-A", { scrollTop: 100, windowSize: 55 });
		startStream(store, "run-1", "conv-A");

		// scrollTop decision: active-stream → scroll-to-bottom
		expect(decideForOpen(store, "conv-A")).toEqual({
			kind: "scroll-to-bottom",
			reason: "active-stream",
		});

		// windowSize is restored independently — the user's expanded context
		// is preserved even when we land at the bottom of it.
		expect(restoreWindowSize("conv-A")).toBe(55);
	});

	test("after stopStream, decision flips back to restore for the same conv", () => {
		updateCachedScrollState("conv-A", { scrollTop: 100 });
		startStream(store, "run-1", "conv-A");

		expect(decideForOpen(store, "conv-A")).toEqual({
			kind: "scroll-to-bottom",
			reason: "active-stream",
		});

		stopStream(store, "run-1");

		expect(decideForOpen(store, "conv-A")).toEqual({
			kind: "restore",
			scrollTop: 100,
		});
	});

	test("stream on a different conv does not override our restore", () => {
		updateCachedScrollState("conv-A", { scrollTop: 50 });
		startStream(store, "run-B", "conv-B");

		expect(decideForOpen(store, "conv-A")).toEqual({
			kind: "restore",
			scrollTop: 50,
		});
		expect(decideForOpen(store, "conv-B")).toEqual({
			kind: "scroll-to-bottom",
			reason: "active-stream",
		});
	});

	test("two convs maintain independent cached positions and window sizes", () => {
		updateCachedScrollState("conv-A", { scrollTop: 100, windowSize: 35 });
		updateCachedScrollState("conv-B", { scrollTop: 200, windowSize: 75 });

		expect(decideForOpen(store, "conv-A")).toEqual({
			kind: "restore",
			scrollTop: 100,
		});
		expect(restoreWindowSize("conv-A")).toBe(35);

		expect(decideForOpen(store, "conv-B")).toEqual({
			kind: "restore",
			scrollTop: 200,
		});
		expect(restoreWindowSize("conv-B")).toBe(75);
	});

	test("paginated context is preserved across switch — same window, same scrollTop", () => {
		// User is on conv-A with 100 messages. Default window is 15.
		const totalA = 100;
		let windowA = restoreWindowSize("conv-A");
		expect(windowA).toBe(INITIAL_MESSAGE_WINDOW);

		// User scrolls up, triggering loadOlderMessages — twice.
		windowA = expandWindow("conv-A", windowA, totalA); // 15 → 35
		windowA = expandWindow("conv-A", windowA, totalA); // 35 → 55
		expect(windowA).toBe(55);
		// Window persisted.
		expect(getCachedScrollState("conv-A")?.windowSize).toBe(55);

		// User scrolls to a specific scrollTop within the expanded window.
		updateCachedScrollState("conv-A", { scrollTop: 1230 });

		// User switches to conv-B (default window).
		const windowB = restoreWindowSize("conv-B");
		expect(windowB).toBe(INITIAL_MESSAGE_WINDOW);

		// User returns to conv-A: BOTH window AND scrollTop are restored.
		expect(restoreWindowSize("conv-A")).toBe(55);
		expect(decideForOpen(store, "conv-A")).toEqual({
			kind: "restore",
			scrollTop: 1230,
		});
	});

	test("first-visit semantics survive a windowSize-only cache write", () => {
		// Edge case: if the convId-reset effect fires and writes the default
		// windowSize back into the cache (during a first visit), that MUST
		// NOT flip the decision from first-visit → restore. The cache only
		// counts as "restore-able" if scrollTop is set.
		updateCachedScrollState("conv-A", { windowSize: INITIAL_MESSAGE_WINDOW });
		expect(decideForOpen(store, "conv-A")).toEqual({
			kind: "scroll-to-bottom",
			reason: "first-visit",
		});
	});

	test("active stream + cached window: open scrolls to bottom AND keeps expanded window", () => {
		// Realistic scenario: user expanded window on A, scrolled up, then
		// triggered a new run (stream starts). Switches to B, comes back.
		// Should land at bottom (active stream) but keep the 75-window so
		// older messages stay rendered.
		updateCachedScrollState("conv-A", { scrollTop: 1000, windowSize: 75 });
		startStream(store, "run-A", "conv-A");

		expect(decideForOpen(store, "conv-A")).toEqual({
			kind: "scroll-to-bottom",
			reason: "active-stream",
		});
		expect(restoreWindowSize("conv-A")).toBe(75);
	});

	test("scroll listener writes overwrite as user scrolls (cache reflects latest)", () => {
		updateCachedScrollState("conv-A", { scrollTop: 100 });
		updateCachedScrollState("conv-A", { scrollTop: 250 });
		updateCachedScrollState("conv-A", { scrollTop: 410 });

		expect(decideForOpen(store, "conv-A")).toEqual({
			kind: "restore",
			scrollTop: 410,
		});
	});

	test("stream completes while user is away → on return, restore (not scroll-to-bottom)", () => {
		// Adversarial scenario explicitly chosen by the user:
		// "Only actively-streaming content" counts as new text. So a stream
		// that COMPLETED during the user's absence must NOT trigger a
		// scroll-to-bottom on return — the cached scroll position wins.
		updateCachedScrollState("conv-A", { scrollTop: 800, windowSize: 35 });
		// Stream is active when user leaves.
		startStream(store, "run-A", "conv-A");
		expect(decideForOpen(store, "conv-A")).toEqual({
			kind: "scroll-to-bottom",
			reason: "active-stream",
		});

		// Stream completes (run:complete handler in stores.ts calls
		// stopStreaming(runId), which removes the runId from the map).
		stopStream(store, "run-A");

		// User returns: no active stream, scroll position is restored, AND
		// the expanded window is restored.
		expect(decideForOpen(store, "conv-A")).toEqual({
			kind: "restore",
			scrollTop: 800,
		});
		expect(restoreWindowSize("conv-A")).toBe(35);
	});

	test("paginated context across stream lifecycle: expand → stream → switch → return", () => {
		// Realistic flow:
		//  1. user expands window to 55 on conv-A
		//  2. user scrolls to a saved offset within the expanded window
		//  3. a stream starts (e.g., they sent a message)
		//  4. they switch to B mid-stream
		//  5. stream completes while away
		//  6. they return to A — should restore BOTH the offset and the window
		//     (active-stream branch should NOT fire because it's already done)
		const totalA = 100;
		let windowA = expandWindow("conv-A", INITIAL_MESSAGE_WINDOW, totalA); // → 35
		windowA = expandWindow("conv-A", windowA, totalA); // → 55
		expect(windowA).toBe(55);

		updateCachedScrollState("conv-A", { scrollTop: 1500 });
		startStream(store, "run-A", "conv-A");
		// User on A, stream active.

		// Switch to B (no streaming there).
		expect(decideForOpen(store, "conv-B")).toEqual({
			kind: "scroll-to-bottom",
			reason: "first-visit",
		});

		// Stream completes while away.
		stopStream(store, "run-A");

		// Return to A.
		expect(decideForOpen(store, "conv-A")).toEqual({
			kind: "restore",
			scrollTop: 1500,
		});
		expect(restoreWindowSize("conv-A")).toBe(55);
	});

	test("type ScrollState exports support partial fields cleanly", () => {
		// This is a TypeScript compile-time check that the type is exported
		// and behaves as a struct with optional fields. The runtime assertion
		// just confirms the shape can hold either field independently.
		const a: ScrollState = { scrollTop: 100 };
		const b: ScrollState = { windowSize: 35 };
		const c: ScrollState = { scrollTop: 100, windowSize: 35 };
		const d: ScrollState = {};
		expect(a.scrollTop).toBe(100);
		expect(a.windowSize).toBeUndefined();
		expect(b.scrollTop).toBeUndefined();
		expect(b.windowSize).toBe(35);
		expect(c).toEqual({ scrollTop: 100, windowSize: 35 });
		expect(d).toEqual({});
	});
});
