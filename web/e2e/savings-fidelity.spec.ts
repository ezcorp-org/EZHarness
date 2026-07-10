import type { Locator, Page } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import {
	AWKWARD_30D,
	DISTINCT_365D,
	EMPTY_MODELS_7D,
	NULL_HITRATE_30D,
	SIGN_BOUNDARY_30D,
} from "./fixtures/savings-fidelity-data";

/**
 * Rendered-UI fidelity audit for the savings dashboards.
 *
 * The whole feature exists to show HONEST savings — including negative
 * ones — so every assertion here is an EXACT string (never a substring
 * that a lossy rendering could still satisfy): every stat field carries a
 * distinct, awkward value; a number landing in the wrong card, dropping
 * its sign, or gaining/losing precision fails.
 *
 * Fixtures live in `fixtures/savings-fidelity-data.ts` and are pinned to
 * the REAL backend `SavingsReport` contract by
 * `web/src/__tests__/savings-format.unit.test.ts` (mock-drift gate), so
 * these specs cannot silently validate fiction.
 */

const MINUS = "−";

/** Exact text of a stat-card value, with the trailing "est." badge (a child
 *  span of the value node) stripped so precision assertions stay exact. */
async function statValue(page: Page, key: string): Promise<string> {
	const raw = await page.getByTestId(`savings-stat-${key}-value`).textContent();
	return (raw ?? "").replace(/est\.$/, "").trim();
}

/** Numeric width (%) of a bar row's fill, parsed from its inline style. */
async function fillWidthPct(row: Locator): Promise<number> {
	const style = await row.locator(".h-bar-fill").getAttribute("style");
	const m = /width:\s*([\d.]+)%/.exec(style ?? "");
	return m ? Number(m[1]) : Number.NaN;
}

