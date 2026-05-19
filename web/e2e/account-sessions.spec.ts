import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Account Sessions & Login History", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });

	const meResponse = {
		user: { id: "user-1", email: "user@test.local", name: "Test User", role: "member" },
	};

	const accountData = {
		id: "user-1",
		email: "user@test.local",
		name: "Test User",
		role: "member" as const,
		createdAt: "2026-01-15T00:00:00.000Z",
	};

	const sessionsData = {
		sessions: [
			{ id: "sess-1", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", ipAddress: "192.168.1.1", lastActiveAt: "2026-03-23T12:00:00Z", createdAt: "2026-03-23T10:00:00Z", isCurrent: true },
			{ id: "sess-2", userAgent: "Mozilla/5.0 (Windows NT 10.0)", ipAddress: "10.0.0.1", lastActiveAt: "2026-03-22T08:00:00Z", createdAt: "2026-03-22T06:00:00Z", isCurrent: false },
		],
	};

	const loginHistoryData = {
		entries: [
			{ id: "al-1", action: "auth:login", userId: "user-1", createdAt: "2026-03-23T10:00:00Z", metadata: { ip: "192.168.1.1", userAgent: "Mozilla/5.0 (Macintosh)" } },
			{ id: "al-2", action: "auth:login", userId: "user-1", createdAt: "2026-03-22T06:00:00Z", metadata: { ip: "10.0.0.1", userAgent: "Mozilla/5.0 (Windows)" } },
		],
	};

	const defaultRoutes = {
		"/api/auth/me": () => meResponse,
		"/api/account/sessions": () => sessionsData,
		"/api/account/login-history": () => loginHistoryData,
		"/api/account": () => accountData,
	};

	test("shows Active Sessions with session list", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		await page.goto("/account");

		await expect(page.getByRole("heading", { name: "Active Sessions" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("192.168.1.1").first()).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("10.0.0.1").first()).toBeVisible({ timeout: 5000 });
	});

	test("shows current session badge", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		await page.goto("/account");

		await expect(page.getByText("(current session)")).toBeVisible({ timeout: 5000 });
	});

	test("shows Revoke button only on non-current sessions", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		await page.goto("/account");

		await expect(page.getByRole("heading", { name: "Active Sessions" })).toBeVisible({ timeout: 5000 });

		const revokeButtons = page.getByRole("button", { name: "Revoke" });
		await expect(revokeButtons).toHaveCount(1);
	});

	test("shows Login History entries", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		await page.goto("/account");

		await expect(page.getByRole("heading", { name: "Login History" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("192.168.1.1").first()).toBeVisible({ timeout: 5000 });
	});

	test("revoke button removes session and shows confirmation", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		// Mock DELETE to succeed, then GET returns only one session
		await page.route("**/api/account/sessions", (route) => {
			if (route.request().method() === "DELETE") {
				return route.fulfill({ json: { success: true } });
			}
			return route.fallback();
		});

		await page.goto("/account");

		await expect(page.getByRole("heading", { name: "Active Sessions" })).toBeVisible({ timeout: 5000 });

		// Click Revoke on the non-current session
		const revokeBtn = page.getByRole("button", { name: "Revoke" });
		await expect(revokeBtn).toHaveCount(1);
		await revokeBtn.click();

		// Verify success message appears
		await expect(page.getByText("Session revoked")).toBeVisible({ timeout: 5000 });
	});

	test("shows empty state when no active sessions", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				...defaultRoutes,
				"/api/account/sessions": () => ({ sessions: [] }),
			},
		});

		await page.goto("/account");

		await expect(page.getByText("No active sessions.")).toBeVisible({ timeout: 5000 });
	});

	test("shows empty state when no login history", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				...defaultRoutes,
				"/api/account/login-history": () => ({ entries: [] }),
			},
		});

		await page.goto("/account");

		await expect(page.getByText("No login history available.")).toBeVisible({ timeout: 5000 });
	});
});
