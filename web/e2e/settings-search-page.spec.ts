/**
 * Settings → Search admin PAGE (shared-search Phase 2).
 *
 * Distinct from `settings-search.spec.ts` (which covers the settings-nav
 * client-side FILTER). Here:
 *   - the page renders the Backend + Defaults-for-extensions sections
 *   - the defaults are prefilled from the `global:search:*` settings
 *   - editing a default round-trips via PUT /api/settings/<key> and
 *     flashes the inline "Saved ✓" confirmation
 *   - a stored BYOK key shows as "Set" — its value is never rendered
 */
import { test, expect } from "./fixtures/test-base.js";

const adminMe = {
	user: { id: "admin-1", email: "admin@test.local", name: "Admin", role: "admin" },
};

// The instance-default policy layer the admin GET returns.
const searchSettings = {
	"global:search:allowedByDefault": true,
	"global:search:defaultQuota": 100,
	"global:search:defaultMaxResults": 5,
	"global:search:defaultProviders": "all",
};

// Backend status: searxng configured + a stored Tavily key (presence only).
const backendStatus = {
	providers: [
		{ provider: "tavily", hasKey: true },
		{ provider: "brave", hasKey: false },
		{ provider: "exa", hasKey: false },
		{ provider: "serpapi", hasKey: false },
		{ provider: "jina", hasKey: false },
	],
	searxngUrl: "http://searxng:8080",
};

test.describe("settings → search page", () => {
	test("admin sees prefilled defaults + backend status; editing a default round-trips", async ({ page, mockApi }) => {
		await mockApi({
			settings: searchSettings,
			routes: {
				"/api/auth/me": () => adminMe,
				"/api/search/backend": () => backendStatus,
			},
		});
		await page.goto("/settings/search");

		// Both sections render.
		await expect(page.locator("#search-backend")).toBeVisible();
		await expect(page.locator("#search-defaults")).toBeVisible();

		// Backend: the SearXNG URL is prefilled; the stored Tavily key shows
		// as "Set" and an unset provider shows a key input.
		await expect(page.getByTestId("search-searxng-url")).toHaveValue("http://searxng:8080");
		await expect(page.getByTestId("search-byok-tavily-set")).toBeVisible();
		await expect(page.getByTestId("search-byok-brave-input")).toBeVisible();

		// Defaults: prefilled from the settings.
		await expect(page.getByTestId("search-default-quota")).toHaveValue("100");
		await expect(page.getByTestId("search-default-maxresults")).toHaveValue("5");
		await expect(page.getByTestId("search-default-allowed")).toHaveAttribute("aria-checked", "true");

		// Edit the quota → PUT /api/settings/global:search:defaultQuota with the new value.
		const putPromise = page.waitForRequest(
			(req) => req.method() === "PUT" && req.url().includes("/api/settings/global:search:defaultQuota"),
		);
		await page.getByTestId("search-default-quota").fill("250");
		await page.getByTestId("search-default-quota").blur();
		const put = await putPromise;
		expect(put.postDataJSON()).toEqual({ value: 250 });

		// The inline Saved confirmation flashes.
		await expect(page.getByTestId("save-indicator-saved")).toBeVisible();
	});
});