test("savings fidelity: every awkward stat renders exactly, in its own card, with honest units and bars @evidence", async ({ page, mockApi }, testInfo) => {
	await mockApi({});
	await page.route("**/api/analytics/savings**", (route) =>
		route.fulfill({ json: AWKWARD_30D }),
	);

	await page.goto("/analytics/savings");
	await expect(page.getByTestId("savings-stat-grid")).toBeVisible();

	// ---- Field-by-field EXACT card values (distinct values ⇒ any value in
	// the wrong card fails one of these). ----
	expect(await statValue(page, "cache")).toBe("<$0.01"); // 0.0004 — collapsed, unsigned
	expect(await statValue(page, "routing")).toBe(`${MINUS}<$0.01`); // −0.0004 — keeps its sign
	expect(await statValue(page, "tokens")).toBe("9.88M"); // 9,876,543
	expect(await statValue(page, "hitrate")).toBe("98.8%"); // 0.98765 — one-decimal rounding
	expect(await statValue(page, "premium")).toBe("$1,234.568"); // 1234.5678 — comma-grouped

	// Card labels pin the semantic meaning next to each value.
	for (const [key, label] of [
		["cache", "Cache saved"],
		["routing", "Routing saved (est.)"],
		["tokens", "Tokens cached"],
		["hitrate", "Hit rate"],
		["premium", "1h-write premium paid"],
	] as const) {
		await expect(page.getByTestId(`savings-stat-${key}`).locator(".stat-label")).toHaveText(
			label,
		);
	}

	// Sub-lines: exact, each fed by its own distinct field.
	await expect(page.getByTestId("savings-stat-cache").locator(".stat-sub")).toHaveText(
		"reads $5.432 · write surcharge $2.100",
	);
	await expect(page.getByTestId("savings-stat-routing").locator(".stat-sub")).toHaveText(
		"3/7 turns routed · 2 failover",
	);
	await expect(page.getByTestId("savings-stat-tokens").locator(".stat-sub")).toHaveText(
		"written 1.2k",
	);

	// Sign styling: the negative routing figure is marked + accented; the
	// positive sub-cent cache figure is NOT.
	await expect(page.getByTestId("savings-stat-routing-value")).toHaveAttribute(
		"data-negative",
		"true",
	);
	await expect(page.getByTestId("savings-stat-routing-value")).toHaveClass(/neg/);
	await expect(page.getByTestId("savings-stat-cache-value")).toHaveAttribute(
		"data-negative",
		"false",
	);

	// Units honesty: token/hit-rate cards never show $; est. badges sit on
	// exactly the three $ cards (token counts and hit rate are exact).
	expect(await page.getByTestId("savings-stat-tokens").textContent()).not.toContain("$");
	expect(await page.getByTestId("savings-stat-hitrate").textContent()).not.toContain("$");
	await expect(page.locator(".stat-grid .est-badge")).toHaveCount(3);
	await expect(page.getByTestId("savings-stat-tokens").locator(".est-badge")).toHaveCount(0);
	await expect(page.getByTestId("savings-stat-hitrate").locator(".est-badge")).toHaveCount(0);

	// Subscription note for the subscription-keyed provider.
	await expect(page.getByTestId("savings-subscription-note")).toHaveText(
		"openai-codex: subscription key — token savings shown; $ not billed",
	);

	// ---- Per-model bars: widths proportional to |value|, per-panel max
	// scaling, negative styling by sign, never overflowing 100%. ----
	const cacheRows = page.getByTestId("savings-model-row-cache");
	await expect(cacheRows).toHaveCount(2);
	// Cache panel: 0.5 (max ⇒ 100%, neutral) vs −0.05 (10:1 ⇒ ~10%, danger).
	const cacheW0 = await fillWidthPct(cacheRows.nth(0));
	const cacheW1 = await fillWidthPct(cacheRows.nth(1));
	expect(cacheW0).toBe(100);
	expect(Math.abs(cacheW0 / cacheW1 - 10)).toBeLessThan(0.001); // 10:1 ratio
	await expect(cacheRows.nth(0).locator(".h-bar-fill")).not.toHaveClass(/neg/);
	await expect(cacheRows.nth(1).locator(".h-bar-fill")).toHaveClass(/neg/);
	await expect(cacheRows.nth(0).locator(".h-bar-value")).toHaveText("$0.500");
	await expect(cacheRows.nth(1).locator(".h-bar-value")).toHaveText(`${MINUS}$0.050`);
	await expect(cacheRows.nth(1).locator(".h-bar-value")).toHaveAttribute(
		"data-negative",
		"true",
	);

	// Routing panel scales independently: −0.2 is ITS max ⇒ a full-width
	// DANGER bar that does not overflow; 0.1 fills half, neutral.
	const routingRows = page.getByTestId("savings-model-row-routing");
	await expect(routingRows).toHaveCount(2);
	expect(await fillWidthPct(routingRows.nth(0))).toBe(100);
	expect(await fillWidthPct(routingRows.nth(1))).toBe(50);
	await expect(routingRows.nth(0).locator(".h-bar-fill")).toHaveClass(/neg/);
	await expect(routingRows.nth(1).locator(".h-bar-fill")).not.toHaveClass(/neg/);
	await expect(routingRows.nth(0).locator(".h-bar-value")).toHaveText(`${MINUS}$0.200`);
	await expect(routingRows.nth(1).locator(".h-bar-value")).toHaveText("$0.100");
	for (const row of [cacheRows, routingRows]) {
		for (let i = 0; i < 2; i++) {
			expect(await fillWidthPct(row.nth(i))).toBeLessThanOrEqual(100);
		}
	}

	// Per-model est. badge only on the estimated row.
	await expect(cacheRows.nth(0).locator(".est-badge")).toHaveCount(1);
	await expect(cacheRows.nth(1).locator(".est-badge")).toHaveCount(0);

	// Honesty scans across the whole dashboard: no NaN, no ASCII "-$" (the
	// design's minus is the Unicode −), and the estimates disclaimer shows.
	const dashboardText = (await page.getByTestId("savings-dashboard").textContent()) ?? "";
	expect(dashboardText).not.toContain("NaN");
	expect(dashboardText).not.toContain("-$");
	expect(dashboardText).toContain("$ figures are estimates from provider list prices");

	await captureEvidence(page, testInfo, "savings-fidelity-awkward-values");
});

