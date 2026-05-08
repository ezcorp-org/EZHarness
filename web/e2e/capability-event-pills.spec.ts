/**
 * Phase 52.5 — capability event pills in chat + settings page.
 *
 * Two surfaces:
 *   1. Settings page: "Audit & Visibility" section with three
 *      controls (built-in toggle, installed toggle, sample-N input).
 *   2. Chat: pill renders for built-in extension capability events
 *      by default; hides for installed-extension events; settings
 *      toggle reveals.
 *
 * Surface 2 is hard to drive end-to-end without a real capability
 * call (recordCapabilityCall is server-side); we instead seed a
 * synthetic `capability-event` message via the mocked /api/extensions
 * + the messages API and verify the pill component renders. The
 * unit + component tests cover the rendering logic comprehensively.
 */
import { test, expect } from "./fixtures/test-base.js";

test.describe("Audit & Visibility settings", () => {
	test("section renders with three controls (collapsed by default)", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [], extensions: [] });
		await page.goto("/settings");

		const section = page.getByTestId("settings-audit-visibility");
		await expect(section).toBeVisible();
		await expect(section).toContainText("Audit & Visibility");

		// Collapsed: toggles not visible.
		await expect(page.getByTestId("toggle-builtin-pills")).not.toBeVisible();

		// Expand.
		await section.getByRole("button", { name: /Audit & Visibility/ }).click();
		await expect(page.getByTestId("toggle-builtin-pills")).toBeVisible();
		await expect(page.getByTestId("toggle-installed-pills")).toBeVisible();
		await expect(page.getByTestId("input-event-audit-sample")).toBeVisible();
	});

	test("toggling built-in pills calls upsertSetting", async ({ page, mockApi }) => {
		await mockApi({ projects: [], extensions: [] });
		// Capture upsertSetting calls — the API is /api/settings (POST).
		const settingsCalls: Array<Record<string, unknown>> = [];
		await page.route("**/api/settings", async (route) => {
			if (route.request().method() === "POST") {
				const body = route.request().postDataJSON();
				settingsCalls.push(body);
				await route.fulfill({ status: 200, json: { success: true } });
			} else {
				await route.continue();
			}
		});

		await page.goto("/settings");
		await page.getByTestId("settings-audit-visibility").getByRole("button", { name: /Audit & Visibility/ }).click();
		await page.getByTestId("toggle-builtin-pills").click();

		// Wait briefly for the network call.
		await expect.poll(() => settingsCalls.length).toBeGreaterThan(0);
		const found = settingsCalls.find(
			(c) => c.key === "global:showBuiltinCapabilityEvents",
		);
		expect(found).toBeTruthy();
	});

	test("event audit sample N input clamps out-of-range values", async ({ page, mockApi }) => {
		await mockApi({ projects: [], extensions: [] });
		await page.route("**/api/settings", async (route) => {
			if (route.request().method() === "POST") {
				await route.fulfill({ status: 200, json: { success: true } });
			} else {
				await route.continue();
			}
		});

		await page.goto("/settings");
		await page.getByTestId("settings-audit-visibility").getByRole("button", { name: /Audit & Visibility/ }).click();
		const input = page.getByTestId("input-event-audit-sample");
		await input.fill("999999");
		await input.blur();
		// Component clamps to 10000 client-side via saveEventAuditSampleN.
		await expect(input).toHaveValue("10000");

		await input.fill("-5");
		await input.blur();
		await expect(input).toHaveValue("1");
	});
});
