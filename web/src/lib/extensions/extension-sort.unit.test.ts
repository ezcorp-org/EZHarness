/**
 * Unit coverage for the pure extension-sort module. Exercises every sort
 * mode, both timestamp shapes (ISO string + `Date`), missing/invalid
 * timestamps, tie-breaks, immutability of the input, and the exported
 * option list. 100% line + branch coverage of `extension-sort.ts`.
 */
import { describe, test, expect } from "vitest";
import {
	DEFAULT_SORT_MODE,
	SORT_OPTIONS,
	sortExtensions,
	type ExtensionSortMode,
	type SortableExtension,
} from "./extension-sort";

const names = (list: readonly SortableExtension[]) => list.map((e) => e.name);

describe("extension-sort exports", () => {
	test("SORT_OPTIONS has exactly the four modes in dropdown order", () => {
		expect(SORT_OPTIONS).toHaveLength(4);
		expect(SORT_OPTIONS.map((o) => o.value)).toEqual([
			"name-asc",
			"name-desc",
			"recent",
			"oldest",
		]);
	});

	test("SORT_OPTIONS labels use the en-dash for A–Z / Z–A", () => {
		const byValue = Object.fromEntries(SORT_OPTIONS.map((o) => [o.value, o.label]));
		expect(byValue["name-asc"]).toBe("Name (A–Z)");
		expect(byValue["name-desc"]).toBe("Name (Z–A)");
		expect(byValue.recent).toBe("Recently updated");
		expect(byValue.oldest).toBe("Oldest first");
	});

	test("DEFAULT_SORT_MODE is name-asc and is one of the options", () => {
		expect(DEFAULT_SORT_MODE).toBe("name-asc");
		expect(SORT_OPTIONS.some((o) => o.value === DEFAULT_SORT_MODE)).toBe(true);
	});
});

describe("sortExtensions — name modes", () => {
	test("name-asc orders A→Z", () => {
		const list = [{ name: "Charlie" }, { name: "alpha" }, { name: "Bravo" }];
		expect(names(sortExtensions(list, "name-asc"))).toEqual(["alpha", "Bravo", "Charlie"]);
	});

	test("name-asc is the DEFAULT_SORT_MODE behaviour", () => {
		const list = [{ name: "zeta" }, { name: "alpha" }];
		expect(names(sortExtensions(list, DEFAULT_SORT_MODE))).toEqual(["alpha", "zeta"]);
	});

	test("name-asc is case-insensitive", () => {
		const list = [{ name: "banana" }, { name: "Apple" }, { name: "cherry" }];
		expect(names(sortExtensions(list, "name-asc"))).toEqual(["Apple", "banana", "cherry"]);
	});

	test("name-desc orders Z→A (reverse of name-asc)", () => {
		const list = [{ name: "Charlie" }, { name: "alpha" }, { name: "Bravo" }];
		expect(names(sortExtensions(list, "name-desc"))).toEqual(["Charlie", "Bravo", "alpha"]);
	});
});

describe("sortExtensions — recent (updatedAt DESC)", () => {
	test("orders by updatedAt newest-first", () => {
		const list = [
			{ name: "old", updatedAt: "2020-01-01T00:00:00.000Z" },
			{ name: "new", updatedAt: "2026-06-01T00:00:00.000Z" },
			{ name: "mid", updatedAt: "2023-01-01T00:00:00.000Z" },
		];
		expect(names(sortExtensions(list, "recent"))).toEqual(["new", "mid", "old"]);
	});

	test("ties on updatedAt break by name A–Z", () => {
		const same = "2024-05-05T00:00:00.000Z";
		const list = [
			{ name: "zeta", updatedAt: same },
			{ name: "alpha", updatedAt: same },
			{ name: "mike", updatedAt: same },
		];
		expect(names(sortExtensions(list, "recent"))).toEqual(["alpha", "mike", "zeta"]);
	});

	test("accepts Date objects (SSR shape) as well as ISO strings", () => {
		const list = [
			{ name: "string-old", updatedAt: "2021-01-01T00:00:00.000Z" },
			{ name: "date-new", updatedAt: new Date("2025-01-01T00:00:00.000Z") },
		];
		expect(names(sortExtensions(list, "recent"))).toEqual(["date-new", "string-old"]);
	});

	test("missing / invalid updatedAt sorts as epoch 0 (trails in recent)", () => {
		const list = [
			{ name: "missing" },
			{ name: "nullish", updatedAt: null },
			{ name: "invalid", updatedAt: "not-a-date" },
			{ name: "dated", updatedAt: "2022-01-01T00:00:00.000Z" },
		];
		// dated leads; the three epoch-0 rows tie and break by name A–Z.
		expect(names(sortExtensions(list, "recent"))).toEqual([
			"dated",
			"invalid",
			"missing",
			"nullish",
		]);
	});
});

describe("sortExtensions — oldest (createdAt ASC)", () => {
	test("orders by createdAt oldest-first", () => {
		const list = [
			{ name: "new", createdAt: "2026-06-01T00:00:00.000Z" },
			{ name: "old", createdAt: "2020-01-01T00:00:00.000Z" },
			{ name: "mid", createdAt: "2023-01-01T00:00:00.000Z" },
		];
		expect(names(sortExtensions(list, "oldest"))).toEqual(["old", "mid", "new"]);
	});

	test("ties on createdAt break by name A–Z", () => {
		const same = "2024-05-05T00:00:00.000Z";
		const list = [
			{ name: "zeta", createdAt: same },
			{ name: "alpha", createdAt: same },
		];
		expect(names(sortExtensions(list, "oldest"))).toEqual(["alpha", "zeta"]);
	});

	test("missing createdAt sorts as epoch 0 (leads in oldest)", () => {
		const list = [
			{ name: "dated", createdAt: "2022-01-01T00:00:00.000Z" },
			{ name: "undated" },
		];
		expect(names(sortExtensions(list, "oldest"))).toEqual(["undated", "dated"]);
	});
});

describe("sortExtensions — immutability & edge cases", () => {
	test("returns a NEW array and does not mutate the input", () => {
		const input = [{ name: "b" }, { name: "a" }] as const;
		const before = [...input];
		const out = sortExtensions(input, "name-asc");
		expect(out).not.toBe(input);
		expect(input).toEqual(before); // input order unchanged
		expect(names(out)).toEqual(["a", "b"]);
	});

	test("empty list returns a new empty array", () => {
		const input: SortableExtension[] = [];
		const out = sortExtensions(input, "name-asc");
		expect(out).toEqual([]);
		expect(out).not.toBe(input);
	});

	test("preserves the full record (generic passthrough)", () => {
		type Rec = SortableExtension & { id: string };
		const list: Rec[] = [
			{ id: "2", name: "b" },
			{ id: "1", name: "a" },
		];
		const out = sortExtensions(list, "name-asc");
		expect(out.map((e) => e.id)).toEqual(["1", "2"]);
	});

	test("default branch falls back to name-asc for an unknown mode", () => {
		// The type forbids this, but a forged value at runtime must still
		// hit the exhaustive switch's default (name-asc) — no crash, no
		// unreachable line.
		const list = [{ name: "b" }, { name: "a" }];
		const out = sortExtensions(list, "totally-bogus" as ExtensionSortMode);
		expect(names(out)).toEqual(["a", "b"]);
	});
});