test("savings fidelity: −0.0004 vs +0.0004 vs 0 are visually distinct — losses never masquerade as $0.00 @evidence", async ({ page, mockApi }, testInfo) => {
	await mockApi({});
	await page.route("**/api/analytics/savings**", (route) =>
		route.fulfill({ json: SIGN_BOUNDARY_30D }),
	);

	await page.goto("/analytics/savings");
	await expect(page.getByTestId("savings-stat-grid")).toBeVisible();

	// The boundary triple, exact: loss keeps its − sign even below a cent;
	// gain collapses unsigned; zero is a plain $0.00.
	expect(await statValue(page, "cache")).toBe(`${MINUS}<$0.01`); // −0.0004
	expect(await statValue(page, "routing")).toBe("<$0.01"); // +0.0004
	expect(await statValue(page, "premium")).toBe("$0.00"); // exactly 0

	const cacheValue = page.getByTestId("savings-stat-cache-value");
	const routingValue = page.getByTestId("savings-stat-routing-value");
	const premiumValue = page.getByTestId("savings-stat-premium-value");
	await expect(cacheValue).toHaveAttribute("data-negative", "true");
	await expect(cacheValue).toHaveClass(/neg/);
	await expect(routingValue).toHaveAttribute("data-negative", "false");
	await expect(routingValue).not.toHaveClass(/neg/);
	await expect(premiumValue).toHaveAttribute("data-negative", "false");
	await expect(premiumValue).not.toHaveClass(/neg/);

	// Distinct beyond markup: the danger accent must RESOLVE to a different
	// computed color than the neutral value (class alone could be unstyled).
	const lossColor = await cacheValue.evaluate((el) => getComputedStyle(el).color);
	const gainColor = await routingValue.evaluate((el) => getComputedStyle(el).color);
	expect(lossColor).not.toBe(gainColor);

	// Sub-line negatives keep their sign too (reads −0.002, surcharge 0.0016).
	await expect(page.getByTestId("savings-stat-cache").locator(".stat-sub")).toHaveText(
		`reads ${MINUS}<$0.01 · write surcharge <$0.01`,
	);

	// A measured-zero hit rate renders 0.0% (distinct from null's em-dash).
	expect(await statValue(page, "hitrate")).toBe("0.0%");

	// The per-model sub-cent loss bar: full-width (its own scale max),
	// danger accent, signed value.
	const cacheRows = page.getByTestId("savings-model-row-cache");
	await expect(cacheRows).toHaveCount(1);
	expect(await fillWidthPct(cacheRows.nth(0))).toBe(100);
	await expect(cacheRows.nth(0).locator(".h-bar-fill")).toHaveClass(/neg/);
	await expect(cacheRows.nth(0).locator(".h-bar-value")).toHaveText(`${MINUS}<$0.01`);
	const routingRows = page.getByTestId("savings-model-row-routing");
	await expect(routingRows.nth(0).locator(".h-bar-fill")).not.toHaveClass(/neg/);
	await expect(routingRows.nth(0).locator(".h-bar-value")).toHaveText("<$0.01");

	// No dishonest renderings anywhere: no signed zero, no ASCII "-$".
	const dashboardText = (await page.getByTestId("savings-dashboard").textContent()) ?? "";
	expect(dashboardText).not.toContain(`${MINUS}$0.00`);
	expect(dashboardText).not.toContain("-$");
	expect(dashboardText).not.toContain("NaN");

	await captureEvidence(page, testInfo, "savings-fidelity-sign-boundary");
});

