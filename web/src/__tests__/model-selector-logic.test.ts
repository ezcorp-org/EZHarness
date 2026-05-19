import { test, expect, describe } from "bun:test";
import { PROVIDER_META } from "$lib/provider-meta.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface ModelOption {
	provider: string;
	model: string;
	tier: string;
	costTier: string;
	reasoning?: boolean;
	displayName?: string;
	available: boolean;
}

// ── Logic extracted from ModelSelector.svelte ────────────────────────────────

const TIER_ORDER = ["powerful", "balanced", "fast"] as const;

const TIER_LABELS: Record<string, string> = {
	fast: "Fast",
	balanced: "Balanced",
	powerful: "Powerful",
};

const COST_LABELS: Record<string, string> = {
	low: "$",
	medium: "$$",
	high: "$$$",
};

function filterAvailable(models: ModelOption[]): ModelOption[] {
	return models.filter((m) => m.available);
}

function groupModels(models: ModelOption[]): { tier: string; label: string; models: ModelOption[] }[] {
	const groups: { tier: string; label: string; models: ModelOption[] }[] = [];
	for (const tier of TIER_ORDER) {
		const tierModels = models.filter((m) => m.tier === tier);
		if (tierModels.length > 0) {
			groups.push({ tier, label: TIER_LABELS[tier] ?? tier, models: tierModels });
		}
	}
	const knownTiers = new Set(TIER_ORDER);
	const otherModels = models.filter((m) => !knownTiers.has(m.tier as (typeof TIER_ORDER)[number]));
	if (otherModels.length > 0) {
		groups.push({ tier: "other", label: "Other", models: otherModels });
	}
	return groups;
}

function displayLabel(
	selected: { provider: string; model: string } | null,
	models: ModelOption[],
): string {
	if (!selected) return "Select model";
	const m = models.find((m) => m.provider === selected.provider && m.model === selected.model);
	const name = m?.displayName ?? selected.model;
	return name.length > 24 ? name.slice(0, 24) + "..." : name;
}

function displayProvider(
	selected: { provider: string; model: string } | null,
): { label: string } | null {
	if (!selected) return null;
	const meta = PROVIDER_META[selected.provider];
	return meta ? { label: meta.label } : { label: "?" };
}

function getReasoningCapability(
	models: ModelOption[],
	provider: string,
	model: string,
): boolean {
	const m = models.find((m) => m.provider === provider && m.model === model);
	return !!m?.reasoning;
}

// ── Tests ────────────────────────────────────────────────────────────────────

const makeModel = (overrides: Partial<ModelOption> = {}): ModelOption => ({
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
		expect(groups[0].tier).toBe("fast");
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
		expect(groups[groups.length - 1].tier).toBe("other");
		expect(groups[groups.length - 1].label).toBe("Other");
		expect(groups[groups.length - 1].models[0].model).toBe("exp-1");
	});

	test("puts models in correct group", () => {
		const models = [
			makeModel({ tier: "fast", model: "f1" }),
			makeModel({ tier: "fast", model: "f2" }),
			makeModel({ tier: "powerful", model: "p1" }),
		];
		const groups = groupModels(models);
		const fastGroup = groups.find((g) => g.tier === "fast")!;
		expect(fastGroup.models).toHaveLength(2);
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

describe("getReasoningCapability", () => {
	test("returns true for a reasoning model", () => {
		const models = [makeModel({ model: "claude-3-7", reasoning: true })];
		expect(getReasoningCapability(models, "anthropic", "claude-3-7")).toBe(true);
	});

	test("returns false for a non-reasoning model", () => {
		const models = [makeModel({ model: "claude-3-5-sonnet", reasoning: false })];
		expect(getReasoningCapability(models, "anthropic", "claude-3-5-sonnet")).toBe(false);
	});

	test("returns false when reasoning field is absent", () => {
		const models = [makeModel({ model: "some-model" })];
		expect(getReasoningCapability(models, "anthropic", "some-model")).toBe(false);
	});

	test("returns false when model not found", () => {
		expect(getReasoningCapability([], "anthropic", "missing")).toBe(false);
	});

	test("matches by both provider and model", () => {
		const models = [
			makeModel({ provider: "openai", model: "gpt-4", reasoning: true }),
			makeModel({ provider: "anthropic", model: "gpt-4", reasoning: false }),
		];
		expect(getReasoningCapability(models, "openai", "gpt-4")).toBe(true);
		expect(getReasoningCapability(models, "anthropic", "gpt-4")).toBe(false);
	});
});
