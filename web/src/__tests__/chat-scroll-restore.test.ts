import { test, expect, describe, beforeEach } from "bun:test";
import {
	hasActiveStreamForConversation,
	decideOpenScroll,
	getCachedScrollState,
	updateCachedScrollState,
	_resetScrollCache,
} from "$lib/chat-scroll-restore.js";

beforeEach(() => {
	_resetScrollCache();
});

describe("hasActiveStreamForConversation", () => {
	test("empty map → false", () => {
		expect(hasActiveStreamForConversation("conv-A", {})).toBe(false);
	});

	test("map with this convId among values → true", () => {
		expect(
			hasActiveStreamForConversation("conv-A", {
				"run-1": "conv-X",
				"run-2": "conv-A",
			}),
		).toBe(true);
	});

	test("map with only other convIds → false", () => {
		expect(
			hasActiveStreamForConversation("conv-A", {
				"run-1": "conv-X",
				"run-2": "conv-Y",
			}),
		).toBe(false);
	});

	test("multiple runs on same conv → true", () => {
		expect(
			hasActiveStreamForConversation("conv-A", {
				"run-1": "conv-A",
				"run-2": "conv-A",
			}),
		).toBe(true);
	});
});

describe("decideOpenScroll", () => {
	test("active stream + cache present → scroll-to-bottom (active-stream wins)", () => {
		const result = decideOpenScroll({
			convId: "conv-A",
			streamingRunToConversation: { "run-1": "conv-A" },
			cachedScrollTop: 1234,
		});
		expect(result).toEqual({ kind: "scroll-to-bottom", reason: "active-stream" });
	});

	test("active stream + no cache → scroll-to-bottom (active-stream)", () => {
		const result = decideOpenScroll({
			convId: "conv-A",
			streamingRunToConversation: { "run-1": "conv-A" },
			cachedScrollTop: undefined,
		});
		expect(result).toEqual({ kind: "scroll-to-bottom", reason: "active-stream" });
	});

	test("no stream + no cache → scroll-to-bottom (first-visit)", () => {
		const result = decideOpenScroll({
			convId: "conv-A",
			streamingRunToConversation: {},
			cachedScrollTop: undefined,
		});
		expect(result).toEqual({ kind: "scroll-to-bottom", reason: "first-visit" });
	});

	test("no stream + cached scrollTop=0 → restore 0 (don't treat 0 as missing)", () => {
		const result = decideOpenScroll({
			convId: "conv-A",
			streamingRunToConversation: {},
			cachedScrollTop: 0,
		});
		expect(result).toEqual({ kind: "restore", scrollTop: 0 });
	});

	test("no stream + cached scrollTop=1234 → restore 1234", () => {
		const result = decideOpenScroll({
			convId: "conv-A",
			streamingRunToConversation: {},
			cachedScrollTop: 1234,
		});
		expect(result).toEqual({ kind: "restore", scrollTop: 1234 });
	});

	test("stream is for OTHER conv → not active for ours, restore", () => {
		const result = decideOpenScroll({
			convId: "conv-A",
			streamingRunToConversation: { "run-1": "conv-B" },
			cachedScrollTop: 500,
		});
		expect(result).toEqual({ kind: "restore", scrollTop: 500 });
	});
});

