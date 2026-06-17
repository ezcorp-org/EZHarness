/**
 * Extension Capabilities (Phase 3 §5.2) — end-to-end flow.
 *
 * An admin on an extension that HOLDS the search capability:
 *   - the Capabilities panel renders with the current mode (Inherit)
 *   - flipping to Custom reveals prefilled fields; saving a quota writes a
 *     FIELD-LEVEL partial grant via PUT /api/extensions/[id]/permissions
 *   - flipping to Disabled writes `search: false`
 *   - the GET reflects the new grant + effective policy on reload
 *
 * Stateful mock: the settings GET returns the capabilities payload derived
 * from the current grant; the permissions PUT mutates that grant so the
 * round-trip is observable.
 */
import { test, expect } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { makeProject } from "./fixtures/data.js";

const ADMIN_ME = {
	user: { id: "admin-1", email: "admin@test.local", name: "Admin", role: "admin" },
};

const INSTANCE_DEFAULTS = { quota: 100, maxResults: 5, providers: "all" as const };

function searchSchema() {
	return [
		{
			key: "providers",
			field: {
				type: "select",
				label: "Allowed providers",
				options: [
					{ value: "inherit", label: "Inherit (instance default)" },
					{ value: "searxng", label: "searxng" },
					{ value: "brave", label: "brave" },
				],
				default: "inherit",
			},
		},
		{ key: "quota", field: { type: "number", label: "Daily quota", default: 100, min: 1 } },
		{ key: "maxResults", field: { type: "number", label: "Max results", default: 5, min: 1 } },
	];
}

/** Resolve the effective policy from a grant (mirrors mergeSearchPolicy). */
function effectiveFor(grant: unknown): Record<string, unknown> {
	if (grant === false) return { denied: true };
	if (grant === "inherit" || grant === undefined) return { denied: false, ...INSTANCE_DEFAULTS };
	const o = grant as { quota?: number; maxResults?: number; providers?: string[] | "inherit" };
	return {
		denied: false,
		quota: o.quota ?? INSTANCE_DEFAULTS.quota,
		maxResults: o.maxResults ?? INSTANCE_DEFAULTS.maxResults,
		providers: o.providers && o.providers !== "inherit" ? o.providers : INSTANCE_DEFAULTS.providers,
	};
}

function makeSearchDetail(grant: unknown): Record<string, unknown> {
	return {
		id: "ext-search",
		name: "web-search",
		version: "1.0.0",
		description: "Search-capable extension.",
		enabled: true,
		source: "bundled",
		installPath: "/bundled/web-search",
		checksumVerified: true,
		consecutiveFailures: 0,
		manifest: {
			author: "EZCorp",
			entrypoint: "./index.ts",
			persistent: false,
			tools: [],
			permissions: { search: { quota: 1000 } },
		},
		grantedPermissions: { network: [], filesystem: [], shell: false, env: [], grantedAt: {}, search: grant },
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

/** Stateful settings + permissions mock sharing one grant.
 *  `clampQuotaTo` simulates the server-side clampSearchPermission ceiling
 *  (clampSearchPermission caps `quota` at min(submitted, manifest)) so the
 *  E2E can prove the panel reseeds to the CLAMPED value, not a phantom. */
async function installCapMock(page: Page, initialGrant: unknown, clampQuotaTo?: number) {
	let grant: unknown = initialGrant;
	const puts: Array<{ search: unknown }> = [];

	await page.route("**/api/extensions/ext-search/settings", async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		return route.fulfill({
			json: {
				schema: null,
				declaredDefaults: {},
				userValues: {},
				resolved: {},
				capabilities: [
					{ cap: "search", schema: searchSchema(), effective: effectiveFor(grant), grant },
				],
			},
		});
	});

	await page.route("**/api/extensions/ext-search/permissions", async (route) => {
		if (route.request().method() !== "PUT") return route.fallback();
		const body = route.request().postDataJSON();
		let submitted = body?.permissions?.search;
		// Simulate clampSearchPermission's quota ceiling (min(submitted,
		// manifest)) so the stored grant — and the next GET's effective
		// policy — reflect the CLAMPED value, never the submitted one.
		if (clampQuotaTo !== undefined && submitted && typeof submitted === "object" && typeof submitted.quota === "number") {
			submitted = { ...submitted, quota: Math.min(submitted.quota, clampQuotaTo) };
		}
		grant = submitted;
		puts.push({ search: grant });
		return route.fulfill({ json: { id: "ext-search", grantedPermissions: { search: grant } } });
	});

	// The detail page re-fetches /api/extensions/ext-search after a save;
	// reflect the live grant.
	await page.route("**/api/extensions/ext-search", async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		return route.fulfill({ json: makeSearchDetail(grant) });
	});

	return { puts, grant: () => grant };
}

