import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeProviderStatus } from "./fixtures/data.js";

const project = makeProject({ id: "proj-access", name: "Access checks" });
const member = { user: { id: "member-1", name: "Member", email: "member@example.test", role: "member" } };
const admin = { user: { id: "admin-1", name: "Admin", email: "admin@example.test", role: "admin" } };

test.describe("@evidence provider access", () => {
	test("a member gets a completable provider explanation, not an admin-only CTA", async ({ page, mockApi }, testInfo) => {
		await mockApi({
			projects: [project],
			conversations: [],
			routes: {
				"/api/auth/me": () => member,
				"/api/quickstart": () => ({ steps: { provider: false, chat: false, extension: false, agent: false } }),
			},
		});
		await page.goto(`/project/${project.id}/chat`);

		const banner = page.locator('[data-testid="no-provider-banner"]:visible');
		await expect(banner).toContainText("An administrator needs to connect a provider");
		await expect(banner.getByTestId("no-provider-banner-cta")).toHaveCount(0);
		await captureEvidence(page, testInfo, "member-provider-guidance", { fullPage: true });

		await page.setViewportSize({ width: 393, height: 851 });
		await expect(page.locator('[data-testid="no-provider-banner"]:visible')).toContainText("administrator");
		await captureEvidence(page, testInfo, "member-provider-guidance-mobile", { fullPage: true });
	});

	test("an admin retains labelled provider controls", async ({ page, mockApi }, testInfo) => {
		await mockApi({
			projects: [project],
			providers: [makeProviderStatus({ provider: "anthropic" })],
			routes: { "/api/auth/me": () => admin },
		});
		await page.goto("/settings/models");

		await expect(page.getByLabel("API key for Anthropic")).toBeVisible();
		await expect(page.getByRole("button", { name: "Show API key for Anthropic" })).toBeVisible();
		await captureEvidence(page, testInfo, "admin-provider-controls", { fullPage: true });
	});
});
