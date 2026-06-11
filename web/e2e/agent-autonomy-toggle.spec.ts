/**
 * Advanced Settings → "Agent goal pinning & autonomous continuation"
 * master kill-switch. OFF reverts spawned sub-agents to the prior
 * one-shot behavior (no pinned objective, no autonomous looping). The
 * server-side gate is unit-tested in start-assignment-plumbing.test.ts;
 * this spec covers the UI contract: the toggle lives in the (always
 * visible) Advanced section and persists `global:agentAutonomyEnabled`
 * via the upsertSetting wire format (PUT /api/settings/{key}).
 *
 * Pattern mirrors capability-event-pills.spec.ts:41 ("toggling built-in
 * pills calls upsertSetting").
 */
import { test, expect } from "./fixtures/test-base.js";

test.describe("Advanced Settings — agent autonomy kill-switch", () => {
	test("toggle is visible in the Advanced section", async ({ page, mockApi }) => {
		await mockApi({ projects: [], extensions: [] });
		await page.goto("/settings/personalization");

		const toggle = page.getByTestId("toggle-agent-autonomy");
		await expect(toggle).toBeVisible();
		// Default ON (no persisted setting ⇒ `!== false` ⇒ enabled).
		await expect(toggle).toHaveAttribute("aria-checked", "true");
	});

	test("toggling persists global:agentAutonomyEnabled=false via upsertSetting", async ({ page, mockApi }) => {
		await mockApi({ projects: [], extensions: [] });
		// upsertSetting() (web/src/lib/api.ts) → PUT /api/settings/{key} with { value }.
		const settingsCalls: Array<{ key: string; value: unknown }> = [];
		await page.route("**/api/settings/**", async (route) => {
			if (route.request().method() === "PUT") {
				const url = new URL(route.request().url());
				const key = decodeURIComponent(url.pathname.replace(/^.*\/api\/settings\//, ""));
				const body = route.request().postDataJSON() as { value?: unknown };
				settingsCalls.push({ key, value: body?.value });
				await route.fulfill({ status: 200, json: { success: true } });
			} else {
				await route.continue();
			}
		});

		await page.goto("/settings/personalization");
		const toggle = page.getByTestId("toggle-agent-autonomy");
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await toggle.click();

		await expect.poll(() => settingsCalls.length).toBeGreaterThan(0);
		const found = settingsCalls.find((c) => c.key === "global:agentAutonomyEnabled");
		expect(found).toBeTruthy();
		// First click from the default-ON state → persists OFF (revert).
		expect(found!.value).toBe(false);
		// Optimistic UI flips immediately.
		await expect(toggle).toHaveAttribute("aria-checked", "false");
	});
});
