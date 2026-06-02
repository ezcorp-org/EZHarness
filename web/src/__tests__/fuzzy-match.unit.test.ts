import { test, expect, describe } from "vitest";
import { fuzzyScore, fuzzyMatches, bestFuzzyScore } from "../lib/fuzzy-match";

describe("fuzzyScore — basics", () => {
	test("empty query returns 0 (neutral match)", () => {
		expect(fuzzyScore("", "anything")).toBe(0);
		expect(fuzzyScore("", "")).toBe(0);
	});

	test("exact match returns a very high score", () => {
		expect(fuzzyScore("foo.ts", "foo.ts")).toBe(10_000);
	});

	test("exact match is case-insensitive", () => {
		expect(fuzzyScore("FOO.TS", "foo.ts")).toBe(10_000);
		expect(fuzzyScore("foo.ts", "FOO.TS")).toBe(10_000);
	});

	test("prefix match returns a high score below exact", () => {
		const prefix = fuzzyScore("foo", "foo.ts");
		const exact = fuzzyScore("foo.ts", "foo.ts");
		expect(prefix).not.toBeNull();
		expect(prefix!).toBeLessThan(exact!);
		expect(prefix!).toBeGreaterThan(1000);
	});

	test("shorter prefix match (less trailing excess) ranks above longer", () => {
		const closer = fuzzyScore("foo", "foo.ts");
		const farther = fuzzyScore("foo", "foobarbaz.ts");
		expect(closer).not.toBeNull();
		expect(farther).not.toBeNull();
		expect(closer!).toBeGreaterThan(farther!);
	});
});

describe("fuzzyScore — subsequence matching", () => {
	test("non-subsequence returns null", () => {
		expect(fuzzyScore("xyz", "foo.ts")).toBeNull();
		expect(fuzzyScore("app", "README.md")).toBeNull(); // no 'p' in README.md
		expect(fuzzyScore("zed", "README.md")).toBeNull(); // no 'z' at all
	});

	test("'apts' IS a subsequence of 'app.ts' (pathological case sanity check)", () => {
		// Demonstrates the purely-positional nature of subsequence matching:
		// a(0) p(1) [skip p, .] t(4) s(5) — the query chars appear in order.
		expect(fuzzyScore("apts", "app.ts")).not.toBeNull();
	});

	test("plain subsequence match returns a positive score", () => {
		expect(fuzzyScore("app", "src/app.ts")).not.toBeNull();
		expect(fuzzyScore("sapp", "src/app.ts")).not.toBeNull();
	});

	test("subsequence with gaps still matches but scores lower than contiguous", () => {
		const contiguous = fuzzyScore("app", "src/app.ts");
		const gappy = fuzzyScore("apt", "src/app.ts"); // a-p-t with t much later
		expect(contiguous).not.toBeNull();
		expect(gappy).not.toBeNull();
		expect(contiguous!).toBeGreaterThan(gappy!);
	});

	test("case-insensitive subsequence matching", () => {
		expect(fuzzyScore("APP", "src/app.ts")).not.toBeNull();
		expect(fuzzyScore("app", "SRC/APP.TS")).not.toBeNull();
	});

	test("query longer than target → null", () => {
		expect(fuzzyScore("abcdefghij", "abc")).toBeNull();
	});
});

