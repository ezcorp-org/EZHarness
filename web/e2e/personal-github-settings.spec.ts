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

test("connection failures can be retried after reloading settings", async ({ page, mockApi }) => {
	await mockApi({ routes: { "/api/auth/me": () => member } });
	let attempts = 0;
	await page.route("**/api/github/connection", (route) => {
		attempts++;
		return route.fulfill(attempts === 1
			? { status: 503, json: { error: "Connection service is unavailable" } }
			: { json: { status: "disconnected", configured: true } });
	});
	await page.goto("/settings/github");
	await expect(page.getByRole("alert")).toHaveText("Connection service is unavailable");
	await expect(page.getByText("Could not load your GitHub connection. Reload this page to try again.")).toBeVisible();
	await page.reload();
	await expect(page.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
	expect(attempts).toBe(2);
});

test("Connect validates the OAuth address and keeps the review return ID", async ({ page, mockApi }) => {
	await mockApi({ routes: {
		"/api/auth/me": () => member,
		"/api/github/connection": () => ({ status: "disconnected", configured: true }),
	} });
	const bodies: unknown[] = [];
	let attempts = 0;
	await page.route("**/api/github/authorize", (route) => {
		bodies.push(route.request().postDataJSON());
		attempts++;
		return route.fulfill({ json: { authorizeUrl: attempts === 1
			? "https://example.com/login/oauth/authorize"
			: "https://github.com/login/oauth/authorize?client_id=example" } });
	});
	// A 204 navigation keeps the app document alive after it issues the
	// allowlisted OAuth request, so the browser can record that code path.
	await page.route("https://github.com/login/oauth/authorize**", (route) => route.fulfill({ status: 204, body: "" }));
	await page.goto("/settings/github?review=review-42");
	await page.getByRole("button", { name: "Connect GitHub" }).click();
	await expect(page.getByRole("alert")).toHaveText("GitHub returned an invalid authorization address");
	await expect(page.getByRole("button", { name: "Connect GitHub" })).toBeEnabled();
	await page.reload();
	const authorizationRequest = page.waitForRequest("https://github.com/login/oauth/authorize?client_id=example");
	await page.getByRole("button", { name: "Connect GitHub" }).click();
	expect((await authorizationRequest).url()).toBe("https://github.com/login/oauth/authorize?client_id=example");
	await expect(page).toHaveURL(/\/settings\/github\?review=review-42$/);
	expect(bodies).toEqual([{ returnReviewId: "review-42" }, { returnReviewId: "review-42" }]);
});

test("repository check and disconnect errors leave the account available to recover", async ({ page, mockApi }) => {
	await mockApi({ routes: {
		"/api/auth/me": () => member,
		"/api/github/connection": () => ({ status: "connected", configured: true, account: { id: 123, login: "owner-a" } }),
	} });
	let checks = 0;
	await page.route("**/api/github/repositories/check?repositoryId=42", (route) => {
		checks++;
		return route.fulfill(checks === 1
			? { status: 503, json: { error: "Repository check unavailable" } }
			: { json: { status: "repository_not_enabled", repository: { id: 42, fullName: "org/private-repo" } } });
	});
	let disconnects = 0;
	await page.route("**/api/github/connection", (route) => {
		if (route.request().method() !== "DELETE") return route.fallback();
		disconnects++;
		return route.fulfill(disconnects === 1
			? { status: 503, json: { error: "Disconnect unavailable" } }
			: { json: { status: "disconnected", configured: true } });
	});
	await page.goto("/settings/github?repositoryId=42");
	await expect(page.getByRole("alert")).toHaveText("Repository check unavailable");
	await expect(page.getByText("owner-a", { exact: true })).toBeVisible();
	await page.reload();
	await expect(page.getByText("Enable this repository for the GitHub App.")).toBeVisible();
	await page.getByRole("button", { name: "Disconnect", exact: true }).click();
	await page.getByRole("button", { name: "Disconnect GitHub" }).click();
	await expect(page.getByRole("alert")).toHaveText("Disconnect unavailable");
	await expect(page.getByRole("button", { name: "Disconnect GitHub" })).toBeEnabled();
	await page.getByRole("button", { name: "Disconnect GitHub" }).click();
	await expect(page.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
	expect({ checks, disconnects }).toEqual({ checks: 2, disconnects: 2 });
});

test.describe("mobile GitHub settings", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("connected account shows user-reported approval and disconnect confirmation @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ routes: {
			"/api/auth/me": () => member,
			"/api/github/connection": () => ({ status: "connected", configured: true, account: { id: 123, login: "owner-a" } }),
			"/api/github/repositories/check": () => ({ status: "repository_not_enabled", repository: { id: 42, fullName: "org/private-repo" }, manageUrl: "https://github.com/organizations/org/settings/installations" }),
		} });
		await page.goto("/settings/github?repositoryId=42");
		await expect(page.getByText("owner-a", { exact: true })).toBeVisible();
		await expect(page.getByText("Enable this repository for the GitHub App.")).toBeVisible();
		await page.getByRole("button", { name: "I requested approval" }).click();
		await expect(page.getByText("Approval may be pending. GitHub has not enabled this repository yet.")).toBeVisible();
		await expect(page.getByRole("link", { name: "Manage organization approval" })).toHaveAttribute("href", "https://github.com/organizations/org/settings/installations");
		await captureEvidence(page, testInfo, "personal-github-org-approval-mobile");
		await page.getByRole("button", { name: "Disconnect", exact: true }).click();
		await expect(page.getByText("Pending draft pull requests will stop until you reconnect.")).toBeVisible();
		await captureEvidence(page, testInfo, "personal-github-disconnect-mobile");
	});
});
