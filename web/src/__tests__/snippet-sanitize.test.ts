/**
 * Unit tests for the `<mark>`-only snippet sanitizer (Phase 66 plan 01,
 * Task 2). Search snippets are rendered via `{@html}`, so they MUST pass
 * through a DOMPurify allowlist that keeps only `<mark>` (no attributes)
 * before render — the XSS class called out in 66-RESEARCH.md (Pitfall 5).
 *
 * Pure logic, no Svelte/DOM-runtime dependency → runs under `bun test`.
 */
import { test, expect, describe } from "bun:test";
import { sanitizeSnippet } from "$lib/search/snippet-sanitize.js";

describe("sanitizeSnippet", () => {
	test("Test 1: <mark>foo</mark> survives unchanged", () => {
		expect(sanitizeSnippet("a <mark>foo</mark> b")).toBe("a <mark>foo</mark> b");
	});

	test("Test 2: <script> is stripped, surrounding safe text kept", () => {
		const out = sanitizeSnippet("hi <script>alert(1)</script> there");
		expect(out).not.toContain("<script");
		expect(out).not.toContain("alert(1)");
		expect(out).toContain("hi");
		expect(out).toContain("there");
	});

	test("Test 2b: <img onerror=...> dangerous tag/attr removed", () => {
		const out = sanitizeSnippet('safe <img src=x onerror="alert(1)"> tail');
		expect(out).not.toContain("<img");
		expect(out).not.toContain("onerror");
		expect(out).toContain("safe");
		expect(out).toContain("tail");
	});

	test("Test 3: <mark onclick=x> keeps the tag but drops the attribute", () => {
		const out = sanitizeSnippet('<mark onclick="x">hi</mark>');
		expect(out).toContain("<mark>");
		expect(out).not.toContain("onclick");
		expect(out).toContain("hi");
	});

	test("Test 4: plain semantic text (no tags) passes through unchanged", () => {
		expect(sanitizeSnippet("just some plain semantic text")).toBe(
			"just some plain semantic text",
		);
	});
});
