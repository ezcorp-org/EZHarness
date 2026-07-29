/**
 * Unit tests for the review panel's "Viewed" persistence.
 *
 * The suite installs a fake `localStorage` (bun has no DOM) so it can also
 * exercise the two failure modes the helpers must swallow: storage that isn't
 * there at all (SSR) and storage that throws (private mode / quota).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	VIEWED_FILES_KEY_PREFIX,
	loadViewedFiles,
	persistViewedFiles,
	viewedCount,
	viewedFilesKey,
} from "./viewed-files";

type Store = { getItem: unknown; setItem: unknown; removeItem: unknown };

const globals = globalThis as { localStorage?: Store };

function installStorage(): Map<string, string> {
	const map = new Map<string, string>();
	globals.localStorage = {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
	};
	return map;
}

function installThrowingStorage(): void {
	const boom = () => {
		throw new Error("quota");
	};
	globals.localStorage = { getItem: boom, setItem: boom, removeItem: boom };
}

afterEach(() => {
	delete globals.localStorage;
});

describe("viewedFilesKey", () => {
	test("namespaces the key by conversation", () => {
		expect(viewedFilesKey("conv-1")).toBe(`${VIEWED_FILES_KEY_PREFIX}conv-1`);
	});
});

describe("loadViewedFiles", () => {
	test("round-trips a persisted set", () => {
		installStorage();
		persistViewedFiles("c1", new Set(["tool:a.ts", "code:0"]));
		expect(loadViewedFiles("c1")).toEqual(new Set(["tool:a.ts", "code:0"]));
	});

	test("keeps conversations separate", () => {
		installStorage();
		persistViewedFiles("c1", new Set(["tool:a.ts"]));
		expect(loadViewedFiles("c2")).toEqual(new Set());
	});

	test("an unset conversation reads as empty", () => {
		installStorage();
		expect(loadViewedFiles("never-seen")).toEqual(new Set());
	});

	test("a blank conversation id reads as empty", () => {
		installStorage();
		expect(loadViewedFiles("")).toEqual(new Set());
	});

	test("reads as empty when there is no storage at all (SSR)", () => {
		expect(loadViewedFiles("c1")).toEqual(new Set());
	});

	test("malformed JSON reads as empty rather than throwing", () => {
		const map = installStorage();
		map.set(viewedFilesKey("c1"), "{not json");
		expect(loadViewedFiles("c1")).toEqual(new Set());
	});

	test("a non-array payload reads as empty", () => {
		const map = installStorage();
		map.set(viewedFilesKey("c1"), '{"a":1}');
		expect(loadViewedFiles("c1")).toEqual(new Set());
	});

	test("non-string members are dropped", () => {
		const map = installStorage();
		map.set(viewedFilesKey("c1"), '["ok", 3, null]');
		expect(loadViewedFiles("c1")).toEqual(new Set(["ok"]));
	});

	test("a throwing storage reads as empty", () => {
		installThrowingStorage();
		expect(loadViewedFiles("c1")).toEqual(new Set());
	});
});

describe("persistViewedFiles", () => {
	test("removes the entry when the set empties out", () => {
		const map = installStorage();
		persistViewedFiles("c1", new Set(["tool:a.ts"]));
		expect(map.has(viewedFilesKey("c1"))).toBe(true);
		persistViewedFiles("c1", new Set());
		expect(map.has(viewedFilesKey("c1"))).toBe(false);
	});

	test("a blank conversation id writes nothing", () => {
		const map = installStorage();
		persistViewedFiles("", new Set(["tool:a.ts"]));
		expect(map.size).toBe(0);
	});

	test("is a no-op without storage (SSR)", () => {
		expect(() => persistViewedFiles("c1", new Set(["a"]))).not.toThrow();
	});

	test("swallows a throwing storage", () => {
		installThrowingStorage();
		expect(() => persistViewedFiles("c1", new Set(["a"]))).not.toThrow();
	});
});

describe("viewedCount", () => {
	test("counts only the keys currently on screen", () => {
		expect(viewedCount(new Set(["a", "b"]), ["a", "c"])).toBe(1);
	});

	test("stale keys can never push the count past the file count", () => {
		expect(viewedCount(new Set(["gone-1", "gone-2"]), ["a"])).toBe(0);
	});

	test("no files means nothing viewed", () => {
		expect(viewedCount(new Set(["a"]), [])).toBe(0);
	});
});
