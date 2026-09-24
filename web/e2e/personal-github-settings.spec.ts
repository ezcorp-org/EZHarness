import { test, expect, captureEvidence } from "./fixtures/test-base.js";

const member = { user: { id: "owner-a", email: "owner@test.local", name: "Owner", role: "member" } };
const deviceReviewId = "00000000-0000-4000-8000-000000000002";
const deviceAttempt = (attemptId = "00000000-0000-4000-8000-000000000001", userCode = "ABCD-EFGH") => ({
	attemptId, userCode, verificationUri: "https://github.com/login/device",
	expiresAt: new Date(Date.now() + 600_000).toISOString(), intervalSeconds: 1,
});

test("personal GitHub connection is available to a member @evidence", async ({ page, mockApi }, testInfo) => {
	await mockApi({ routes: {
		"/api/auth/me": () => member,
		"/api/github/connection": () => ({ status: "disconnected", configured: true, authMode: "device" }),
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
		"/api/github/connection": () => ({ status: "disconnected", configured: true, authMode: "oauth" }),
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

test("device code connects on this installation and restores an owned review @evidence", async ({ page, mockApi }, testInfo) => {
	let connected = false;
	let polls = 0;
	const starts: unknown[] = [];
	await mockApi({ routes: {
		"/api/auth/me": () => member,
		"/api/github/connection": () => ({ status: connected ? "connected" : "disconnected", configured: true, authMode: "device", account: connected ? { id: 123, login: "owner-a" } : undefined }),
		"/api/github/device/start": () => deviceAttempt(),
		"/api/github/device/poll": () => {
			polls++;
			if (polls === 1) return { status: "slow_down", nextPollAt: new Date(Date.now() + 1000).toISOString() };
			connected = true;
			return { status: "connected", returnReviewId: deviceReviewId };
		},
		[`/api/github/personal-prs/proposals/${deviceReviewId}`]: () => ({ reviewPath: `/project/private-project/chat/private-conversation?review=${deviceReviewId}` }),
	} });
	await page.route("**/api/github/device/start", (route) => {
		starts.push(route.request().postDataJSON());
		return route.fulfill({ json: deviceAttempt() });
	});
	await page.goto(`/settings/github?review=${deviceReviewId}`);
	await page.getByRole("button", { name: "Connect GitHub" }).click();
	await expect(page.getByLabel("GitHub device code")).toHaveText("ABCD-EFGH");
	await expect(page.getByRole("link", { name: "Open GitHub verification" })).toHaveAttribute("href", "https://github.com/login/device");
	await expect(page.getByText(/Only enter a code that you just requested here/)).toBeVisible();
	await captureEvidence(page, testInfo, "github-device-code-desktop");
	await expect(page.getByText(/GitHub asked us to check less often/)).toBeVisible();
	await expect(page.getByText("owner-a", { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Return to PR review" })).toHaveAttribute("href", `/project/private-project/chat/private-conversation?review=${deviceReviewId}`);
	await expect(page.getByLabel("GitHub device code")).toHaveCount(0);
	await captureEvidence(page, testInfo, "github-device-connected-desktop");
	expect(starts).toEqual([{ returnReviewId: deviceReviewId }]);
	expect(polls).toBe(2);
});

test("device request resumes after a page reload and can be cancelled", async ({ page, mockApi }) => {
	let starts = 0;
	const cancellations: unknown[] = [];
	await mockApi({ routes: {
		"/api/auth/me": () => member,
		"/api/github/connection": () => ({ status: "disconnected", configured: true, authMode: "device" }),
		"/api/github/device/start": () => { starts++; return deviceAttempt(); },
		"/api/github/device/cancel": () => ({ status: "cancelled" }),
		"/api/github/device/poll": () => ({ status: "pending", nextPollAt: new Date(Date.now() + 3000).toISOString() }),
	} });
	await page.route("**/api/github/device/cancel", (route) => {
		cancellations.push(route.request().postDataJSON());
		return route.fulfill({ json: { status: "cancelled" } });
	});
	await page.goto("/settings/github");
	await page.getByRole("button", { name: "Connect GitHub" }).click();
	await expect(page.getByLabel("GitHub device code")).toHaveText("ABCD-EFGH");
	await page.reload();
	await expect(page.getByLabel("GitHub device code")).toHaveText("ABCD-EFGH");
	expect(starts).toBe(1);
	await page.getByRole("button", { name: "Cancel connection" }).click();
	await expect(page.getByText("GitHub connection request cancelled.")).toBeVisible();
	expect(cancellations).toEqual([{ attemptId: deviceAttempt().attemptId }]);
	await expect(page.getByLabel("GitHub device code")).toHaveCount(0);
});

test("device polling failure allows a manual check and reports denied approval", async ({ page, mockApi }) => {
	await mockApi({ routes: {
		"/api/auth/me": () => member,
		"/api/github/connection": () => ({ status: "disconnected", configured: true, authMode: "device" }),
		"/api/github/device/start": () => deviceAttempt(),
	} });
	let polls = 0;
	await page.route("**/api/github/device/poll", (route) => {
		polls++;
		return route.fulfill(polls === 1
			? { status: 503, json: { error: "Could not check GitHub connection" } }
			: { json: { status: "denied" } });
	});
	await page.goto("/settings/github");
	await page.getByRole("button", { name: "Connect GitHub" }).click();
	await expect(page.getByText("The connection check failed. You can check again.")).toBeVisible();
	await page.getByRole("button", { name: "Check again" }).click();
	await expect(page.getByText("GitHub approval was denied. Request a new code if you want to try again.")).toBeVisible();
	expect(polls).toBe(2);
});

test("an unverified code expires even when the connection check fails", async ({ page, mockApi }) => {
	await page.clock.install({ time: new Date("2026-09-23T12:00:00.000Z") });
	await mockApi({ routes: {
		"/api/auth/me": () => member,
		"/api/github/connection": () => ({ status: "disconnected", configured: true, authMode: "device" }),
		"/api/github/device/start": () => ({ ...deviceAttempt(), expiresAt: "2026-09-23T12:00:05.000Z" }),
	} });
	let polls = 0;
	await page.route("**/api/github/device/poll", (route) => {
		polls++;
		return route.fulfill({ status: 503, json: { error: "GitHub check unavailable" } });
	});
	await page.goto("/settings/github");
	await page.getByRole("button", { name: "Connect GitHub" }).click();
	await expect(page.getByLabel("GitHub device code")).toHaveText("ABCD-EFGH");
	await page.clock.runFor(1000);
	await expect(page.getByText("The connection check failed. You can check again.")).toBeVisible();
	await expect(page.getByRole("alert")).toHaveText("GitHub check unavailable");
	await page.clock.runFor(4000);
	await expect(page.getByText("The GitHub code expired. Request a new code to try again.")).toBeVisible();
	await expect(page.getByLabel("GitHub device code")).toHaveCount(0);
	expect(polls).toBe(1);
});

test("failed account lookup retires its one-use code and starts a fresh request", async ({ page, mockApi }) => {
	await page.clock.install({ time: new Date("2026-09-23T12:00:00.000Z") });
	let starts = 0;
	await mockApi({ routes: {
		"/api/auth/me": () => member,
		"/api/github/connection": () => ({ status: "disconnected", configured: true, authMode: "device" }),
		"/api/github/device/start": () => deviceAttempt(starts++ === 0 ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000003", starts === 1 ? "ABCD-EFGH" : "WXYZ-1234"),
	} });
	await page.route("**/api/github/device/poll", (route) => route.fulfill({
		status: 409, json: { code: "DEVICE_RESTART_REQUIRED", error: "GitHub account lookup failed. Start a new connection." },
	}));
	await page.goto("/settings/github");
	await page.getByRole("button", { name: "Connect GitHub" }).click();
	await expect(page.getByLabel("GitHub device code")).toHaveText("ABCD-EFGH");
	await page.clock.runFor(1000);
	await expect(page.getByRole("alert")).toHaveText("GitHub account lookup failed. Start a new connection.");
	await expect(page.getByLabel("GitHub device code")).toHaveCount(0);
	await page.getByRole("button", { name: "Connect GitHub" }).click();
	await expect(page.getByLabel("GitHub device code")).toHaveText("WXYZ-1234");
	expect(starts).toBe(2);
});

test("an already expired server code is discarded without showing a verification link", async ({ page, mockApi }) => {
	await mockApi({ routes: {
		"/api/auth/me": () => member,
		"/api/github/connection": () => ({ status: "disconnected", configured: true, authMode: "device" }),
		"/api/github/device/start": () => ({ ...deviceAttempt(), expiresAt: new Date(Date.now() - 1000).toISOString() }),
	} });
	await page.goto("/settings/github");
	await page.getByRole("button", { name: "Connect GitHub" }).click();
	await expect(page.getByText("The GitHub code expired. Request a new code to try again.")).toBeVisible();
	await expect(page.getByLabel("GitHub device code")).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Open GitHub verification" })).toHaveCount(0);
});

test("a saved code is hidden when the current session cannot use it", async ({ page, mockApi }) => {
	await mockApi({ routes: {
		"/api/auth/me": () => member,
		"/api/github/connection": () => ({ status: "disconnected", configured: true, authMode: "device" }),
	} });
	await page.addInitScript((attempt) => sessionStorage.setItem("ezcorp-github-device-attempt", JSON.stringify(attempt)), deviceAttempt());
	await page.route("**/api/github/device/poll", (route) => route.fulfill({ status: 404, json: { error: "GitHub device authorization is unavailable" } }));
	await page.goto("/settings/github");
	await expect(page.getByLabel("GitHub device code")).toHaveCount(0);
	await expect(page.getByRole("alert")).toHaveText("Saved GitHub connection request is unavailable. Start a new code.");
	await expect.poll(() => page.evaluate(() => sessionStorage.getItem("ezcorp-github-device-attempt"))).toBeNull();
});

test("a malformed saved request and provider conflict leave a retry path", async ({ page, mockApi }) => {
	await mockApi({ routes: {
		"/api/auth/me": () => member,
		"/api/github/connection": () => ({ status: "disconnected", configured: true, authMode: "device" }),
		"/api/github/device/start": () => deviceAttempt(),
	} });
	await page.addInitScript(() => sessionStorage.setItem("ezcorp-github-device-attempt", "{"));
	await page.route("**/api/github/device/poll", (route) => route.fulfill({ status: 409, body: "{", contentType: "application/json" }));
	await page.goto("/settings/github");
	await expect(page.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
	await expect.poll(() => page.evaluate(() => sessionStorage.getItem("ezcorp-github-device-attempt"))).toBeNull();
	await page.getByRole("button", { name: "Connect GitHub" }).click();
	await expect(page.getByLabel("GitHub device code")).toHaveText("ABCD-EFGH");
	await expect(page.getByRole("alert")).toHaveText("Could not check GitHub connection");
	await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
});

test("start and cancel failures keep a usable connection request @evidence", async ({ page, mockApi }, testInfo) => {
	let starts = 0;
	let cancellations = 0;
	await mockApi({ routes: {
		"/api/auth/me": () => member,
		"/api/github/connection": () => ({ status: "disconnected", configured: true, authMode: "device" }),
		"/api/github/device/poll": () => ({ status: "pending", nextPollAt: new Date(Date.now() + 30_000).toISOString() }),
	} });
	await page.route("**/api/github/device/start", (route) => route.fulfill(++starts === 1
		? { status: 503, json: { error: "GitHub is unavailable" } }
		: { json: deviceAttempt() }));
	await page.route("**/api/github/device/cancel", (route) => route.fulfill(++cancellations === 1
		? { status: 503, json: { error: "Cancel is unavailable" } }
		: { json: { status: "cancelled" } }));
	await page.goto("/settings/github");
	await page.getByRole("button", { name: "Connect GitHub" }).click();
	await expect(page.getByRole("alert")).toHaveText("GitHub is unavailable");
	await page.getByRole("button", { name: "Connect GitHub" }).click();
	await expect(page.getByLabel("GitHub device code")).toHaveText("ABCD-EFGH");
	await page.getByRole("button", { name: "Cancel connection" }).click();
	await expect(page.getByRole("alert")).toHaveText("Cancel is unavailable");
	await expect(page.getByLabel("GitHub device code")).toHaveText("ABCD-EFGH");
	await captureEvidence(page, testInfo, "github-device-cancel-error-desktop");
	await page.getByRole("button", { name: "Cancel connection" }).click();
	await expect(page.getByText("GitHub connection request cancelled.")).toBeVisible();
	expect({ starts, cancellations }).toEqual({ starts: 2, cancellations: 2 });
	await page.getByTestId("settings-nav-personalization").click();
	await expect(page).toHaveURL(/\/settings\/personalization$/);
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

	test("device code and cancel control fit the phone viewport @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ routes: {
			"/api/auth/me": () => member,
			"/api/github/connection": () => ({ status: "disconnected", configured: true, authMode: "device" }),
			"/api/github/device/start": () => deviceAttempt(),
			"/api/github/device/cancel": () => ({ status: "cancelled" }),
		} });
		await page.goto("/settings/github");
		await page.getByRole("button", { name: "Connect GitHub" }).click();
		await expect(page.getByLabel("GitHub device code")).toHaveText("ABCD-EFGH");
		const verifyLink = page.getByRole("link", { name: "Open GitHub verification" });
		await expect(verifyLink).toBeVisible();
		const position = await verifyLink.boundingBox();
		expect(position).not.toBeNull();
		expect(position!.y + position!.height).toBeLessThanOrEqual(844);
		await captureEvidence(page, testInfo, "github-device-code-mobile");
		await page.getByRole("button", { name: "Cancel connection" }).click();
		await expect(page.getByText("GitHub connection request cancelled.")).toBeVisible();
	});
});
