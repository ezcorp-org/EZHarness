import { test, expect, captureEvidence } from "./fixtures/test-base.js";

/**
 * Global per-user savings dashboard (`/analytics/savings`).
 *
 * The SSR loader deliberately degrades to a data-less shell in this
 * DB-less preview harness (no `locals.user` under PI_SKIP_INIT), so the
 * page hydrates through its client-side fetch — which we mock here, per
 * range, to drive:
 *   - the honest-NEGATIVE net cache savings rendering (explicit − sign,
 *     danger accent on the stat card AND the per-model bar) — the whole
 *     point of the feature;
 *   - est. badges on $ figures + the subscription-provider note;
 *   - hand-rolled per-model CSS bars with |value| scaling;
 *   - the range selector refetching (second mocked call asserted);
 *   - the sidebar nav link;
 *   - the empty state ("No usage in range.").
 */

const MINUS = "−";

const NEGATIVE_30D = {
	rangeDays: 30,
	stats: {
		cacheSavedUsd: -0.042,
		cacheReadSavedUsd: 0.018,
		cacheWriteSurchargeUsd: 0.06,
		write1hPremiumUsd: 0.031,
		routingSavedUsd: 0.155,
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
			routingSavedUsd: 0,
			tokensCachedRead: 60_200,
			cacheHitRate: 0.38,
			estimated: true,
		},
		{
			provider: "openai",
			model: "gpt-4o",
			turns: 7,
			cacheSavedUsd: 0.025,
			routingSavedUsd: 0.155,
			tokensCachedRead: 24_000,
			cacheHitRate: 0.52,
			estimated: false,
		},
	],
	subscriptionProviders: ["anthropic"],
	estimated: true,
};

const POSITIVE_90D = {
	...NEGATIVE_30D,
	rangeDays: 90,
	stats: { ...NEGATIVE_30D.stats, cacheSavedUsd: 1.234 },
	subscriptionProviders: [],
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

test("global savings: negative cache savings render honestly; range refetches @evidence", async ({ page, mockApi }, testInfo) => {
	await mockApi({});
	const calls: string[] = [];
	await page.route("**/api/analytics/savings**", (route) => {
		const url = new URL(route.request().url());
		const days = url.searchParams.get("days");
		calls.push(`${url.pathname}?days=${days}`);
		return route.fulfill({ json: days === "90" ? POSITIVE_90D : NEGATIVE_30D });
	});

	await page.goto("/analytics/savings");

	await expect(page.getByTestId("savings-stat-grid")).toBeVisible();

	// NEGATIVE net cache savings: explicit − sign + danger styling — never
	// clamped into looking like a saving.
	const cacheValue = page.getByTestId("savings-stat-cache-value");
	await expect(cacheValue).toContainText(`${MINUS}$0.042`);
	await expect(cacheValue).toHaveAttribute("data-negative", "true");
	await expect(cacheValue).toHaveClass(/neg/);

	// Remaining stat cards.
	const routingValue = page.getByTestId("savings-stat-routing-value");
	await expect(routingValue).toContainText("$0.155");
	await expect(routingValue).toHaveAttribute("data-negative", "false");
	await expect(page.getByTestId("savings-stat-tokens-value")).toContainText("84.2k");
	await expect(page.getByTestId("savings-stat-hitrate-value")).toContainText("41.0%");
	await expect(page.getByTestId("savings-stat-premium-value")).toContainText("$0.031");

	// est. badges on the $ cards.
	await expect(cacheValue.locator(".est-badge")).toBeVisible();
	await expect(page.getByTestId("savings-stat-premium-value").locator(".est-badge")).toBeVisible();

	// Subscription note for the subscription-keyed provider.
	await expect(page.getByTestId("savings-subscription-note")).toContainText(
		"anthropic: subscription key — token savings shown; $ not billed",
	);

	// Per-model hand-rolled bars: the loss row fills 100% (|−$0.05| is the
	// scale max) in the danger accent; the gain row fills 50%, neutral.
	const cacheRows = page.getByTestId("savings-model-row-cache");
	await expect(cacheRows).toHaveCount(2);
	const lossFill = cacheRows.nth(0).locator(".h-bar-fill");
	await expect(lossFill).toHaveClass(/neg/);
	await expect(lossFill).toHaveAttribute("style", /width: 100%/);
	await expect(cacheRows.nth(0).locator(".h-bar-value")).toContainText(`${MINUS}$0.050`);
	await expect(cacheRows.nth(0).locator(".h-bar-value")).toHaveAttribute("data-negative", "true");
	const gainFill = cacheRows.nth(1).locator(".h-bar-fill");
	await expect(gainFill).not.toHaveClass(/neg/);
	await expect(gainFill).toHaveAttribute("style", /width: 50%/);
	await expect(page.getByTestId("savings-model-row-routing")).toHaveCount(2);

	// Sidebar nav link (house pattern: (app) layout navLinks, Manage group).
	// Below `lg` (<1024px) the desktop sidebar is hidden and the links live
	// in the hamburger-opened SwipeDrawer — assert whichever surface renders.
	const isMobileNav = (page.viewportSize()?.width ?? 0) < 1024;
	if (isMobileNav) await page.getByTestId("mobile-menu-toggle").click();
	const navScope = isMobileNav ? page.getByTestId("swipe-drawer") : page.getByTestId("desktop-sidebar");
	const navLink = navScope.getByRole("link", { name: "Savings" });
	await expect(navLink).toHaveAttribute("href", "/analytics/savings");
	await expect(navLink).toHaveAttribute("aria-current", "page");
	if (isMobileNav) {
		// Click the VISIBLE backdrop strip right of the 296px panel (Pixel 5 is
		// 393px wide) — the element's center is under the fully-open panel, so a
		// bare click() only wins by racing the 300ms slide-in and times out
		// under CPU load (sidebar-mobile.spec.ts precedent).
		await page.getByTestId("swipe-drawer-backdrop").click({ position: { x: 350, y: 100 } });
		await expect(page.getByTestId("swipe-drawer-panel")).not.toBeVisible();
	}

	await captureEvidence(page, testInfo, "savings-global-negative");

	// Range change → second mocked call with the new days param.
	await page.getByTestId("savings-range-90").click();
	await expect(cacheValue).toContainText("$1.234");
	await expect(cacheValue).toHaveAttribute("data-negative", "false");
	await expect(page.getByTestId("savings-subscription-note")).toHaveCount(0);
	expect(calls).toEqual([
		"/api/analytics/savings?days=30",
		"/api/analytics/savings?days=90",
	]);

	await captureEvidence(page, testInfo, "savings-global-90d");
});

test("global savings: empty range shows the empty state", async ({ page, mockApi }) => {
	await mockApi({});
	await page.route("**/api/analytics/savings**", (route) =>
		route.fulfill({ json: EMPTY_30D }),
	);

	await page.goto("/analytics/savings");

	await expect(page.getByTestId("savings-empty")).toContainText("No usage in range.");
	await expect(page.getByTestId("savings-stat-grid")).toHaveCount(0);
	// The range selector stays available so an empty week can widen out.
	await expect(page.getByTestId("savings-range-365")).toBeVisible();
});
