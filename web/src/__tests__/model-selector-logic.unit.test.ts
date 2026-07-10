/**
 * Unit tests for the model-picker's shared pure-logic module
 * (`$lib/model-selector-logic.ts`) — grouping/label rules the picker
 * renders with, plus the Auto (smart routing) selection semantics:
 * the `{provider:"auto",model:"auto"}` sentinel, auto-persist
 * suppression, the "Auto (smart routing)" / "Auto → <served>" labels,
 * and the wire resolution (`model: null` sentinel on turn 1, served
 * pin afterwards — the client half of route-once-per-conversation).
 *
 * Runs in the vitest leg (`*.unit.test.ts`) so v8 line-covers the
 * module for the coverage gate.
 */
import { test, expect, describe } from "vitest";
import { PROVIDER_META } from "$lib/provider-meta.js";
import {
	AUTO_LABEL,
	AUTO_MODEL,
	AUTO_PROVIDER,
	AUTO_SELECTION,
	COST_LABELS,
	autoRowVisible,
	autoServedFromMessages,
	displayLabel,
	filterAvailable,
	groupModels,
	isAutoSelection,
	resolveWireModel,
	shouldAutoSelectDefault,
	sortNewestFirst,
	type ModelOptionLike,
	type ServedMessageLike,
} from "$lib/model-selector-logic.js";

function displayProvider(
	selected: { provider: string; model: string } | null,
): { label: string } | null {
	if (!selected) return null;
	const meta = PROVIDER_META[selected.provider];
	return meta ? { label: meta.label } : { label: "?" };
}

// ── Tests ────────────────────────────────────────────────────────────────────

const makeModel = (overrides: Partial<ModelOptionLike> = {}): ModelOptionLike => ({
	provider: "anthropic",
	model: "claude-3-5-sonnet",
	tier: "balanced",
	costTier: "medium",
	available: true,
	...overrides,
});

describe("filterAvailable", () => {
	test("returns only available models", () => {
		const models = [
			makeModel({ available: true, model: "a" }),
			makeModel({ available: false, model: "b" }),
			makeModel({ available: true, model: "c" }),
		];
		const result = filterAvailable(models);
		expect(result).toHaveLength(2);
		expect(result.map((m) => m.model)).toEqual(["a", "c"]);
	});

	test("returns empty array when none available", () => {
		const models = [makeModel({ available: false }), makeModel({ available: false })];
		expect(filterAvailable(models)).toEqual([]);
	});

	test("returns all when all available", () => {
		const models = [makeModel(), makeModel({ model: "b" })];
		expect(filterAvailable(models)).toHaveLength(2);
	});
});

describe("sortNewestFirst", () => {
	test("groups by non-numeric family prefix, preserving first-seen family order", () => {
		const models = [
			makeModel({ model: "claude-opus-4-6" }),
			makeModel({ model: "gpt-4o" }),
			makeModel({ model: "claude-opus-4-7" }),
		];
		expect(sortNewestFirst(models).map((m) => m.model)).toEqual([
			"claude-opus-4-7",
			"claude-opus-4-6",
			"gpt-4o",
		]);
	});

	test("sorts numerically within a family (10 > 9)", () => {
		const models = [
			makeModel({ model: "family-9" }),
			makeModel({ model: "family-10" }),
		];
		expect(sortNewestFirst(models).map((m) => m.model)).toEqual(["family-10", "family-9"]);
	});

	test("model ids with no leading non-digit prefix fall back to the full id as family", () => {
		const models = [makeModel({ model: "4o-mini" }), makeModel({ model: "4o-mini" })];
		expect(sortNewestFirst(models)).toHaveLength(2);
	});
});

describe("groupModels – tier ordering", () => {
	test("groups follow TIER_ORDER: powerful, balanced, fast", () => {
		const models = [
			makeModel({ tier: "fast", model: "fast-1" }),
			makeModel({ tier: "powerful", model: "pow-1" }),
			makeModel({ tier: "balanced", model: "bal-1" }),
		];
		const groups = groupModels(models);
		expect(groups.map((g) => g.tier)).toEqual(["powerful", "balanced", "fast"]);
	});

	test("omits tiers with no models", () => {
		const models = [makeModel({ tier: "fast", model: "f1" })];
		const groups = groupModels(models);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.tier).toBe("fast");
	});

	test("uses human-readable label for known tiers", () => {
		const models = [
			makeModel({ tier: "powerful", model: "p1" }),
			makeModel({ tier: "balanced", model: "b1" }),
			makeModel({ tier: "fast", model: "f1" }),
		];
		const groups = groupModels(models);
		expect(groups.find((g) => g.tier === "powerful")?.label).toBe("Powerful");
		expect(groups.find((g) => g.tier === "balanced")?.label).toBe("Balanced");
		expect(groups.find((g) => g.tier === "fast")?.label).toBe("Fast");
	});

	test("places unknown tiers in 'Other' group at the end", () => {
		const models = [
			makeModel({ tier: "fast", model: "f1" }),
			makeModel({ tier: "experimental", model: "exp-1" }),
		];
		const groups = groupModels(models);
		expect(groups[groups.length - 1]!.tier).toBe("other");
		expect(groups[groups.length - 1]!.label).toBe("Other");
		expect(groups[groups.length - 1]!.models[0]!.model).toBe("exp-1");
	});

	test("puts models in correct group, newest-first within a family", () => {
		const models = [
			makeModel({ tier: "fast", model: "f-1" }),
			makeModel({ tier: "fast", model: "f-2" }),
			makeModel({ tier: "powerful", model: "p-1" }),
		];
		const groups = groupModels(models);
		const fastGroup = groups.find((g) => g.tier === "fast")!;
		expect(fastGroup.models).toHaveLength(2);
		expect(fastGroup.models.map((m) => m.model)).toEqual(["f-2", "f-1"]);
	});

	test("returns empty array for empty input", () => {
		expect(groupModels([])).toEqual([]);
	});
});