describe("scroll cache (struct: scrollTop + windowSize)", () => {
	test("get-after-update returns the scrollTop", () => {
		updateCachedScrollState("conv-A", { scrollTop: 250 });
		expect(getCachedScrollState("conv-A")).toEqual({ scrollTop: 250 });
	});

	test("get-other-conv returns undefined", () => {
		updateCachedScrollState("conv-A", { scrollTop: 250 });
		expect(getCachedScrollState("conv-B")).toBeUndefined();
	});

	test("partial updates merge — scrollTop and windowSize independent", () => {
		updateCachedScrollState("conv-A", { scrollTop: 250 });
		updateCachedScrollState("conv-A", { windowSize: 35 });
		expect(getCachedScrollState("conv-A")).toEqual({
			scrollTop: 250,
			windowSize: 35,
		});
	});

	test("re-update overwrites the same field", () => {
		updateCachedScrollState("conv-A", { scrollTop: 250 });
		updateCachedScrollState("conv-A", { scrollTop: 999 });
		expect(getCachedScrollState("conv-A")?.scrollTop).toBe(999);
	});

	test("zero is a valid stored scrollTop (not coerced to undefined)", () => {
		updateCachedScrollState("conv-A", { scrollTop: 0 });
		expect(getCachedScrollState("conv-A")?.scrollTop).toBe(0);
	});

	test("windowSize-only update does NOT populate scrollTop (preserves first-visit)", () => {
		// This is the critical invariant: caching a windowSize must not flip
		// decideOpenScroll from first-visit → restore. Otherwise the very
		// first scroll-to-bottom on a fresh conv would be skipped.
		updateCachedScrollState("conv-A", { windowSize: 15 });
		const state = getCachedScrollState("conv-A");
		expect(state).toEqual({ windowSize: 15 });
		expect(state?.scrollTop).toBeUndefined();

		const decision = decideOpenScroll({
			convId: "conv-A",
			streamingRunToConversation: {},
			cachedScrollTop: state?.scrollTop,
		});
		expect(decision).toEqual({ kind: "scroll-to-bottom", reason: "first-visit" });
	});

	test("_resetScrollCache clears all entries", () => {
		updateCachedScrollState("conv-A", { scrollTop: 100, windowSize: 35 });
		updateCachedScrollState("conv-B", { scrollTop: 200 });
		_resetScrollCache();
		expect(getCachedScrollState("conv-A")).toBeUndefined();
		expect(getCachedScrollState("conv-B")).toBeUndefined();
	});

	test("entries for different convs are independent", () => {
		updateCachedScrollState("conv-A", { scrollTop: 100, windowSize: 15 });
		updateCachedScrollState("conv-B", { scrollTop: 200, windowSize: 55 });
		expect(getCachedScrollState("conv-A")).toEqual({
			scrollTop: 100,
			windowSize: 15,
		});
		expect(getCachedScrollState("conv-B")).toEqual({
			scrollTop: 200,
			windowSize: 55,
		});
	});

	test("empty partial leaves existing fields intact (no clobbering)", () => {
		updateCachedScrollState("conv-A", { scrollTop: 100, windowSize: 35 });
		updateCachedScrollState("conv-A", {});
		expect(getCachedScrollState("conv-A")).toEqual({
			scrollTop: 100,
			windowSize: 35,
		});
	});

	test("update creates a new entry from scratch with both fields", () => {
		updateCachedScrollState("conv-A", { scrollTop: 100, windowSize: 35 });
		expect(getCachedScrollState("conv-A")).toEqual({
			scrollTop: 100,
			windowSize: 35,
		});
	});

	test("update on one conv does not mutate another conv's entry", () => {
		updateCachedScrollState("conv-A", { scrollTop: 100, windowSize: 15 });
		updateCachedScrollState("conv-B", { scrollTop: 999 });
		// A's entry must be untouched.
		expect(getCachedScrollState("conv-A")).toEqual({
			scrollTop: 100,
			windowSize: 15,
		});
	});

	test("rapid successive scroll-listener writes do not corrupt the windowSize", () => {
		// Mirrors the real lifecycle: convId-reset writes windowSize, then the
		// scroll listener fires many times in quick succession as the user
		// drags the scrollbar. windowSize must NOT be lost on any of those.
		updateCachedScrollState("conv-A", { windowSize: 75 });
		for (let top = 0; top <= 1000; top += 50) {
			updateCachedScrollState("conv-A", { scrollTop: top });
		}
		expect(getCachedScrollState("conv-A")).toEqual({
			scrollTop: 1000,
			windowSize: 75,
		});
	});

	test("scrollTop=undefined in partial does NOT erase an existing scrollTop", () => {
		// Spread merge semantics: { ...{a:1}, ...{} } === {a:1}, not {a:undefined}.
		// Callers should always omit the key, not pass `undefined`. Verifies
		// the contract holds either way for a defensive-coding cushion.
		updateCachedScrollState("conv-A", { scrollTop: 100, windowSize: 35 });
		updateCachedScrollState("conv-A", { windowSize: 75 });
		expect(getCachedScrollState("conv-A")).toEqual({
			scrollTop: 100,
			windowSize: 75,
		});
	});
});
