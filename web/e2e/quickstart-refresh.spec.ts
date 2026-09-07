import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeProviderStatus } from "./fixtures/data.js";

const project = makeProject({ id: "proj-quickstart", name: "Quickstart checks" });
const admin = { user: { id: "admin-1", name: "Admin", email: "admin@example.test", role: "admin" } };

test.describe("@evidence quickstart refresh", () => {
	test("saving a provider refreshes the persistent checklist without a reload", async ({ page, mockApi }, testInfo) => {
		let providerSaved = false;
		await mockApi({
			projects: [project],
			providers: [makeProviderStatus({ provider: "anthropic" })],
			routes: {
				"/api/auth/me": () => admin,
				"/api/quickstart": () => ({
					steps: { provider: providerSaved, chat: false, extension: false, agent: false },
				}),
			},
		});
		await page.route("**/api/providers", (route) => {
			if (route.request().method() === "POST") {
				providerSaved = true;
				return route.fulfill({ json: { success: true } });
			}
			return route.fallback();
		});

		await page.goto("/settings/models");
		const checklist = page.getByText("Set up a provider", { exact: true });
		await expect(checklist).not.toHaveClass(/line-through/);
		await page.getByLabel("API key for Anthropic").fill("test-key");
		await page.getByRole("button", { name: "Save Key" }).click();

		await expect(checklist).toHaveClass(/line-through/);
		await captureEvidence(page, testInfo, "quickstart-provider-refreshed", { fullPage: true });
	});
});
