/**
 * Phase 52.4 — global admin audit page e2e.
 *
 * Server-side `requireRole` gating is covered by the unit suite
 * `web/src/__tests__/api-audit.server.test.ts` (non-admin → 403). The
 * preview server here runs with PI_SKIP_INIT=1 which short-circuits
 * the auth middleware (hooks.server.ts:367-372), so the e2e harness
 * doesn't simulate a real user role — it verifies route accessibility
 * and the visual surface only.
 *
 * Coverage:
 *   - unauthenticated request to `/audit` is rejected (4xx).
 *   - structural happy-path: stats strip + filter strip + timeline
 *     render when the SSR data path is fulfilled, with no fixture-
 *     shaped credentials leaking into the rendered DOM.
 */
import { test, expect } from "./fixtures/test-base.js";

test.describe("Global /audit", () => {
	test("unauthenticated request → 4xx", async ({ page, mockApi }) => {
		await mockApi({
			projects: [],
			extensions: [],
		});

		const res = await page.goto("/audit");
		expect(res?.status()).toBeGreaterThanOrEqual(400);
	});

	test("happy path: stats strip + filter strip + timeline render without leaked credentials", async ({ page, mockApi }) => {
		await mockApi({
			projects: [],
			extensions: [],
		});
		// Fulfill the stats endpoint so the client-side refresh has
		// numbers to render.
		await page.route("**/api/audit/stats**", async (route) => {
			await route.fulfill({
				json: {
					windowMs: 86400000,
					denialCount: 2,
					totalCalls: 100,
					totalCostUsd: 1.234,
					topChattiest: [
						{ extensionId: "ext-a", name: "lessons-keeper", calls: 60 },
						{ extensionId: "ext-b", name: "memory-extractor", calls: 30 },
					],
					topLlmSpenders: [
						{ extensionId: "ext-a", name: "lessons-keeper", costUsd: 1.0 },
					],
				},
			});
		});
		await page.route("**/api/audit?**", async (route) => {
			await route.fulfill({ json: { entries: [], nextCursor: null } });
		});

		await page.goto("/audit");
		await expect(page.getByTestId("global-audit-stats")).toBeVisible();
		await expect(page.getByTestId("stats-total-calls")).toContainText("100");
		await expect(page.getByTestId("stats-denials")).toContainText("2");
		await expect(page.getByTestId("global-audit-filters")).toBeVisible();
		await expect(page.getByTestId("global-audit-timeline")).toBeVisible();

		// Sweep the visible page text for fixture-shaped credentials —
		// any "sk-…" prefix or "{ANTHROPIC|OPENAI}_API_KEY=…" tokens
		// should be absent. Mirrors the per-extension audit drill-down
		// sweep at `extensions-audit-drilldown.spec.ts:171-174`.
		const bodyText = await page.evaluate(() => document.body.innerText);
		expect(bodyText).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
		expect(bodyText).not.toMatch(/ANTHROPIC_API_KEY=[A-Za-z0-9_-]+/);
		expect(bodyText).not.toMatch(/OPENAI_API_KEY=[A-Za-z0-9_-]+/);
	});
});
