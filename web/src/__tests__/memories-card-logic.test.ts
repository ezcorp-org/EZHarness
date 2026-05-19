import { test, expect, describe } from "bun:test";

// Pure logic extracted from MemoriesCard.svelte. We mirror the $derived expressions
// and the render-gating predicate so they can be unit-tested without mounting the
// component. Each function below is a 1:1 copy of the source expression — if the
// component changes, this file must too.

type Memory = { id: string; content: string; category: string };

// ── previewText ────────────────────────────────────────────────────
// Shows the first memory's content, trimmed, newlines collapsed, truncated at 80.
function previewText(memories: Memory[]): string {
	const first = memories[0]?.content ?? "";
	const flat = first.slice(0, 80).replace(/\n/g, " ").trim();
	return first.length > 80 ? flat + "..." : flat;
}

// ── countLabel ─────────────────────────────────────────────────────
function countLabel(memories: Memory[]): string {
	return `${memories.length} ${memories.length === 1 ? "memory" : "memories"}`;
}

// ── hasMemories (from ChatMessage.svelte) ──────────────────────────
// Gates whether MemoriesCard is rendered at all.
function hasMemories(memoriesUsed: Memory[] | undefined): boolean {
	return !!(memoriesUsed && memoriesUsed.length > 0);
}

// ── focusHref ──────────────────────────────────────────────────────
function focusHref(id: string): string {
	return `/memories?focus=${id}`;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("MemoriesCard previewText", () => {
	test("returns empty string for empty list", () => {
		expect(previewText([])).toBe("");
	});

	test("returns full content when under 80 chars", () => {
		const mem = { id: "m1", content: "Short memory", category: "preferences" };
		expect(previewText([mem])).toBe("Short memory");
	});

	test("trims whitespace from the preview", () => {
		const mem = { id: "m1", content: "   padded   ", category: "preferences" };
		expect(previewText([mem])).toBe("padded");
	});

	test("replaces newlines with spaces", () => {
		const mem = { id: "m1", content: "line1\nline2\nline3", category: "technical" };
		expect(previewText([mem])).toBe("line1 line2 line3");
	});

	test("truncates and appends ellipsis when over 80 chars", () => {
		const long = "a".repeat(100);
		const mem = { id: "m1", content: long, category: "biographical" };
		const result = previewText([mem]);
		expect(result).toBe("a".repeat(80) + "...");
		expect(result.length).toBe(83);
	});

	test("uses ONLY the first memory, not subsequent ones", () => {
		const mems = [
			{ id: "m1", content: "first", category: "preferences" },
			{ id: "m2", content: "second", category: "technical" },
		];
		expect(previewText(mems)).toBe("first");
	});

	test("80-character content is not truncated (boundary)", () => {
		const exactly80 = "x".repeat(80);
		const mem = { id: "m1", content: exactly80, category: "preferences" };
		expect(previewText([mem])).toBe(exactly80);
	});

	test("81-character content is truncated (boundary + 1)", () => {
		const eighty1 = "y".repeat(81);
		const mem = { id: "m1", content: eighty1, category: "preferences" };
		expect(previewText([mem])).toBe("y".repeat(80) + "...");
	});
});

describe("MemoriesCard countLabel", () => {
	test("singular for exactly one memory", () => {
		expect(countLabel([{ id: "m1", content: "a", category: "preferences" }])).toBe(
			"1 memory",
		);
	});

	test("plural for zero memories", () => {
		// Edge: if the card is somehow rendered with an empty list, label still reads "memories".
		expect(countLabel([])).toBe("0 memories");
	});

	test("plural for multiple memories", () => {
		const mems = [
			{ id: "m1", content: "a", category: "preferences" },
			{ id: "m2", content: "b", category: "technical" },
			{ id: "m3", content: "c", category: "biographical" },
		];
		expect(countLabel(mems)).toBe("3 memories");
	});
});

describe("ChatMessage hasMemories gate", () => {
	test("false for undefined", () => {
		expect(hasMemories(undefined)).toBe(false);
	});

	test("false for empty array (this is how we hide the card when empty)", () => {
		expect(hasMemories([])).toBe(false);
	});

	test("true for non-empty array", () => {
		expect(hasMemories([{ id: "m1", content: "x", category: "preferences" }])).toBe(true);
	});

	test("true for multiple memories", () => {
		expect(
			hasMemories([
				{ id: "m1", content: "a", category: "preferences" },
				{ id: "m2", content: "b", category: "technical" },
			]),
		).toBe(true);
	});
});

describe("MemoriesCard focusHref (link target for deep-link into memories page)", () => {
	test("builds focus URL with memory id as query param", () => {
		expect(focusHref("mem-abc-123")).toBe("/memories?focus=mem-abc-123");
	});

	test("handles uuid-shaped ids", () => {
		expect(focusHref("9d20d875-6ad6-4c6f-8de8-6cde44cbccfb")).toBe(
			"/memories?focus=9d20d875-6ad6-4c6f-8de8-6cde44cbccfb",
		);
	});
});
