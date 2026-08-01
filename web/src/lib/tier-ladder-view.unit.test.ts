/**
 * Pure view/edit helpers behind the Settings → Models tier-ladder editor.
 *
 * The ladder's own semantics are the backend's (`src/__tests__/tier-ladder.test.ts`);
 * what's asserted here is the UI's half: how "the default you are overriding"
 * is derived from `/api/models`, and that every list edit is a copy-on-write
 * that reports a no-op instead of firing a pointless save.
 */
import { describe, test, expect } from "vitest";
import {
	addRung,
	formatEntry,
	heuristicTierDefaults,
	moveRung,
	removeRung,
	selectableModels,
	withTier,
	type TierLadderModelOption,
} from "./tier-ladder-view";
import { emptyTierLadder } from "$server/runtime/routing/tier-ladder";

const MODELS: TierLadderModelOption[] = [
	{ provider: "anthropic", model: "claude-sonnet-4-5", tier: "balanced", available: true },
	{ provider: "anthropic", model: "claude-haiku-4-5", tier: "fast", available: true },
	{ provider: "anthropic", model: "claude-opus-4-1", tier: "powerful", available: true },
	{ provider: "openai", model: "gpt-4.1-mini", tier: "fast", available: true },
	{ provider: "openai", model: "gpt-4o", tier: "balanced", available: true },
	{ provider: "google", model: "gemini-2.0-flash", tier: "fast", available: false },
	{ provider: "openrouter", model: "ai21/jamba-large-1.7", tier: "balanced", available: true },
	{ provider: "openrouter", model: "openrouter/auto", tier: "balanced", available: true },
];

const ORDER = ["anthropic", "openai", "google", "openrouter"];

describe("heuristicTierDefaults", () => {
	test("picks the first model of the tier per provider, in preference order", () => {
		expect(heuristicTierDefaults(MODELS, "fast", ORDER)).toEqual([
			{ provider: "anthropic", model: "claude-haiku-4-5" },
			{ provider: "openai", model: "gpt-4.1-mini" },
			// openrouter's built-in rung answers EVERY tier (as the router does),
			// so it appears here even though openrouter/auto is catalogued balanced.
			{ provider: "openrouter", model: "openrouter/auto" },
		]);
	});

	test("openrouter shows the BUILT-IN rung, not the alphabetical first", () => {
		const balanced = heuristicTierDefaults(MODELS, "balanced", ORDER);
		expect(balanced).toContainEqual({ provider: "openrouter", model: "openrouter/auto" });
		expect(balanced).not.toContainEqual({
			provider: "openrouter",
			model: "ai21/jamba-large-1.7",
		});
	});

	test("falls back to the scan when the built-in rung is not in the catalog", () => {
		const withoutAuto = MODELS.filter((m) => m.model !== "openrouter/auto");
		expect(heuristicTierDefaults(withoutAuto, "balanced", ORDER)).toContainEqual({
			provider: "openrouter",
			model: "ai21/jamba-large-1.7",
		});
	});

	test("unreachable providers contribute no default", () => {
		// google's only model is available:false — it never appears.
		expect(heuristicTierDefaults(MODELS, "fast", ORDER).map((e) => e.provider)).not.toContain(
			"google",
		);
	});

	test("a provider with no model in the tier is skipped, not defaulted", () => {
		// openai has no powerful-tier model → absent. anthropic does. openrouter
		// rides its built-in rung.
		expect(heuristicTierDefaults(MODELS, "powerful", ORDER)).toEqual([
			{ provider: "anthropic", model: "claude-opus-4-1" },
			{ provider: "openrouter", model: "openrouter/auto" },
		]);
	});

	test("an empty catalog or an empty order yields no defaults", () => {
		expect(heuristicTierDefaults([], "fast", ORDER)).toEqual([]);
		expect(heuristicTierDefaults(MODELS, "fast", [])).toEqual([]);
	});

	test("a model with no `available` field counts as reachable", () => {
		expect(heuristicTierDefaults([{ provider: "openai", model: "m", tier: "fast" }], "fast", [
			"openai",
		])).toEqual([{ provider: "openai", model: "m" }]);
	});
});

describe("selectableModels", () => {
	test("same-tier models come first, cross-tier ones remain selectable", () => {
		const fast = selectableModels(MODELS, "fast");
		expect(fast[0]!.tier).toBe("fast");
		expect(fast.filter((m) => m.tier === "fast")).toHaveLength(2);
		// google's unavailable model is filtered out entirely.
		expect(fast.some((m) => m.provider === "google")).toBe(false);
		// but a cross-tier pin is still offered.
		expect(fast.some((m) => m.tier === "balanced")).toBe(true);
	});
});

describe("formatEntry", () => {
	test("renders provider/model", () => {
		expect(formatEntry({ provider: "openai", model: "gpt-4o" })).toBe("openai/gpt-4o");
	});
});

describe("list edits are copy-on-write and report no-ops", () => {
	const rungs = [
		{ provider: "a", model: "1" },
		{ provider: "b", model: "2" },
		{ provider: "c", model: "3" },
	];

	test("moveRung swaps neighbours without mutating the input", () => {
		expect(moveRung(rungs, 0, 1)!.map((r) => r.model)).toEqual(["2", "1", "3"]);
		expect(moveRung(rungs, 2, -1)!.map((r) => r.model)).toEqual(["1", "3", "2"]);
		expect(rungs.map((r) => r.model)).toEqual(["1", "2", "3"]);
	});

	test("moveRung returns null at either end and for an out-of-range index", () => {
		expect(moveRung(rungs, 0, -1)).toBeNull();
		expect(moveRung(rungs, 2, 1)).toBeNull();
		expect(moveRung(rungs, -1, 1)).toBeNull();
		expect(moveRung(rungs, 9, -1)).toBeNull();
	});

	test("addRung appends, and returns null for an exact duplicate", () => {
		expect(addRung(rungs, { provider: "d", model: "4" })).toHaveLength(4);
		expect(addRung(rungs, { provider: "b", model: "2" })).toBeNull();
		// Same model on a DIFFERENT provider is a legitimate distinct rung.
		expect(addRung(rungs, { provider: "z", model: "2" })).toHaveLength(4);
	});

	test("removeRung drops one entry, null for out-of-range", () => {
		expect(removeRung(rungs, 1)!.map((r) => r.model)).toEqual(["1", "3"]);
		expect(removeRung(rungs, -1)).toBeNull();
		expect(removeRung(rungs, 3)).toBeNull();
		expect(rungs).toHaveLength(3);
	});
});

describe("withTier", () => {
	test("withTier replaces exactly one tier and keeps the others", () => {
		const base = withTier(emptyTierLadder(), "fast", [{ provider: "a", model: "1" }]);
		const next = withTier(base, "powerful", [{ provider: "b", model: "2" }]);
		expect(next.fast).toEqual([{ provider: "a", model: "1" }]);
		expect(next.powerful).toEqual([{ provider: "b", model: "2" }]);
		expect(next.balanced).toEqual([]);
		// The input ladder is untouched.
		expect(base.powerful).toEqual([]);
	});

});
