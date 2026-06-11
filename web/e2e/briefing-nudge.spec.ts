/**
 * Daily Briefing Phase 2 e2e — the one-time discoverability nudge card
 * (spec §7.1): "Set up your morning briefing" in the sidebar, linking
 * to /settings/briefing; hidden once dismissed (localStorage) or when
 * the briefing is already enabled. Fail-closed: without a confirmed
 * `enabled === false` config (e.g. the mockApi catch-all `{}`), the
 * card never renders — which also keeps it out of every other spec.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const DISMISS_KEY = "ezcorp-briefing-nudge-dismissed";

const proj = makeProject({ id: "proj-a", name: "Alpha" });

function configRoute(enabled: boolean) {
	return {
		userId: "user-1",
		enabled,
		cron: "0 7 * * *",
		timezone: "UTC",
		projectId: null,
		instructions: "",
		watchlist: [],
		model: null,
		provider: null,
		lastFireAt: null,
		lastFireStatus: null,
		consecutiveErrors: 0,
		nextFireAt: null,
	};
}

test.describe("Daily Briefing — sidebar nudge card", () => {
	test("shows when briefing is disabled, links to settings, and dismissal persists across reloads", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/briefing/config", (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			return route.fulfill({ json: configRoute(false) });
		});

		await page.goto("/settings");
		await expect(page.getByTestId("briefing-nudge")).toBeVisible();

		// The link lands on the briefing editor.
		await page.getByTestId("briefing-nudge-link").click();
		await expect(page).toHaveURL(/\/settings\/briefing$/);
		// (Still visible here — not yet dismissed, still disabled.)
		await expect(page.getByTestId("briefing-nudge")).toBeVisible();

		// Dismiss → gone now…
		await page.getByTestId("briefing-nudge-dismiss").click();
		await expect(page.getByTestId("briefing-nudge")).toHaveCount(0);

		// …and still gone after a reload (localStorage persistence).
		await page.reload();
		await expect(page.getByTestId("briefing-nudge")).toHaveCount(0);
		expect(await page.evaluate((k) => localStorage.getItem(k), DISMISS_KEY)).toBe("1");
	});

	test("hidden when the briefing is already enabled", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/briefing/config", (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			return route.fulfill({ json: configRoute(true) });
		});

		await page.goto("/settings");
		// Sidebar is rendered; the nudge specifically is not.
		await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
		await page.waitForTimeout(300);
		await expect(page.getByTestId("briefing-nudge")).toHaveCount(0);
	});

	test("fail-closed: without a real config payload (catch-all {}) the card never shows", async ({
		page,
		mockApi,
	}) => {
		// No /api/briefing/config route — mockApi's catch-all answers `{}`.
		await mockApi({ projects: [proj] });

		await page.goto("/settings");
		await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
		await page.waitForTimeout(300);
		await expect(page.getByTestId("briefing-nudge")).toHaveCount(0);
	});
});
