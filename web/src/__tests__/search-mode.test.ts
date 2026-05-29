/**
 * Unit tests for the search-mode persistence + hit-grouping helpers
 * (Phase 66 plan 01, Task 2).
 *
 * - SearchMode is the GLOBAL chat-search preference (UI-01/UI-02 + CONTEXT
 *   lock): one localStorage key, NO projectId. Defaults to "hybrid",
 *   validates stored values, survives garbage.
 * - groupHitsByConversation is the $derived-friendly pure grouping
 *   (66-RESEARCH.md lines 278-288), preserving first-seen order.
 *
 * Pure logic → runs under `bun test`. localStorage is stubbed in-memory
 * since bun's test env has no DOM Storage.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { MessageSearchHit } from "$lib/api.js";
import {
	SEARCH_MODE_LS_KEY,
	DEFAULT_SEARCH_MODE,
	loadSearchMode,
	persistSearchMode,
	groupHitsByConversation,
} from "$lib/search/search-mode.js";

/** Minimal in-memory localStorage stub. */
function makeStorageStub(initial: Record<string, string> = {}) {
	const map = new Map<string, string>(Object.entries(initial));
	return {
		getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
		setItem: (k: string, v: string) => void map.set(k, String(v)),
		removeItem: (k: string) => void map.delete(k),
		clear: () => map.clear(),
		key: (i: number) => [...map.keys()][i] ?? null,
		get length() {
			return map.size;
		},
		_map: map,
	};
}

const originalLS = (globalThis as { localStorage?: Storage }).localStorage;

function setLS(stub: ReturnType<typeof makeStorageStub> | undefined) {
	(globalThis as { localStorage?: unknown }).localStorage = stub as unknown as Storage;
}

afterEach(() => {
	(globalThis as { localStorage?: unknown }).localStorage = originalLS;
});

function hit(overrides: Partial<MessageSearchHit> = {}): MessageSearchHit {
	return {
		conversationId: "c1",
		conversationTitle: "Conv One",
		messageId: "m1",
		role: "user",
		createdAt: "2026-01-01T00:00:00.000Z",
		snippet: "snip",
		matchType: "lexical",
		rankLexical: 1,
		rankSemantic: null,
		score: 0.5,
		...overrides,
	};
}

describe("loadSearchMode", () => {
	test("Test 1: returns DEFAULT_SEARCH_MODE (hybrid) when LS is empty", () => {
		setLS(makeStorageStub());
		expect(loadSearchMode()).toBe(DEFAULT_SEARCH_MODE);
		expect(DEFAULT_SEARCH_MODE).toBe("hybrid");
	});

	test("Test 1b: returns DEFAULT when localStorage is undefined (SSR)", () => {
		setLS(undefined);
		expect(loadSearchMode()).toBe("hybrid");
	});

	test("Test 2: returns the stored value when it is a valid SearchMode", () => {
		setLS(makeStorageStub({ [SEARCH_MODE_LS_KEY]: "semantic" }));
		expect(loadSearchMode()).toBe("semantic");
		setLS(makeStorageStub({ [SEARCH_MODE_LS_KEY]: "keyword" }));
		expect(loadSearchMode()).toBe("keyword");
	});

	test("Test 3: falls back to hybrid on garbage / unknown stored value", () => {
		setLS(makeStorageStub({ [SEARCH_MODE_LS_KEY]: "wat" }));
		expect(loadSearchMode()).toBe("hybrid");
		setLS(makeStorageStub({ [SEARCH_MODE_LS_KEY]: "{}" }));
		expect(loadSearchMode()).toBe("hybrid");
	});
});

describe("persistSearchMode", () => {
	test("Test 4: writes to the GLOBAL key (no projectId in the key string)", () => {
		const stub = makeStorageStub();
		setLS(stub);
		persistSearchMode("semantic");
		expect(stub._map.get(SEARCH_MODE_LS_KEY)).toBe("semantic");
		expect(SEARCH_MODE_LS_KEY).not.toContain("proj");
		expect(SEARCH_MODE_LS_KEY.toLowerCase()).not.toContain("project");
	});

	test("round-trip: persist then load returns the same mode", () => {
		const stub = makeStorageStub();
		setLS(stub);
		persistSearchMode("keyword");
		expect(loadSearchMode()).toBe("keyword");
	});

	test("undefined localStorage is a silent no-op (no throw)", () => {
		setLS(undefined);
		expect(() => persistSearchMode("semantic")).not.toThrow();
	});
});

describe("groupHitsByConversation", () => {
	test("Test 5: groups by conversationId, preserves first-seen order + per-group title", () => {
		const hits: MessageSearchHit[] = [
			hit({ conversationId: "c1", conversationTitle: "First", messageId: "m1" }),
			hit({ conversationId: "c2", conversationTitle: "Second", messageId: "m2" }),
			hit({ conversationId: "c1", conversationTitle: "First", messageId: "m3" }),
		];
		const groups = groupHitsByConversation(hits);
		expect(groups).toHaveLength(2);
		// first-seen order: c1 before c2
		expect(groups[0]!.conversationId).toBe("c1");
		expect(groups[0]!.title).toBe("First");
		expect(groups[0]!.hits.map((h) => h.messageId)).toEqual(["m1", "m3"]);
		expect(groups[1]!.conversationId).toBe("c2");
		expect(groups[1]!.title).toBe("Second");
		expect(groups[1]!.hits.map((h) => h.messageId)).toEqual(["m2"]);
	});

	test("empty input → empty array", () => {
		expect(groupHitsByConversation([])).toEqual([]);
	});
});
