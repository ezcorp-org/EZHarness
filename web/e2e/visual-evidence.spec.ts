/**
 * Visual-evidence capture mechanism — e2e self-test (mockApi, no Docker).
 *
 * Exercises the `captureEvidence` helper against the mocked preview backend:
 * it sets up mocks, navigates to a stable page (the Hub empty-state, which
 * renders deterministically off mocked `/api/hub/pages`), waits for a
 * visible element, then captures. The title carries the literal `@evidence`
 * tag so `bunx playwright test --grep @evidence` selects it.
 *
 * Both branches are asserted so the spec passes with AND without the flag:
 *   - `EZCORP_E2E_EVIDENCE=1` → a PNG attachment named "dashboard" exists.
 *   - otherwise              → no such attachment (the hard no-op is proven).
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Visual evidence", () => {
	test("captures page evidence when enabled, no-ops otherwise @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [makeProject({ id: "proj-1" })] });
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: { pages: [] } }));

		await page.goto("/hub");

		// Wait for a stable, visible element before capturing.
		await expect(page.getByText("No Hub pages yet")).toBeVisible();
		await expect(page.getByRole("link", { name: "Browse extensions" })).toBeVisible();

		await captureEvidence(page, testInfo, "dashboard");

		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "dashboard" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			// Hard no-op: nothing attached when the flag is unset.
			expect(testInfo.attachments.some((a) => a.name === "dashboard")).toBe(false);
		}
	});
});