describe("displayLabel", () => {
	test("returns 'Select model' when no selection", () => {
		expect(displayLabel(null, [])).toBe("Select model");
	});

	test("uses displayName when available", () => {
		const models = [makeModel({ model: "claude-3-5-sonnet", displayName: "Claude 3.5 Sonnet" })];
		expect(displayLabel({ provider: "anthropic", model: "claude-3-5-sonnet" }, models)).toBe(
			"Claude 3.5 Sonnet",
		);
	});

	test("falls back to model id when no displayName", () => {
		const models = [makeModel({ model: "my-model", displayName: undefined })];
		expect(displayLabel({ provider: "anthropic", model: "my-model" }, models)).toBe("my-model");
	});

	test("falls back to model id when selected model not found in list", () => {
		expect(displayLabel({ provider: "anthropic", model: "unknown-model" }, [])).toBe(
			"unknown-model",
		);
	});

	test("truncates names longer than 24 characters", () => {
		const longName = "A Very Long Model Name Here!";
		const models = [makeModel({ model: "m", displayName: longName })];
		const result = displayLabel({ provider: "anthropic", model: "m" }, models);
		expect(result.length).toBe(27); // 24 chars + "..."
		expect(result.endsWith("...")).toBe(true);
		expect(result).toBe(longName.slice(0, 24) + "...");
	});

	test("does not truncate names exactly 24 characters", () => {
		const name = "123456789012345678901234"; // exactly 24
		const models = [makeModel({ model: "m", displayName: name })];
		const result = displayLabel({ provider: "anthropic", model: "m" }, models);
		expect(result).toBe(name);
		expect(result.endsWith("...")).toBe(false);
	});

	test("Auto selection with no served model renders the Auto label", () => {
		expect(displayLabel(AUTO_SELECTION, [makeModel()])).toBe(AUTO_LABEL);
	});

	test("Auto selection with a served model renders 'Auto → <displayName>'", () => {
		const models = [
			makeModel({ provider: "anthropic", model: "claude-3-5-sonnet", displayName: "Sonnet" }),
		];
		expect(
			displayLabel(AUTO_SELECTION, models, { provider: "anthropic", model: "claude-3-5-sonnet" }),
		).toBe("Auto → Sonnet");
	});

	test("Auto → falls back to the served model id when not in the models list", () => {
		expect(displayLabel(AUTO_SELECTION, [], { provider: "openai", model: "gpt-4o" })).toBe(
			"Auto → gpt-4o",
		);
	});

	test("Auto → label truncates at 24 characters", () => {
		const result = displayLabel(AUTO_SELECTION, [], {
			provider: "anthropic",
			model: "a-really-long-served-model-id",
		});
		expect(result.length).toBe(27);
		expect(result.startsWith("Auto → ")).toBe(true);
		expect(result.endsWith("...")).toBe(true);
	});
});

describe("displayProvider", () => {
	test("returns null when no selection", () => {
		expect(displayProvider(null)).toBeNull();
	});

	test("returns anthropic label for anthropic provider", () => {
		const result = displayProvider({ provider: "anthropic", model: "any" });
		expect(result).toEqual({ label: "A" });
	});

	test("returns openai label for openai provider", () => {
		const result = displayProvider({ provider: "openai", model: "any" });
		expect(result).toEqual({ label: "O" });
	});

	test("returns google label for google provider", () => {
		const result = displayProvider({ provider: "google", model: "any" });
		expect(result).toEqual({ label: "G" });
	});

	test("returns unknown fallback for unrecognized provider", () => {
		const result = displayProvider({ provider: "mystery-ai", model: "any" });
		expect(result).toEqual({ label: "?" });
	});
});

describe("COST_LABELS", () => {
	test("low maps to $", () => {
		expect(COST_LABELS["low"]).toBe("$");
	});

	test("medium maps to $$", () => {
		expect(COST_LABELS["medium"]).toBe("$$");
	});

	test("high maps to $$$", () => {
		expect(COST_LABELS["high"]).toBe("$$$");
	});

	test("unknown cost tier returns undefined", () => {
		expect(COST_LABELS["free"]).toBeUndefined();
	});
});

