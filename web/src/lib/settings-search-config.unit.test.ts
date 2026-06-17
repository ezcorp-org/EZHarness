/**
 * Pure-logic unit tests for the Settings → Search admin page
 * (`settings-search-config.ts`): read-defaults coercion, providers
 * text round-trip, and numeric sanitization.
 */
import { describe, test, expect } from "vitest";
import {
	SEARCH_DEFAULT_KEYS,
	SEARCH_DEFAULT_FALLBACKS,
	SEARCH_BYOK_PROVIDERS,
	providersToText,
	providersFromText,
	readSearchDefaults,
	sanitizeQuota,
	sanitizeMaxResults,
} from "./settings-search-config";

describe("constants", () => {
	test("BYOK providers are the keyed search providers (no keyless searxng/duckduckgo)", () => {
		expect([...SEARCH_BYOK_PROVIDERS]).toEqual(["tavily", "brave", "exa", "serpapi", "jina"]);
	});

	test("default keys match the global:search:* namespace", () => {
		expect(SEARCH_DEFAULT_KEYS.allowedByDefault).toBe("global:search:allowedByDefault");
		expect(SEARCH_DEFAULT_KEYS.defaultQuota).toBe("global:search:defaultQuota");
		expect(SEARCH_DEFAULT_KEYS.defaultMaxResults).toBe("global:search:defaultMaxResults");
		expect(SEARCH_DEFAULT_KEYS.defaultProviders).toBe("global:search:defaultProviders");
	});
});

describe("providersToText", () => {
	test("array → comma list", () => {
		expect(providersToText(["searxng", "brave"])).toBe("searxng, brave");
	});
	test("array with junk entries → filtered", () => {
		expect(providersToText(["searxng", 7, "", "brave"])).toBe("searxng, brave");
	});
	test("empty array → 'all'", () => {
		expect(providersToText([])).toBe("all");
	});
	test("'all' / non-array → 'all'", () => {
		expect(providersToText("all")).toBe("all");
		expect(providersToText(undefined)).toBe("all");
		expect(providersToText({ x: 1 })).toBe("all");
	});
});

describe("providersFromText", () => {
	test("empty / 'all' (any case) → 'all'", () => {
		expect(providersFromText("")).toBe("all");
		expect(providersFromText("  ")).toBe("all");
		expect(providersFromText("all")).toBe("all");
		expect(providersFromText("ALL")).toBe("all");
	});
	test("comma list → trimmed, de-duplicated array", () => {
		expect(providersFromText("searxng, brave , searxng")).toEqual(["searxng", "brave"]);
	});
	test("only-commas / whitespace → 'all'", () => {
		expect(providersFromText(" , , ")).toBe("all");
	});
});

describe("readSearchDefaults", () => {
	test("empty settings → hard-default fallbacks", () => {
		expect(readSearchDefaults({})).toEqual({
			allowedByDefault: SEARCH_DEFAULT_FALLBACKS.allowedByDefault,
			quota: SEARCH_DEFAULT_FALLBACKS.quota,
			maxResults: SEARCH_DEFAULT_FALLBACKS.maxResults,
			providers: "all",
		});
	});

	test("populated settings → coerced form", () => {
		const form = readSearchDefaults({
			[SEARCH_DEFAULT_KEYS.allowedByDefault]: false,
			[SEARCH_DEFAULT_KEYS.defaultQuota]: 250,
			[SEARCH_DEFAULT_KEYS.defaultMaxResults]: 12,
			[SEARCH_DEFAULT_KEYS.defaultProviders]: ["searxng", "tavily"],
		});
		expect(form).toEqual({
			allowedByDefault: false,
			quota: 250,
			maxResults: 12,
			providers: "searxng, tavily",
		});
	});

	test("malformed numeric / bool settings → per-field fallback", () => {
		const form = readSearchDefaults({
			[SEARCH_DEFAULT_KEYS.allowedByDefault]: "yes", // not a bool
			[SEARCH_DEFAULT_KEYS.defaultQuota]: 0, // < 1
			[SEARCH_DEFAULT_KEYS.defaultMaxResults]: "five", // not a number
		});
		expect(form.allowedByDefault).toBe(true);
		expect(form.quota).toBe(100);
		expect(form.maxResults).toBe(5);
	});

	test("'all' providers setting round-trips to 'all' text", () => {
		expect(readSearchDefaults({ [SEARCH_DEFAULT_KEYS.defaultProviders]: "all" }).providers).toBe("all");
	});
});

describe("sanitizeQuota / sanitizeMaxResults", () => {
	test("valid positive ints pass through (floored)", () => {
		expect(sanitizeQuota(42.9)).toBe(42);
		expect(sanitizeMaxResults(3.2)).toBe(3);
	});
	test("invalid (<1 / NaN) → hard default", () => {
		expect(sanitizeQuota(0)).toBe(100);
		expect(sanitizeQuota(Number.NaN)).toBe(100);
		expect(sanitizeMaxResults(-2)).toBe(5);
	});
});
