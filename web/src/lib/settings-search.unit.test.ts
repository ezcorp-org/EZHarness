/**
 * Unit tests for the client-side settings nav search (locked decision 3):
 * substring match over label / id / anchors, admin gating, ranking
 * (label-prefix > label-substring > anchor/id), empty-query passthrough.
 */
import { describe, test, expect } from "vitest";
import { filterSettings } from "./settings-search";
import { SETTINGS_NAV, type SettingsNavItem } from "./settings-nav";

const ids = (items: SettingsNavItem[]) => items.map((i) => i.id);

describe("filterSettings — admin gating", () => {
	test("non-admins never see adminOnly items (empty query)", () => {
		const result = filterSettings("", SETTINGS_NAV, false);
		expect(result.every((i) => !i.adminOnly)).toBe(true);
		expect(ids(result)).toContain("models");
		expect(ids(result)).not.toContain("admin");
		expect(ids(result)).not.toContain("admin-audit");
	});

	test("admins see adminOnly items", () => {
		const result = filterSettings("", SETTINGS_NAV, true);
		expect(ids(result)).toContain("admin");
		expect(ids(result)).toContain("admin-audit");
	});

	test("admin-only matches are hidden from non-admins even with a query", () => {
		// "teams" is an anchor of the admin entry only (note: "audit"
		// would also match the member-visible personalization page via its
		// "audit-visibility" anchor, so it is NOT an admin-only token).
		expect(ids(filterSettings("teams", SETTINGS_NAV, false))).toEqual([]);
		expect(ids(filterSettings("teams", SETTINGS_NAV, true)).length).toBeGreaterThan(0);
	});
});

describe("filterSettings — empty query passthrough", () => {
	test("empty query returns the full visible set in registry order", () => {
		const result = filterSettings("", SETTINGS_NAV, true);
		expect(ids(result)).toEqual(ids(SETTINGS_NAV));
	});

	test("whitespace-only query is treated as empty", () => {
		expect(ids(filterSettings("   ", SETTINGS_NAV, true))).toEqual(ids(SETTINGS_NAV));
	});
});

describe("filterSettings — substring matching", () => {
	test("matches on label substring (case-insensitive)", () => {
		expect(ids(filterSettings("PROVIDER", SETTINGS_NAV, true))).toContain("models");
	});

	test("matches on legacy anchor", () => {
		// "teams" is an anchor of the admin item, not a label.
		expect(ids(filterSettings("teams", SETTINGS_NAV, true))).toContain("admin");
	});

	test("matches on bare anchor (developer page api-keys)", () => {
		expect(ids(filterSettings("api-keys", SETTINGS_NAV, true))).toContain("developer");
	});

	test("matches on item id", () => {
		expect(ids(filterSettings("personalization", SETTINGS_NAV, true))).toContain("personalization");
	});

	test("no match returns an empty array", () => {
		expect(filterSettings("zzz-nonexistent", SETTINGS_NAV, true)).toEqual([]);
	});
});

describe("filterSettings — ranking", () => {
	const registry: SettingsNavItem[] = [
		{ id: "anchor-hit", label: "Zeta", href: "/z", adminOnly: false, anchors: ["models"] },
		{ id: "substr", label: "Custom Models", href: "/c", adminOnly: false, anchors: [] },
		{ id: "prefix", label: "Models & Providers", href: "/m", adminOnly: false, anchors: [] },
	];

	test("label-prefix outranks label-substring outranks anchor match", () => {
		expect(ids(filterSettings("models", registry, true))).toEqual(["prefix", "substr", "anchor-hit"]);
	});

	test("ties keep registry order (stable sort)", () => {
		const tie: SettingsNavItem[] = [
			{ id: "b", label: "Models Beta", href: "/b", adminOnly: false, anchors: [] },
			{ id: "a", label: "Models Alpha", href: "/a", adminOnly: false, anchors: [] },
		];
		// Both are label-prefix matches → registry order preserved.
		expect(ids(filterSettings("models", tie, true))).toEqual(["b", "a"]);
	});
});
