import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

/**
 * Project-scoped savings dashboard (`/project/[id]/savings`).
 *
 * Same rendering contract as the global page (shared
 * `SavingsDashboard.svelte`) against the project endpoint
 * `/api/analytics/savings/project/[id]?days=N` — ownership 404s are the
 * loader's concern (vitest-covered, `savings-page-loaders.server.test.ts`);
 * here we drive the visual surface: honest-negative rendering, per-model
 * bars, subscription note, range-selector refetch against the PROJECT
 * endpoint, the project sidebar link, and the empty state.
 */

const MINUS = "−";

const NEGATIVE_30D = {
	rangeDays: 30,
	stats: {
		cacheSavedUsd: -0.042,
		cacheReadSavedUsd: 0.018,
		cacheWriteSurchargeUsd: 0.06,
		write1hPremiumUsd: 0.031,
		routingSavedUsd: -0.02,
		tokensCachedRead: 84_200,
		tokensCacheWritten: 121_000,
		cacheHitRate: 0.41,
		turnsTotal: 18,
		turnsRouted: 7,
		turnsFailover: 1,
	},
	perModel: [
		{
			provider: "anthropic",
			model: "claude-opus-4",
			turns: 11,
			cacheSavedUsd: -0.05,
			routingSavedUsd: -0.02,
			tokensCachedRead: 60_200,
			cacheHitRate: 0.38,
			estimated: true,
		},
		{
			provider: "openai",
			model: "gpt-4o",
			turns: 7,
			cacheSavedUsd: 0.025,
			routingSavedUsd: 0.01,
			tokensCachedRead: 24_000,
			cacheHitRate: 0.52,
			estimated: false,
		},
	],
	subscriptionProviders: ["anthropic"],
	estimated: true,
};

const POSITIVE_7D = {
	...NEGATIVE_30D,
	rangeDays: 7,
	stats: { ...NEGATIVE_30D.stats, cacheSavedUsd: 0.5, routingSavedUsd: 0.08 },
};

const EMPTY_30D = {
	rangeDays: 30,
	stats: {
		cacheSavedUsd: 0,
		cacheReadSavedUsd: 0,
		cacheWriteSurchargeUsd: 0,
		write1hPremiumUsd: 0,
		routingSavedUsd: 0,
		tokensCachedRead: 0,
		tokensCacheWritten: 0,
		cacheHitRate: null,
		turnsTotal: 0,
		turnsRouted: 0,
		turnsFailover: 0,
	},
	perModel: [],
	subscriptionProviders: [],
	estimated: true,
};

test("project savings: negative cache AND routing savings render honestly; range refetches the project endpoint @evidence", async ({ page, mockApi }, testInfo) => {
	await mockApi({ projects: [makeProject({ id: "p1", name: "My Project" })] });
	const calls: string[] = [];
	await page.route("**/api/analytics/savings/project/p1**", (route) => {
		const url = new URL(route.request().url());
		const days = url.searchParams.get("days");
		calls.push(`${url.pathname}?days=${days}`);
		return route.fulfill({ json: days === "7" ? POSITIVE_7D : NEGATIVE_30D });
	});

	await page.goto("/project/p1/savings");

	await expect(page.getByTestId("savings-stat-grid")).toBeVisible();
	await expect(page.getByRole("heading", { name: "Project savings" })).toBeVisible();

	// Both net figures are negative here — each renders an explicit − sign
	// in the danger accent.
	const cacheValue = page.getByTestId("savings-stat-cache-value");
	await expect(cacheValue).toContainText(`${MINUS}$0.042`);
	await expect(cacheValue).toHaveAttribute("data-negative", "true");
	await expect(cacheValue).toHaveClass(/neg/);
	const routingValue = page.getByTestId("savings-stat-routing-value");
	await expect(routingValue).toContainText(`${MINUS}$0.020`);
	await expect(routingValue).toHaveAttribute("data-negative", "true");
	await expect(routingValue).toHaveClass(/neg/);

	await expect(page.getByTestId("savings-stat-tokens-value")).toContainText("84.2k");
	await expect(page.getByTestId("savings-stat-hitrate-value")).toContainText("41.0%");
	await expect(page.getByTestId("savings-stat-premium-value")).toContainText("$0.031");

	// Subscription note.
	await expect(page.getByTestId("savings-subscription-note")).toContainText(
		"anthropic: subscription key — token savings shown; $ not billed",
	);

	// Per-model bars: loss row at full |value| scale in the danger accent;
	// the routing panel's loss row is negative-styled too.
	const cacheRows = page.getByTestId("savings-model-row-cache");
	await expect(cacheRows).toHaveCount(2);
	const lossFill = cacheRows.nth(0).locator(".h-bar-fill");
	await expect(lossFill).toHaveClass(/neg/);
	await expect(lossFill).toHaveAttribute("style", /width: 100%/);
	await expect(cacheRows.nth(1).locator(".h-bar-fill")).toHaveAttribute("style", /width: 50%/);
	const routingRows = page.getByTestId("savings-model-row-routing");
	await expect(routingRows).toHaveCount(2);
	await expect(routingRows.nth(0).locator(".h-bar-value")).toContainText(`${MINUS}$0.020`);
	await expect(routingRows.nth(0).locator(".h-bar-fill")).toHaveClass(/neg/);

	// Project sidebar link (house pattern: project branch of the (app)
	// layout navLinks, alongside Project Settings). Below `lg` the desktop
	// sidebar is hidden — the links live in the hamburger SwipeDrawer.
	const isMobileNav = (page.viewportSize()?.width ?? 0) < 1024;
	if (isMobileNav) await page.getByTestId("mobile-menu-toggle").click();
	const navScope = isMobileNav ? page.getByTestId("swipe-drawer") : page.getByTestId("desktop-sidebar");
	const navLink = navScope.getByRole("link", { name: "Savings" });
	await expect(navLink).toHaveAttribute("href", "/project/p1/savings");
	await expect(navLink).toHaveAttribute("aria-current", "page");
	if (isMobileNav) {
		await page.getByTestId("swipe-drawer-backdrop").click();
		await expect(page.getByTestId("swipe-drawer-panel")).not.toBeVisible();
	}

	await captureEvidence(page, testInfo, "savings-project-negative");

	// Range change → second mocked call against the PROJECT endpoint.
	await page.getByTestId("savings-range-7").click();
	await expect(cacheValue).toContainText("$0.500");
	await expect(cacheValue).toHaveAttribute("data-negative", "false");
	expect(calls).toEqual([
		"/api/analytics/savings/project/p1?days=30",
		"/api/analytics/savings/project/p1?days=7",
	]);

	await captureEvidence(page, testInfo, "savings-project-7d");
});

test("project savings: empty range shows the empty state", async ({ page, mockApi }) => {
	await mockApi({ projects: [makeProject({ id: "p1" })] });
	await page.route("**/api/analytics/savings/project/p1**", (route) =>
		route.fulfill({ json: EMPTY_30D }),
	);

	await page.goto("/project/p1/savings");

	await expect(page.getByTestId("savings-empty")).toContainText("No usage in range.");
	await expect(page.getByTestId("savings-stat-grid")).toHaveCount(0);
	await expect(page.getByTestId("savings-range-365")).toBeVisible();
});
