/**
 * Phase 57 — UX-02 Wave 0 RED scaffold (Playwright e2e).
 *
 * Pins the user-facing must_haves contract:
 *   "≥3-char query returns ranked results by similarity, ≤2-char short-
 *    circuits to alphabetical browse, typo recall surfaces near-matches."
 *
 * Four cases — all `test.fixme` until Wave 2 Track B (Plan 57-04)
 * lands the pg_trgm migration, browseMarketplace rewrite, and the
 * GIN sweep.
 *
 * Run from web/:  `cd web && bunx playwright test e2e/marketplace-trgm-search.spec.ts`
 */

import { test, expect } from "@playwright/test";

test.describe("Marketplace trigram search (UX-02)", () => {
	test("typing 'iphne' returns 'iPhone' results within 500ms", async ({ page }) => {
		test.fixme(true, "Wave 2 Track B (Plan 57-04) pg_trgm impl");
		await page.goto("/marketplace");
		const start = Date.now();
		await page.getByPlaceholder("Search").fill("iphne");
		// Wait for the trigram-ranked result to surface; UX-02 budget
		// is p95 < 50ms server-side, so 500ms end-to-end has comfortable
		// network/render slack.
		await expect(page.locator("text=/iPhone/i").first()).toBeVisible({
			timeout: 500,
		});
		expect(Date.now() - start).toBeLessThan(500);
	});

	test("typing 'g' (1-char) shows alphabetical browse (no similarity ranking)", async ({ page }) => {
		test.fixme(true, "Wave 2 Track B short-circuit impl");
		await page.goto("/marketplace");
		// Capture baseline empty-query results, then type 'g'. The count
		// MUST match (short-circuit returns the same list); ordering MUST
		// match the default alphabetical/createdAt sort.
		const baselineCount = await page
			.getByTestId("marketplace-listing")
			.count();
		await page.getByPlaceholder("Search").fill("g");
		await expect(page.getByTestId("marketplace-listing")).toHaveCount(
			baselineCount,
		);
	});

	test("typing 'gi' (2-char) shows alphabetical browse", async ({ page }) => {
		test.fixme(true, "Wave 2 Track B short-circuit impl");
		await page.goto("/marketplace");
		const baselineCount = await page
			.getByTestId("marketplace-listing")
			.count();
		await page.getByPlaceholder("Search").fill("gi");
		await expect(page.getByTestId("marketplace-listing")).toHaveCount(
			baselineCount,
		);
	});

	test("typing 'git' (3-char) ranks 'GitHub' results first", async ({ page }) => {
		test.fixme(true, "Wave 2 Track B similarity ranking impl");
		await page.goto("/marketplace");
		await page.getByPlaceholder("Search").fill("git");
		// First result row must contain 'GitHub' (per UX-02 ranking
		// contract — similarity(name||' '||description, 'git') DESC
		// puts 'GitHub Code Reviewer' above 'GitLab Sync' because
		// the trigram density is higher).
		const first = page.getByTestId("marketplace-listing").first();
		await expect(first).toContainText(/GitHub/i);
	});
});
