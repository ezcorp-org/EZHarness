import { test, expect, describe, afterEach } from "bun:test";
import {
	DIFF_VIEW_MODE_KEY,
	DEFAULT_DIFF_VIEW_MODE,
	isUnified,
	loadDiffViewMode,
	persistDiffViewMode,
} from "../diff-view-mode";

let storage: Map<string, string>;

function setupStorage(opts: { throwOnGet?: boolean; throwOnSet?: boolean } = {}) {
	storage = new Map();
	(globalThis as any).localStorage = {
		getItem: (key: string) => {
			if (opts.throwOnGet) throw new Error("private mode");
			return storage.get(key) ?? null;
		},
		setItem: (key: string, value: string) => {
			if (opts.throwOnSet) throw new Error("quota exceeded");
			storage.set(key, value);
		},
		removeItem: (key: string) => storage.delete(key),
	};
}

function teardownStorage() {
	delete (globalThis as any).localStorage;
}

describe("diff-view-mode", () => {
	afterEach(() => teardownStorage());

	describe("isUnified", () => {
		test("true for line-by-line", () => {
			expect(isUnified("line-by-line")).toBe(true);
		});
		test("false for side-by-side", () => {
			expect(isUnified("side-by-side")).toBe(false);
		});
	});

	describe("loadDiffViewMode", () => {
		test("returns the default when nothing is stored", () => {
			setupStorage();
			expect(loadDiffViewMode()).toBe(DEFAULT_DIFF_VIEW_MODE);
			expect(DEFAULT_DIFF_VIEW_MODE).toBe("side-by-side");
		});

		test("returns the stored valid mode", () => {
			setupStorage();
			storage.set(DIFF_VIEW_MODE_KEY, "line-by-line");
			expect(loadDiffViewMode()).toBe("line-by-line");
		});

		test("falls back to the default for an unknown stored value", () => {
			setupStorage();
			storage.set(DIFF_VIEW_MODE_KEY, "garbage");
			expect(loadDiffViewMode()).toBe(DEFAULT_DIFF_VIEW_MODE);
		});

		test("falls back to the default when getItem throws", () => {
			setupStorage({ throwOnGet: true });
			expect(loadDiffViewMode()).toBe(DEFAULT_DIFF_VIEW_MODE);
		});

		test("returns the default under SSR (no localStorage)", () => {
			teardownStorage();
			expect(loadDiffViewMode()).toBe(DEFAULT_DIFF_VIEW_MODE);
		});
	});

	describe("persistDiffViewMode", () => {
		test("writes the mode to the global key", () => {
			setupStorage();
			persistDiffViewMode("line-by-line");
			expect(storage.get(DIFF_VIEW_MODE_KEY)).toBe("line-by-line");
		});

		test("round-trips through load", () => {
			setupStorage();
			persistDiffViewMode("line-by-line");
			expect(loadDiffViewMode()).toBe("line-by-line");
			persistDiffViewMode("side-by-side");
			expect(loadDiffViewMode()).toBe("side-by-side");
		});

		test("is a silent no-op when setItem throws", () => {
			setupStorage({ throwOnSet: true });
			expect(() => persistDiffViewMode("line-by-line")).not.toThrow();
		});

		test("is a silent no-op under SSR (no localStorage)", () => {
			teardownStorage();
			expect(() => persistDiffViewMode("line-by-line")).not.toThrow();
		});
	});
});
