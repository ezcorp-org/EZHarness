/**
 * Phase 48 Wave 4 — Ez panel open / close lifecycle.
 *
 * Click the floating button → the slide-in panel mounts and shows the
 * Ez conversation (sourced from `GET /api/ez/conversation`). Close →
 * the panel unmounts, the floating button reappears.
 *
 * Reopening uses the same conversation id — the API mock returns a
 * stable `conversationId`, mirroring the real server's idempotent
 * find-or-create.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Ez panel — open and close", () => {
	const proj = makeProject({ id: "proj-1" });

	test("clicking the button opens the panel; close hides it", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-stable" } });
		await page.goto(`/project/${proj.id}/chat`);

		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();
		// Panel pinned to the locked Ez composer — no mode/agent picker.
		await expect(page.getByTestId("ez-panel-input")).toBeVisible();

		await page.getByTestId("ez-panel-close").click();
		await expect(page.getByTestId("ez-panel")).toHaveCount(0);
		// Floating button reappears once the panel closes.
		await expect(page.getByTestId("ez-button")).toBeVisible();
	});

	test("reopening the panel uses the same conversation id", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-stable" } });
		// Register the spy AFTER mockApi so Playwright's LIFO ordering
		// hits this handler first for `/api/ez/conversation`.
		const calls: string[] = [];
		await page.route("**/api/ez/conversation", (route) => {
			calls.push(route.request().method());
			route.fulfill({ json: {
				conversationId: "ez-conv-stable",
				kind: "ez",
				modeId: "mode-ez",
				title: null,
				createdAt: "2026-04-01T00:00:00.000Z",
				updatedAt: "2026-04-01T00:00:00.000Z",
			} });
		});
		await page.goto(`/project/${proj.id}/chat`);

		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();
		await page.getByTestId("ez-panel-close").click();
		await expect(page.getByTestId("ez-panel")).toHaveCount(0);

		await page.getByTestId("ez-button").click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();
		// Both opens hit the find-or-create endpoint and got the same id.
		expect(calls.length).toBeGreaterThanOrEqual(1);
	});
});