test("savings fidelity: null hit rate renders an em-dash (never 0% or NaN); empty perModel renders no phantom bars @evidence", async ({ page, mockApi }, testInfo) => {
	await mockApi({});
	await page.route("**/api/analytics/savings**", (route) => {
		const days = new URL(route.request().url()).searchParams.get("days");
		return route.fulfill({ json: days === "7" ? EMPTY_MODELS_7D : NULL_HITRATE_30D });
	});

	await page.goto("/analytics/savings");
	await expect(page.getByTestId("savings-stat-grid")).toBeVisible();

	// null cacheHitRate → em-dash, EXACT: not "0%", not "0.0%", not "NaN".
	expect(await statValue(page, "hitrate")).toBe("—");

	// Usage exists (turnsTotal 5) so this is the grid, NOT the empty state.
	await expect(page.getByTestId("savings-empty")).toHaveCount(0);
	await expect(page.getByTestId("savings-stat-routing").locator(".stat-sub")).toHaveText(
		"0/5 turns routed · 0 failover",
	);

	// Per-model null hit rate reaches the row tooltip as an em-dash too.
	const row = page.getByTestId("savings-model-row-cache").nth(0);
	expect(await row.locator(".h-bar-label").getAttribute("title")).toContain("hit —");

	// Multi-provider subscription note: one line per provider.
	const note = page.getByTestId("savings-subscription-note");
	await expect(note.locator("span")).toHaveCount(2);
	await expect(note).toContainText(
		"anthropic: subscription key — token savings shown; $ not billed",
	);
	await expect(note).toContainText(
		"openai: subscription key — token savings shown; $ not billed",
	);

	await captureEvidence(page, testInfo, "savings-fidelity-null-hitrate");

	// Empty perModel WITH usage (7d payload): grid + panels render, zero rows.
	await page.getByTestId("savings-range-7").click();
	await expect(page.getByTestId("savings-stat-hitrate-value")).toHaveText("25.0%");
	await expect(page.getByTestId("savings-models-cache")).toBeVisible();
	await expect(page.getByTestId("savings-model-row-cache")).toHaveCount(0);
	await expect(page.getByTestId("savings-model-row-routing")).toHaveCount(0);
	await expect(page.getByTestId("savings-empty")).toHaveCount(0);
});

test("savings fidelity: a range change swaps EVERY figure to the new response — no stale mixing, honest days param", async ({ page, mockApi }) => {
	await mockApi({});
	const calls: string[] = [];
	await page.route("**/api/analytics/savings**", (route) => {
		const url = new URL(route.request().url());
		calls.push(`${url.pathname}?days=${url.searchParams.get("days")}`);
		return route.fulfill({
			json: url.searchParams.get("days") === "365" ? DISTINCT_365D : AWKWARD_30D,
		});
	});

	await page.goto("/analytics/savings");
	await expect(page.getByTestId("savings-stat-grid")).toBeVisible();
	expect(await statValue(page, "cache")).toBe("<$0.01");

	await page.getByTestId("savings-range-365").click();

	// Every card + sub-line now shows the 365d payload — values, signs, row
	// count, model identity and note presence ALL differ from the 30d one,
	// so any stale leftover fails an exact assertion below.
	await expect(page.getByTestId("savings-stat-cache-value")).toContainText(`${MINUS}$3.210`);
	expect(await statValue(page, "cache")).toBe(`${MINUS}$3.210`);
	expect(await statValue(page, "routing")).toBe("$4.440");
	expect(await statValue(page, "tokens")).toBe("555");
	expect(await statValue(page, "hitrate")).toBe("5.0%");
	expect(await statValue(page, "premium")).toBe("$0.333");
	await expect(page.getByTestId("savings-stat-cache-value")).toHaveAttribute(
		"data-negative",
		"true",
	);
	await expect(page.getByTestId("savings-stat-cache").locator(".stat-sub")).toHaveText(
		"reads $0.111 · write surcharge $0.222",
	);
	await expect(page.getByTestId("savings-stat-routing").locator(".stat-sub")).toHaveText(
		"88/99 turns routed · 77 failover",
	);
	await expect(page.getByTestId("savings-stat-tokens").locator(".stat-sub")).toHaveText(
		"written 6.66M",
	);
	const cacheRows = page.getByTestId("savings-model-row-cache");
	await expect(cacheRows).toHaveCount(1); // 2 rows → 1 row: stale rows would linger
	await expect(cacheRows.nth(0).locator(".h-bar-label")).toContainText("gemini-pro");
	await expect(page.getByTestId("savings-subscription-note")).toHaveCount(0);

	// Active-range state tracks the selection; the days params sent match
	// the buttons exactly, in order.
	await expect(page.getByTestId("savings-range-365")).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("savings-range-30")).toHaveAttribute("aria-pressed", "false");
	expect(calls).toEqual(["/api/analytics/savings?days=30", "/api/analytics/savings?days=365"]);
});
