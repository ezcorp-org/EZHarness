/**
 * Pure-logic unit tests for the Capabilities panel (Phase 3 §5.2):
 * grant↔mode mapping, providers single-select projection, Custom prefill,
 * and the FIELD-LEVEL partial-override builder (mirrors the resolver's
 * `{...instanceDef, ...definedFields}` merge).
 */
import { describe, test, expect } from "vitest";
import {
	grantToMode,
	providersToSelectValue,
	formFromEffective,
	buildOverride,
	grantForMode,
	sanitizePositiveInt,
	type EffectivePolicyView,
} from "./capability-policy-ui";

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

describe("providersToSelectValue", () => {
	test("'all' → inherit sentinel", () => {
		expect(providersToSelectValue("all")).toBe("inherit");
	});
	test("single-element list → that provider", () => {
		expect(providersToSelectValue(["searxng"])).toBe("searxng");
	});
	test("multi-element list → inherit (override can't express a subset)", () => {
		expect(providersToSelectValue(["searxng", "brave"])).toBe("inherit");
	});
	test("empty list → inherit", () => {
		expect(providersToSelectValue([])).toBe("inherit");
	});
});

describe("formFromEffective", () => {
	test("projects effective policy into the editable form", () => {
		expect(formFromEffective({ quota: 80, maxResults: 9, providers: ["tavily"] })).toEqual({
			providers: "tavily",
			quota: 80,
			maxResults: 9,
		});
	});
	test("'all' providers → inherit select value", () => {
		expect(formFromEffective(INHERITED).providers).toBe("inherit");
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

describe("buildOverride (FIELD-LEVEL partial)", () => {
	test("all fields == inherited → collapses to 'inherit'", () => {
		expect(buildOverride({ providers: "inherit", quota: 100, maxResults: 5 }, INHERITED)).toBe("inherit");
	});

	test("only quota changed → { quota } (the exit-criteria 500 case)", () => {
		expect(buildOverride({ providers: "inherit", quota: 500, maxResults: 5 }, INHERITED)).toEqual({ quota: 500 });
	});

	test("only maxResults changed → { maxResults }", () => {
		expect(buildOverride({ providers: "inherit", quota: 100, maxResults: 3 }, INHERITED)).toEqual({ maxResults: 3 });
	});

	test("provider pinned → { providers: [provider] }", () => {
		expect(buildOverride({ providers: "searxng", quota: 100, maxResults: 5 }, INHERITED)).toEqual({
			providers: ["searxng"],
		});
	});

	test("multiple fields → all included", () => {
		expect(buildOverride({ providers: "brave", quota: 250, maxResults: 8 }, INHERITED)).toEqual({
			providers: ["brave"],
			quota: 250,
			maxResults: 8,
		});
	});

	test("junk numeric input falls back to inherited (no spurious override)", () => {
		expect(buildOverride({ providers: "inherit", quota: 0, maxResults: 5 }, INHERITED)).toBe("inherit");
	});
});

describe("grantForMode", () => {
	const form = { providers: "inherit", quota: 500, maxResults: 5 };
	test("disabled → false", () => {
		expect(grantForMode("disabled", form, INHERITED)).toBe(false);
	});
	test("inherit → 'inherit'", () => {
		expect(grantForMode("inherit", form, INHERITED)).toBe("inherit");
	});
	test("custom → the built field-level override", () => {
		expect(grantForMode("custom", form, INHERITED)).toEqual({ quota: 500 });
	});
});
