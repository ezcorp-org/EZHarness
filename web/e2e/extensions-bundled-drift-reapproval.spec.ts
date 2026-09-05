/**
 * The city-conditions release adds Atlanta Allergy's website. This spec pins
 * the supported v4 review entry point: the exact release declaration is
 * visible and the review action opens the author flow. Real-auth release-gate
 * coverage proves the approval submission against the live backend.
 *
 * The `@evidence`-tagged case satisfies the Visual evidence CI gate (this diff
 * adds the drift banner to the extension detail page); the spec is mapped to
 * that page in `web/e2e/evidence-covers.json`. `captureEvidence` is a hard
 * no-op unless `EZCORP_E2E_EVIDENCE=1`.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeExtension } from "./fixtures/data.js";

const OLD_HOSTS = [
	"geocoding-api.open-meteo.com",
	"api.open-meteo.com",
	"air-quality-api.open-meteo.com",
];
const CURRENT_HOSTS = [...OLD_HOSTS, "www.atlantaallergy.com"];

const project = makeProject({ id: "proj-1" });

function cityConditionsDetail(enabled: boolean, hosts: string[]) {
	return makeExtension({
		id: "ext-city-conditions",
		name: "city-conditions",
		enabled,
		isBundled: true,
		version: enabled ? "0.2.0" : "0.1.0",
		description: "Current weather and allergens for a city.",
		manifest: {
			schemaVersion: 2,
			name: "city-conditions",
			version: enabled ? "0.2.0" : "0.1.0",
			description: "Current weather and allergens for a city.",
			author: { name: "EZCorp" },
			entrypoint: "./index.ts",
			tools: [],
			permissions: { network: hosts },
		},
		grantedPermissions: { network: hosts, grantedAt: { network: 1 } },
	});
}

test("bundled city-conditions shows Atlanta website access and opens release review @evidence", async ({
	page,
	mockApi,
}, testInfo) => {
	await mockApi({
		projects: [project],
		extensions: [],
		routes: {
			// `name` is required — the app shell renders a user avatar initial
			// from it (`(app)/+layout.svelte`), so omitting it throws mid-render
			// and the page never gets past its loading state.
			"/api/auth/me": () => ({
				user: { id: "admin-1", name: "Admin", email: "admin@example.com", role: "admin" },
			}),
		},
	});

	await page.route("**/api/extensions/ext-city-conditions", async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({ json: cityConditionsDetail(false, CURRENT_HOSTS) });
	});
	await page.goto("/extensions/ext-city-conditions");
	const preview = page.getByTestId("release-permissions");
	await expect(preview).toBeVisible({ timeout: 5000 });
	await expect(preview).toContainText("Declared permissions");
	await expect(preview).toContainText("www.atlantaallergy.com");
	await expect(page.getByTestId("review-extension-release")).toBeVisible();
	await captureEvidence(page, testInfo, "bundled-release-permissions-v4");
	await page.getByTestId("review-extension-release").click();
	await expect(page).toHaveURL(/\/extensions\/author\?installation=ext-city-conditions$/);
});

/**
 * A bundled extension an admin disabled by hand has no permission drift. The
 * banner is still the page's only re-enable affordance, so it renders — but it
 * must not claim permissions changed when the on-disk grant already matches.
 */
test("a disabled bundled extension with no drift offers re-approval without claiming a change", async ({
	page,
	mockApi,
}) => {
	await mockApi({
		projects: [project],
		extensions: [],
		routes: {
			// `name` is required — the app shell renders a user avatar initial
			// from it (`(app)/+layout.svelte`), so omitting it throws mid-render
			// and the page never gets past its loading state.
			"/api/auth/me": () => ({
				user: { id: "admin-1", name: "Admin", email: "admin@example.com", role: "admin" },
			}),
		},
	});

	await page.route("**/api/extensions/ext-city-conditions", async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({ json: cityConditionsDetail(false, CURRENT_HOSTS) });
	});
	await page.route("**/api/extensions/ext-city-conditions/reapprove-drift", async (route) => {
		await route.fulfill({
			json: { version: "0.2.0", permissions: { network: CURRENT_HOSTS }, diffs: [] },
		});
	});

	await page.goto("/extensions/ext-city-conditions");
	const preview = page.getByTestId("bundled-drift-preview");
	await expect(preview).toBeVisible({ timeout: 5000 });
	await expect(preview).toContainText("Disabled — re-approve to enable");
	await expect(preview).not.toContainText("Updated permissions need approval");
	await expect(page.getByTestId("approve-bundled-drift")).toHaveText("Re-approve and enable");
});