describe("fuzzyScore — boundary bonuses", () => {
	test("match after `/` boundary outranks match mid-word", () => {
		// 'app' after `/` in 'src/app.ts' vs mid-word in 'wrapper.ts'
		const afterSlash = fuzzyScore("app", "src/app.ts");
		const midWord = fuzzyScore("app", "wrapper.ts");
		expect(afterSlash).not.toBeNull();
		expect(midWord).not.toBeNull();
		expect(afterSlash!).toBeGreaterThan(midWord!);
	});

	test("match after `.` boundary outranks match mid-word", () => {
		const afterDot = fuzzyScore("ts", "file.ts");
		const midWord = fuzzyScore("ts", "foots.md");
		expect(afterDot).not.toBeNull();
		expect(midWord).not.toBeNull();
		expect(afterDot!).toBeGreaterThan(midWord!);
	});

	test("match after `-` boundary outranks match mid-word", () => {
		const afterDash = fuzzyScore("v2", "my-v2.json");
		const midWord = fuzzyScore("v2", "myv2abc.json");
		expect(afterDash).not.toBeNull();
		expect(midWord).not.toBeNull();
		expect(afterDash!).toBeGreaterThan(midWord!);
	});

	test("match at position 0 earns the boundary bonus", () => {
		// 'foo' as prefix of 'foo-bar.ts' scores higher than 'foo' mid-word
		const atStart = fuzzyScore("foo", "foo-bar.ts");
		const midWord = fuzzyScore("foo", "xxfooyy.ts");
		expect(atStart).not.toBeNull();
		expect(midWord).not.toBeNull();
		expect(atStart!).toBeGreaterThan(midWord!);
	});
});

describe("fuzzyScore — ordering across candidates", () => {
	test("'app' ranks prefix > boundary subseq > interior subseq > no match", () => {
		const candidates = [
			"app.ts",         // exact-ish prefix
			"src/app.ts",     // post-boundary subseq
			"wrapper.ts",     // interior subseq (w-r-APP-er)
			"xyz.md",         // no match
		];
		const scored = candidates
			.map((c) => ({ c, s: fuzzyScore("app", c) }))
			.filter((x) => x.s !== null) as Array<{ c: string; s: number }>;
		scored.sort((a, b) => b.s - a.s);

		expect(scored.map((x) => x.c)).toEqual([
			"app.ts",
			"src/app.ts",
			"wrapper.ts",
		]);
	});

	test("empty query matches everything with equal 0 score", () => {
		const candidates = ["a.ts", "b/c.ts", "README.md"];
		const scored = candidates
			.map((c) => fuzzyScore("", c))
			.filter((s) => s !== null);
		expect(scored).toEqual([0, 0, 0]);
	});

	test("shorter target wins as a tiebreaker when scores are otherwise equal", () => {
		// Two prefix matches of same length diff → the shorter target ranks higher
		const short = fuzzyScore("foo", "foo.ts");
		const long = fuzzyScore("foo", "foo.ts.longerrrrrr");
		expect(short!).toBeGreaterThan(long!);
	});

	test("earlier first-match position ranks above later first-match", () => {
		// Both contain 'abc' as a subsequence at a word boundary; earlier wins.
		const early = fuzzyScore("abc", "abc-very-long.ts");
		const late = fuzzyScore("abc", "zzzzzzz/abc.ts");
		expect(early).not.toBeNull();
		expect(late).not.toBeNull();
		expect(early!).toBeGreaterThan(late!);
	});
});

describe("fuzzyMatches convenience", () => {
	test("returns true for matches", () => {
		expect(fuzzyMatches("app", "src/app.ts")).toBe(true);
		expect(fuzzyMatches("", "anything")).toBe(true);
	});

	test("returns false for non-matches", () => {
		expect(fuzzyMatches("xyz", "foo.ts")).toBe(false);
	});
});

describe("bestFuzzyScore", () => {
	test("returns null when every input is null", () => {
		expect(bestFuzzyScore([null, null, null])).toBeNull();
		expect(bestFuzzyScore([])).toBeNull();
	});

	test("ignores nulls, returns the max of the rest", () => {
		expect(bestFuzzyScore([null, 5, null, 10, 7])).toBe(10);
		expect(bestFuzzyScore([null, -3, null])).toBe(-3);
	});

	test("returns the single non-null value when only one is present", () => {
		expect(bestFuzzyScore([null, 42, null])).toBe(42);
	});

	test("handles all-non-null inputs", () => {
		expect(bestFuzzyScore([1, 2, 3])).toBe(3);
		expect(bestFuzzyScore([100, 50, 75])).toBe(100);
	});

	test("preserves zero scores (empty-query neutral match)", () => {
		expect(bestFuzzyScore([0, null])).toBe(0);
		expect(bestFuzzyScore([null, 0, null])).toBe(0);
	});
});