describe("isAutoSelection", () => {
	test("true for the Auto sentinel", () => {
		expect(isAutoSelection({ provider: AUTO_PROVIDER, model: AUTO_MODEL })).toBe(true);
		expect(isAutoSelection(AUTO_SELECTION)).toBe(true);
	});

	test("false for null", () => {
		expect(isAutoSelection(null)).toBe(false);
	});

	test("false for a concrete model", () => {
		expect(isAutoSelection({ provider: "anthropic", model: "claude-3-5-sonnet" })).toBe(false);
	});

	test("false when only one half matches the sentinel", () => {
		expect(isAutoSelection({ provider: "auto", model: "gpt-4o" })).toBe(false);
		expect(isAutoSelection({ provider: "openai", model: "auto" })).toBe(false);
	});
});

describe("shouldAutoSelectDefault — auto-persist suppression", () => {
	test("fires only when nothing is selected and models exist", () => {
		expect(shouldAutoSelectDefault(null, [makeModel()])).toBe(true);
	});

	test("suppressed when a concrete model is selected", () => {
		expect(shouldAutoSelectDefault({ provider: "openai", model: "gpt-4o" }, [makeModel()])).toBe(
			false,
		);
	});

	test("suppressed when the Auto sentinel is selected (deliberate Auto choice wins)", () => {
		expect(shouldAutoSelectDefault(AUTO_SELECTION, [makeModel()])).toBe(false);
	});

	test("suppressed when there are no models to pick from", () => {
		expect(shouldAutoSelectDefault(null, [])).toBe(false);
	});
});

describe("autoRowVisible", () => {
	test("hidden when allowAuto is off", () => {
		expect(autoRowVisible(false, "")).toBe(false);
	});

	test("visible with empty search", () => {
		expect(autoRowVisible(true, "")).toBe(true);
		expect(autoRowVisible(true, "   ")).toBe(true);
	});

	test("visible when the search matches the Auto label", () => {
		expect(autoRowVisible(true, "auto")).toBe(true);
		expect(autoRowVisible(true, "SMART")).toBe(true);
		expect(autoRowVisible(true, "routing")).toBe(true);
	});

	test("hidden when the search matches nothing in the Auto label", () => {
		expect(autoRowVisible(true, "opus")).toBe(false);
	});
});

const routedAssistant = (over: Partial<ServedMessageLike> = {}): ServedMessageLike => ({
	role: "assistant",
	provider: "anthropic",
	model: "claude-3-5-sonnet",
	usage: { requestedModel: null },
	...over,
});

describe("autoServedFromMessages", () => {
	test("null for an empty conversation", () => {
		expect(autoServedFromMessages([])).toBeNull();
	});

	test("returns the served identity of the last auto-routed assistant turn", () => {
		const messages: ServedMessageLike[] = [
			{ role: "user" },
			routedAssistant(),
			{ role: "user" },
		];
		expect(autoServedFromMessages(messages)).toEqual({
			provider: "anthropic",
			model: "claude-3-5-sonnet",
		});
	});

	test("skips usage-less assistant rows (streaming placeholders / optimistic rows)", () => {
		const messages: ServedMessageLike[] = [
			routedAssistant(),
			{ role: "assistant", provider: null, model: null, usage: null },
		];
		expect(autoServedFromMessages(messages)).toEqual({
			provider: "anthropic",
			model: "claude-3-5-sonnet",
		});
	});

	test("null when the last real assistant turn was user-pinned (re-route once on Auto)", () => {
		const messages: ServedMessageLike[] = [
			routedAssistant(),
			routedAssistant({ usage: { requestedModel: "gpt-4o" } }),
		];
		expect(autoServedFromMessages(messages)).toBeNull();
	});

	test("null for legacy rows without the provenance key", () => {
		expect(autoServedFromMessages([routedAssistant({ usage: {} })])).toBeNull();
	});

	test("null when the auto-routed row is missing a served identity", () => {
		expect(autoServedFromMessages([routedAssistant({ model: null })])).toBeNull();
	});

	test("null when the conversation has only user turns", () => {
		expect(autoServedFromMessages([{ role: "user" }, { role: "user" }])).toBeNull();
	});
});

describe("resolveWireModel", () => {
	test("no selection → both undefined (absent fields; legacy fallback)", () => {
		expect(resolveWireModel(null, [])).toEqual({ provider: undefined, model: undefined });
	});

	test("concrete selection passes through verbatim", () => {
		expect(resolveWireModel({ provider: "openai", model: "gpt-4o" }, [routedAssistant()])).toEqual(
			{ provider: "openai", model: "gpt-4o" },
		);
	});

	test("Auto with no routed turn yet → explicit null sentinel", () => {
		expect(resolveWireModel(AUTO_SELECTION, [{ role: "user" }])).toEqual({
			provider: null,
			model: null,
		});
	});

	test("Auto after a routed turn → re-sends the SERVED pair (route-once mirror)", () => {
		expect(resolveWireModel(AUTO_SELECTION, [{ role: "user" }, routedAssistant()])).toEqual({
			provider: "anthropic",
			model: "claude-3-5-sonnet",
		});
	});
});
