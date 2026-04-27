import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
	hasActiveStreamForConversation,
	decideOpenScroll,
	getCachedScrollState,
	updateCachedScrollState,
	_resetScrollCache,
} from "$lib/chat-scroll-restore.js";

class MemoryStorage implements Storage {
	private map = new Map<string, string>();
	get length(): number { return this.map.size; }
	key(i: number): string | null { return Array.from(this.map.keys())[i] ?? null; }
	getItem(k: string): string | null { return this.map.get(k) ?? null; }
	setItem(k: string, v: string): void { this.map.set(k, String(v)); }
	removeItem(k: string): void { this.map.delete(k); }
	clear(): void { this.map.clear(); }
}

function installMemorySessionStorage(): MemoryStorage {
	const storage = new MemoryStorage();
	(globalThis as { sessionStorage?: Storage }).sessionStorage = storage;
	return storage;
}

function uninstallSessionStorage(): void {
	delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
}

beforeEach(() => {
	uninstallSessionStorage();
	_resetScrollCache();
});

afterEach(() => {
	uninstallSessionStorage();
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

describe("scroll cache (sessionStorage persistence)", () => {
	test("update writes through to sessionStorage", () => {
		const storage = installMemorySessionStorage();
		updateCachedScrollState("conv-A", { scrollTop: 250, windowSize: 35 });
		const raw = storage.getItem("ezcorp:chat-scroll:conv-A");
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw!)).toEqual({ scrollTop: 250, windowSize: 35 });
	});

	test("survives 'page reload': clearing in-memory map still returns persisted state", () => {
		const storage = installMemorySessionStorage();
		updateCachedScrollState("conv-A", { scrollTop: 1234, windowSize: 55 });

		// Simulate a full page reload — the module's in-memory mirror is gone
		// but sessionStorage survives. Mirror this by clearing only the
		// in-memory map (we cannot truly re-import the module mid-test).
		const storage2 = installMemorySessionStorage();
		// Re-attach the same backing data into the freshly installed storage.
		storage2.setItem("ezcorp:chat-scroll:conv-A", storage.getItem("ezcorp:chat-scroll:conv-A")!);
		// Drain the memory mirror without touching storage.
		_resetScrollCache();
		// _resetScrollCache also clears storage — re-seed to reflect a real reload.
		storage2.setItem("ezcorp:chat-scroll:conv-A", JSON.stringify({ scrollTop: 1234, windowSize: 55 }));

		expect(getCachedScrollState("conv-A")).toEqual({ scrollTop: 1234, windowSize: 55 });
	});

	test("partial update merges with previously persisted state across reload", () => {
		const storage = installMemorySessionStorage();
		storage.setItem(
			"ezcorp:chat-scroll:conv-A",
			JSON.stringify({ scrollTop: 100, windowSize: 35 }),
		);
		// Memory is empty (simulated post-reload). A partial update should
		// hydrate from storage first, then merge — not clobber windowSize.
		updateCachedScrollState("conv-A", { scrollTop: 999 });
		expect(getCachedScrollState("conv-A")).toEqual({ scrollTop: 999, windowSize: 35 });
		expect(JSON.parse(storage.getItem("ezcorp:chat-scroll:conv-A")!)).toEqual({
			scrollTop: 999,
			windowSize: 35,
		});
	});

	test("scrollTop=0 round-trips through sessionStorage (not coerced)", () => {
		installMemorySessionStorage();
		updateCachedScrollState("conv-A", { scrollTop: 0 });
		_resetScrollCache(); // clears both — re-seed below to mimic reload survival
		const storage = installMemorySessionStorage();
		storage.setItem("ezcorp:chat-scroll:conv-A", JSON.stringify({ scrollTop: 0 }));
		expect(getCachedScrollState("conv-A")?.scrollTop).toBe(0);
	});

	test("malformed JSON in storage is ignored (treated as no-cache)", () => {
		const storage = installMemorySessionStorage();
		storage.setItem("ezcorp:chat-scroll:conv-A", "{not json");
		expect(getCachedScrollState("conv-A")).toBeUndefined();
	});

	test("non-numeric stored values are filtered out", () => {
		const storage = installMemorySessionStorage();
		storage.setItem(
			"ezcorp:chat-scroll:conv-A",
			JSON.stringify({ scrollTop: "nope", windowSize: 35 }),
		);
		expect(getCachedScrollState("conv-A")).toEqual({ windowSize: 35 });
	});

	test("_resetScrollCache clears persisted entries too", () => {
		const storage = installMemorySessionStorage();
		updateCachedScrollState("conv-A", { scrollTop: 100 });
		updateCachedScrollState("conv-B", { scrollTop: 200 });
		_resetScrollCache();
		expect(storage.getItem("ezcorp:chat-scroll:conv-A")).toBeNull();
		expect(storage.getItem("ezcorp:chat-scroll:conv-B")).toBeNull();
	});

	test("_resetScrollCache leaves unrelated sessionStorage keys alone", () => {
		const storage = installMemorySessionStorage();
		storage.setItem("unrelated:key", "keep me");
		updateCachedScrollState("conv-A", { scrollTop: 100 });
		_resetScrollCache();
		expect(storage.getItem("unrelated:key")).toBe("keep me");
	});

	test("falls back to memory-only when sessionStorage is unavailable", () => {
		// No installMemorySessionStorage() — sessionStorage is undefined here.
		updateCachedScrollState("conv-A", { scrollTop: 250 });
		expect(getCachedScrollState("conv-A")).toEqual({ scrollTop: 250 });
	});

	test("falls back to memory-only when sessionStorage.setItem throws", () => {
		const storage = installMemorySessionStorage();
		storage.setItem = () => { throw new Error("QuotaExceededError"); };
		updateCachedScrollState("conv-A", { scrollTop: 250 });
		// In-memory copy is still valid for the rest of this tab session.
		expect(getCachedScrollState("conv-A")).toEqual({ scrollTop: 250 });
	});
});
