/**
 * Phase 57 — UX-03 Wave 0 RED scaffold (Playwright e2e).
 *
 * Pins the user-facing must_haves contract:
 *   "Save a search query (persists), pin agents (persists), orphaned
 *    references self-trim on read. UI is in AgentSearchPicker only —
 *    the other 8 pickers do NOT show save/pin affordances."
 *
 * Four cases — all `test.fixme` until Wave 3 (Plan 57-06) lands the
 * /api/user/agent-picker server route + the AgentSearchPicker UI.
 *
 * Run from web/:  `cd web && bunx playwright test e2e/agent-picker-prefs.spec.ts`
 */

import { test, expect } from "@playwright/test";

test.describe("Agent picker saved searches & pinned agents (UX-03)", () => {
	test("save a search query: appears in saved-searches list after reload", async ({ page }) => {
		test.fixme(true, "Wave 3 (Plan 57-06 Tasks 1+2) impl");
		await page.goto("/agents");
		await page.getByTestId("open-agent-picker").click();
		await page.getByPlaceholder("Search agents").fill("test query");
		await page.getByTestId("save-search-button").click();
		await page.reload();
		await page.getByTestId("open-agent-picker").click();
		await expect(
			page.locator("text=/test query/").first(),
		).toBeVisible();
	});

	test("pin an agent: chip with pin indicator survives reload", async ({ page }) => {
		test.fixme(true, "Wave 3 (Plan 57-06 Tasks 1+2) impl");
		await page.goto("/agents");
		await page.getByTestId("open-agent-picker").click();
		const firstAgent = page.getByTestId("agent-row").first();
		const firstAgentName = await firstAgent.textContent();
		await firstAgent.getByLabel("Pin agent").click();
		await page.reload();
		await page.getByTestId("open-agent-picker").click();
		// Pinned chip should appear in the pinned section AND show its
		// label matches the agent we pinned.
		await expect(page.getByTestId("pinned-agents")).toContainText(
			firstAgentName ?? "",
		);
	});

	test("orphaned pin (deleted agent) self-trims on next read", async ({ page, request }) => {
		test.fixme(true, "Wave 3 (Plan 57-06 Task 1) self-trim-on-read impl");
		// 1. Pin agent (via API to keep the test deterministic).
		await request.put("/api/user/agent-picker", {
			data: { pinned: ["agent-doomed"] },
		});
		// 2. Delete the agent (simulate post-pin deletion).
		await request.delete("/api/agent-configs/agent-doomed");
		// 3. Reload the picker.
		await page.goto("/agents");
		await page.getByTestId("open-agent-picker").click();
		// 4. The pinned list must NOT show the doomed agent.
		await expect(page.getByTestId("pinned-agents")).not.toContainText(
			"agent-doomed",
		);
	});

	test("pin/save UI absent in 8 non-agent pickers (smoke)", async ({ page }) => {
		test.fixme(true, "Wave 3 (Plan 57-06 Task 2) UI surface contract");
		await page.goto("/agents/new");
		await page.getByTestId("open-extension-search-picker").click();
		await expect(page.getByTestId("save-search-button")).toHaveCount(0);
		await expect(page.getByTestId("pinned-extensions")).toHaveCount(0);
		// Smoke is one non-agent picker; Plan 57-06 Task 2 widens to all 8
		// once each picker's mount point ships a deterministic test-id.
	});
});
