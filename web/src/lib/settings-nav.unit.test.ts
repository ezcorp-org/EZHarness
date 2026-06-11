/**
 * Unit tests for the settings hub registry + legacy-anchor redirect
 * (tasks/settings-ux-overhaul.md locked decision 2 — every historical
 * `/settings#<anchor>` deep link must map onto its new sub-route).
 */
import { describe, test, expect } from "vitest";
import {
	SETTINGS_NAV,
	SETTINGS_DEFAULT_ROUTE,
	resolveLegacyHash,
	visibleNavItems,
	activeNavId,
} from "./settings-nav";

describe("resolveLegacyHash — full redirect table", () => {
	const modelAnchors = ["providers", "tier", "order", "custom-models"];
	for (const a of modelAnchors) {
		test(`#${a} → /settings/models#${a}`, () => {
			expect(resolveLegacyHash(`#${a}`, false)).toBe(`/settings/models#${a}`);
			expect(resolveLegacyHash(`#${a}`, true)).toBe(`/settings/models#${a}`);
		});
	}

	const personalizationAnchors = ["instructions", "modes", "briefing", "audit-visibility", "advanced"];
	for (const a of personalizationAnchors) {
		test(`#${a} → /settings/personalization#${a}`, () => {
			expect(resolveLegacyHash(`#${a}`, false)).toBe(`/settings/personalization#${a}`);
		});
	}

	for (const a of ["developer", "api-keys"]) {
		test(`#${a} → /settings/developer (no fragment)`, () => {
			expect(resolveLegacyHash(`#${a}`, false)).toBe("/settings/developer");
			expect(resolveLegacyHash(`#${a}`, true)).toBe("/settings/developer");
		});
	}

	const adminAnchors = ["users", "teams", "invites", "security", "health"];
	for (const a of adminAnchors) {
		test(`#${a} → /settings/admin#${a} for admins`, () => {
			expect(resolveLegacyHash(`#${a}`, true)).toBe(`/settings/admin#${a}`);
		});
		test(`#${a} → default route for non-admins`, () => {
			expect(resolveLegacyHash(`#${a}`, false)).toBe(SETTINGS_DEFAULT_ROUTE);
		});
	}

	test("#audit → /settings/admin/audit for admins, default for members", () => {
		expect(resolveLegacyHash("#audit", true)).toBe("/settings/admin/audit");
		expect(resolveLegacyHash("#audit", false)).toBe(SETTINGS_DEFAULT_ROUTE);
	});

	test("unknown hash → default route", () => {
		expect(resolveLegacyHash("#does-not-exist", true)).toBe(SETTINGS_DEFAULT_ROUTE);
		expect(resolveLegacyHash("#does-not-exist", false)).toBe(SETTINGS_DEFAULT_ROUTE);
	});

	test("empty / bare hash → default route", () => {
		expect(resolveLegacyHash("", false)).toBe(SETTINGS_DEFAULT_ROUTE);
		expect(resolveLegacyHash("#", true)).toBe(SETTINGS_DEFAULT_ROUTE);
	});

	test("accepts the anchor without a leading #", () => {
		expect(resolveLegacyHash("providers", false)).toBe("/settings/models#providers");
	});
});

describe("visibleNavItems", () => {
	test("hides admin entries for members", () => {
		const ids = visibleNavItems(false).map((i) => i.id);
		expect(ids).toEqual(["models", "personalization", "briefing", "developer"]);
	});

	test("shows admin entries for admins", () => {
		const ids = visibleNavItems(true).map((i) => i.id);
		expect(ids).toContain("admin");
		expect(ids).toContain("admin-audit");
	});
});

describe("activeNavId", () => {
	test("exact match per route", () => {
		expect(activeNavId("/settings/models")).toBe("models");
		expect(activeNavId("/settings/personalization")).toBe("personalization");
		expect(activeNavId("/settings/developer")).toBe("developer");
		expect(activeNavId("/settings/admin")).toBe("admin");
		expect(activeNavId("/settings/briefing")).toBe("briefing");
	});

	test("nested audit page wins over the admin prefix", () => {
		expect(activeNavId("/settings/admin/audit")).toBe("admin-audit");
	});

	test("non-settings path → null", () => {
		expect(activeNavId("/agents")).toBeNull();
		expect(activeNavId("/settings")).toBeNull();
	});
});

describe("registry invariants", () => {
	test("every anchor is unique across the registry", () => {
		const all = SETTINGS_NAV.flatMap((i) => [...i.anchors, ...(i.bareAnchors ?? [])]);
		expect(new Set(all).size).toBe(all.length);
	});

	test("all hrefs live under /settings/", () => {
		for (const item of SETTINGS_NAV) {
			expect(item.href.startsWith("/settings/")).toBe(true);
		}
	});
});
