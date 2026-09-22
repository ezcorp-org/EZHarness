import { test, expect, captureEvidence } from "./fixtures/test-base.js";

const member = { user: { id: "owner-a", email: "owner@test.local", name: "Owner", role: "member" } };

test("personal GitHub connection is available to a member @evidence", async ({ page, mockApi }, testInfo) => {
	await mockApi({ routes: {
		"/api/auth/me": () => member,
		"/api/github/connection": () => ({ status: "disconnected", configured: true }),
	} });
	await page.goto("/settings/github");
	await expect(page.getByTestId("settings-nav-github")).toBeVisible();
	await expect(page.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
	await expect(page.getByText("No GitHub account connected.")).toBeVisible();
	await captureEvidence(page, testInfo, "personal-github-disconnected-desktop");
});

test.describe("mobile GitHub settings", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("connected account shows organization approval and disconnect confirmation @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ routes: {
			"/api/auth/me": () => member,
			"/api/github/connection": () => ({ status: "connected", configured: true, account: { id: 123, login: "owner-a" } }),
			"/api/github/repositories/check": () => ({ status: "organization_approval_pending", repository: { id: 42, fullName: "org/private-repo" }, manageUrl: "https://github.com/organizations/org/settings/installations" }),
		} });
		await page.goto("/settings/github?repositoryId=42");
		await expect(page.getByText("owner-a", { exact: true })).toBeVisible();
		await expect(page.getByText("Your organization must approve the GitHub App.")).toBeVisible();
		await expect(page.getByRole("link", { name: "Manage organization approval" })).toHaveAttribute("href", "https://github.com/organizations/org/settings/installations");
		await captureEvidence(page, testInfo, "personal-github-org-approval-mobile");
		await page.getByRole("button", { name: "Disconnect", exact: true }).click();
		await expect(page.getByText("Pending draft pull requests will stop until you reconnect.")).toBeVisible();
		await captureEvidence(page, testInfo, "personal-github-disconnect-mobile");
	});
});