test.describe("Extension Capabilities — admin flow", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });

	test("admin flips Inherit → Custom(quota 500) → Disabled; grant round-trips", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => ADMIN_ME } });
		const ctrl = await installCapMock(page, "inherit");

		await page.goto("/extensions/ext-search");

		const panel = page.getByTestId("capabilities-panel");
		await expect(panel).toBeVisible({ timeout: 5000 });
		// Starts in Inherit, showing the instance default.
		await expect(page.getByTestId("capability-search-mode-inherit")).toHaveAttribute("aria-checked", "true");
		await expect(page.getByTestId("capability-search-inherit-summary")).toContainText("quota 100");

		// Custom → quota 500.
		await page.getByTestId("capability-search-mode-custom").click();
		await expect(page.getByTestId("capability-search-custom-fields")).toBeVisible();
		await page.getByTestId("capability-search-field-quota").fill("500");
		await page.getByTestId("capability-search-save").click();

		await expect.poll(() => ctrl.grant(), { timeout: 3000 }).toEqual({ quota: 500 });

		// Disabled → false.
		await page.getByTestId("capability-search-mode-disabled").click();
		await expect(page.getByTestId("capability-search-disabled-summary")).toBeVisible();
		await page.getByTestId("capability-search-save").click();

		await expect.poll(() => ctrl.grant(), { timeout: 3000 }).toBe(false);
	});

	test("manifest-ceiling clamp-DOWN is visible: submit 500, panel reseeds to the clamped 100", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => ADMIN_ME } });
		// The (mocked) server clamps quota to 100 — the manifest ceiling.
		const ctrl = await installCapMock(page, "inherit", 100);

		await page.goto("/extensions/ext-search");
		await expect(page.getByTestId("capabilities-panel")).toBeVisible({ timeout: 5000 });

		await page.getByTestId("capability-search-mode-custom").click();
		await page.getByTestId("capability-search-field-quota").fill("500");
		await page.getByTestId("capability-search-save").click();

		// The grant the server actually stored is CLAMPED to 100, not 500.
		await expect.poll(() => ctrl.grant(), { timeout: 3000 }).toEqual({ quota: 100 });

		// And the panel reseeds (post-save GET) to show the clamped effective
		// value — no phantom 500 misleading the admin.
		await page.getByTestId("capability-search-mode-custom").click();
		await expect(page.getByTestId("capability-search-field-quota")).toHaveValue("100");
	});

	test("non-admin sees the panel read-only (no Save, admin-managed hint)", async ({ page, mockApi }) => {
		const memberMe = { user: { id: "m1", email: "m@test.local", name: "M", role: "member" } };
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });
		await installCapMock(page, "inherit");

		await page.goto("/extensions/ext-search");

		await expect(page.getByTestId("capabilities-panel")).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId("capability-search-readonly")).toBeVisible();
		await expect(page.getByTestId("capability-search-save")).toHaveCount(0);
		await expect(page.getByTestId("capability-search-mode-custom")).toBeDisabled();
	});
});
