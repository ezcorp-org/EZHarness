/**
 * Pure-logic unit tests for the Capabilities panel (Phase 3 §5.2;
 * multi-provider rework — residual #3): grant↔mode mapping, the
 * multi-select provider seed/round-trip, Custom prefill, empty-selection
 * validation, and the FIELD-LEVEL partial-override builder (mirrors the
 * resolver's `{...instanceDef, ...definedFields}` merge).
 */
import { describe, test, expect } from "vitest";
import {
	grantToMode,
	sameProviderSet,
	seedProviders,
	formFromEffective,
	buildOverride,
	grantForMode,
	sanitizePositiveInt,
	isCustomFormValid,
	providerOptions,
	type EffectivePolicyView,
	type HeldCapabilityView,
} from "./capability-policy-ui";

// The full known-provider set the UI offers in these tests.
const AVAILABLE = ["searxng", "brave", "tavily"];
const INHERITED: EffectivePolicyView = { quota: 100, maxResults: 5, providers: "all" };

describe("grantToMode", () => {
	test("false → disabled", () => {
		expect(grantToMode(false)).toBe("disabled");
	});
	test("'inherit' / undefined → inherit", () => {
		expect(grantToMode("inherit")).toBe("inherit");
		expect(grantToMode(undefined)).toBe("inherit");
	});
	test("object → custom", () => {
		expect(grantToMode({ quota: 500 })).toBe("custom");
	});
});

describe("providerOptions", () => {
	test("derives the provider list from the schema select, dropping the inherit sentinel", () => {
		const c: HeldCapabilityView = {
			cap: "search",
			schema: [
				{
					key: "providers",
					field: {
						type: "select",
						label: "Allowed providers",
						options: [
							{ value: "inherit", label: "Inherit" },
							{ value: "searxng", label: "searxng" },
							{ value: "brave", label: "brave" },
						],
					},
				},
			],
			effective: { denied: false, providers: "all" },
			grant: "inherit",
		};
		expect(providerOptions(c)).toEqual(["searxng", "brave"]);
	});
	test("returns [] when no providers select exists", () => {
		const c: HeldCapabilityView = {
			cap: "search",
			schema: [{ key: "quota", field: { type: "number", label: "Quota" } }],
			effective: { denied: false },
			grant: "inherit",
		};
		expect(providerOptions(c)).toEqual([]);
	});
});

describe("sameProviderSet", () => {
	test("order-insensitive set equality", () => {
		expect(sameProviderSet(["a", "b"], ["b", "a"])).toBe(true);
		expect(sameProviderSet(["a"], ["a", "b"])).toBe(false);
		expect(sameProviderSet(["a", "c"], ["a", "b"])).toBe(false);
		expect(sameProviderSet([], [])).toBe(true);
	});
});

describe("seedProviders", () => {
	test("'all' → every available provider checked", () => {
		expect(seedProviders("all", AVAILABLE)).toEqual(AVAILABLE);
	});
	test("an explicit list → exactly those checked (intersected with available)", () => {
		expect(seedProviders(["brave", "tavily"], AVAILABLE)).toEqual(["brave", "tavily"]);
	});
	test("a stale/unknown provider is dropped (server ceiling would drop it too)", () => {
		expect(seedProviders(["brave", "ghost"], AVAILABLE)).toEqual(["brave"]);
	});
});

describe("formFromEffective", () => {
	test("'all' providers → every available provider checked", () => {
		expect(formFromEffective(INHERITED, AVAILABLE)).toEqual({
			providers: AVAILABLE,
			quota: 100,
			maxResults: 5,
		});
	});
	test("a 2-provider grant seeds exactly two checked providers (no info loss)", () => {
		const form = formFromEffective({ quota: 80, maxResults: 9, providers: ["searxng", "brave"] }, AVAILABLE);
		expect(form.providers).toEqual(["searxng", "brave"]);
		expect(form.quota).toBe(80);
		expect(form.maxResults).toBe(9);
	});
});

describe("isCustomFormValid", () => {
	test("false on an empty provider selection; true otherwise", () => {
		expect(isCustomFormValid({ providers: [], quota: 1, maxResults: 1 })).toBe(false);
		expect(isCustomFormValid({ providers: ["searxng"], quota: 1, maxResults: 1 })).toBe(true);
	});
});

describe("sanitizePositiveInt", () => {
	test("valid positive int floored", () => {
		expect(sanitizePositiveInt(42.9, 1)).toBe(42);
	});
	test("invalid (<1, NaN, non-number) → fallback", () => {
		expect(sanitizePositiveInt(0, 7)).toBe(7);
		expect(sanitizePositiveInt(Number.NaN, 9)).toBe(9);
		expect(sanitizePositiveInt(-3, 5)).toBe(5);
	});
});

describe("buildOverride (FIELD-LEVEL partial, multi-select)", () => {
	test("all fields == inherited (full set checked) → collapses to 'inherit'", () => {
		expect(buildOverride({ providers: AVAILABLE, quota: 100, maxResults: 5 }, INHERITED, AVAILABLE)).toBe(
			"inherit",
		);
	});

	test("full set checked but quota changed → { quota } (providers omitted = inherit)", () => {
		expect(buildOverride({ providers: AVAILABLE, quota: 500, maxResults: 5 }, INHERITED, AVAILABLE)).toEqual({
			quota: 500,
		});
	});

	test("a 2-of-3 subset round-trips verbatim → { providers: [...] }", () => {
		expect(
			buildOverride({ providers: ["searxng", "brave"], quota: 100, maxResults: 5 }, INHERITED, AVAILABLE),
		).toEqual({ providers: ["searxng", "brave"] });
	});

	test("collapses to inherit ONLY on true set-equality (order-insensitive)", () => {
		// Same set, different order → still inherit.
		expect(
			buildOverride({ providers: ["tavily", "searxng", "brave"], quota: 100, maxResults: 5 }, INHERITED, AVAILABLE),
		).toBe("inherit");
	});

	test("a single-provider subset → { providers: [provider] }", () => {
		expect(buildOverride({ providers: ["searxng"], quota: 100, maxResults: 5 }, INHERITED, AVAILABLE)).toEqual({
			providers: ["searxng"],
		});
	});

	test("subset + quota + maxResults → all included", () => {
		expect(
			buildOverride({ providers: ["brave"], quota: 250, maxResults: 8 }, INHERITED, AVAILABLE),
		).toEqual({ providers: ["brave"], quota: 250, maxResults: 8 });
	});

	test("junk numeric input falls back to inherited (no spurious override)", () => {
		expect(buildOverride({ providers: AVAILABLE, quota: 0, maxResults: 5 }, INHERITED, AVAILABLE)).toBe(
			"inherit",
		);
	});

	test("an empty provider selection throws (callers must gate via isCustomFormValid)", () => {
		expect(() => buildOverride({ providers: [], quota: 100, maxResults: 5 }, INHERITED, AVAILABLE)).toThrow(
			/empty provider selection/,
		);
	});
});

describe("grantForMode", () => {
	const form = { providers: AVAILABLE, quota: 500, maxResults: 5 };
	test("disabled → false", () => {
		expect(grantForMode("disabled", form, INHERITED, AVAILABLE)).toBe(false);
	});
	test("inherit → 'inherit'", () => {
		expect(grantForMode("inherit", form, INHERITED, AVAILABLE)).toBe("inherit");
	});
	test("custom → the built field-level override", () => {
		expect(grantForMode("custom", form, INHERITED, AVAILABLE)).toEqual({ quota: 500 });
	});
});
