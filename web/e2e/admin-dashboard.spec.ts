import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Admin Dashboard", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });

	const adminMe = {
		user: { id: "user-1", email: "admin@test.local", name: "Test Admin", role: "admin" },
	};

	const analyticsData = {
		chatActivity: [{ date: "2026-03-01", messageCount: 42, conversationCount: 5 }],
		modelUsage: [{ model: "gpt-4", provider: "openai", count: 100 }],
		agentStats: [{ name: "summarizer", conversationCount: 15 }],
		extensionStats: [{ name: "code-review", installCount: 3 }],
		userStats: { totalUsers: 10, activeUsers30d: 7, signupsLast30d: [] },
	};

	const systemData = {
		health: { dbSizeBytes: 52428800, uptimeSeconds: 86400, tableRowCounts: { conversations: 150, messages: 3000, agents: 5 } },
		activityFeed: [{ id: "a1", action: "auth:login", target: null, metadata: {}, createdAt: "2026-03-23T12:00:00Z", userName: "Test User", userEmail: "test@test.local" }],
		errorSummary: { totalErrors: 3, errorRate: [{ date: "2026-03-23", count: 1 }], recentErrors: [{ id: "e1", level: "error", message: "Connection timeout", createdAt: "2026-03-23T11:00:00Z" }] },
	};

	const defaultRoutes = {
		"/api/auth/me": () => adminMe,
		"/api/admin/analytics": () => analyticsData,
		"/api/admin/system": () => systemData,
	};

	test("shows dashboard with 4 tab buttons", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		await page.goto("/admin/dashboard");

		await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: "Overview" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: "Usage" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: "Activity" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: "System" })).toBeVisible({ timeout: 5000 });
	});

	test("overview tab shows stat cards", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		await page.goto("/admin/dashboard");

		await expect(page.getByText("Total Users")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Total Conversations")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Total Messages")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Active Agents")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("10").first()).toBeVisible({ timeout: 5000 });
	});

	test("usage tab shows charts", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		await page.goto("/admin/dashboard");

		await expect(page.getByRole("button", { name: "Usage" })).toBeVisible({ timeout: 5000 });
		await page.getByRole("button", { name: "Usage" }).click();

		await expect(page.getByRole("heading", { name: "Chat Activity (Last 30 Days)" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("heading", { name: "Model Usage" })).toBeVisible({ timeout: 5000 });
	});

	test("activity tab shows feed", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		await page.goto("/admin/dashboard");

		await expect(page.getByRole("button", { name: "Activity" })).toBeVisible({ timeout: 5000 });
		await page.getByRole("button", { name: "Activity" }).click();

		await expect(page.getByRole("heading", { name: "Recent Activity" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("auth:login")).toBeVisible({ timeout: 5000 });
	});

	test("system tab shows health", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		await page.goto("/admin/dashboard");

		await expect(page.getByRole("button", { name: "System" })).toBeVisible({ timeout: 5000 });
		await page.getByRole("button", { name: "System" }).click();

		await expect(page.getByText("Database Size")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Uptime")).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("heading", { name: "Errors (Last 7 Days)" })).toBeVisible({ timeout: 5000 });
	});

	test("shows last updated timestamp after data loads", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		await page.goto("/admin/dashboard");

		// After data loads, "Updated Xs ago" should appear
		await expect(page.getByText(/Updated \d+s ago/)).toBeVisible({ timeout: 5000 });
	});

	test("shows empty states when no data", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => adminMe,
				"/api/admin/analytics": () => ({
					chatActivity: [],
					modelUsage: [],
					agentStats: [],
					extensionStats: [],
					userStats: { totalUsers: 0, activeUsers30d: 0, signupsLast30d: [] },
				}),
				"/api/admin/system": () => ({
					health: { dbSizeBytes: 0, uptimeSeconds: 0, tableRowCounts: {} },
					activityFeed: [],
					errorSummary: { totalErrors: 0, errorRate: [], recentErrors: [] },
				}),
			},
		});

		await page.goto("/admin/dashboard");

		// Click Usage tab - should show empty message
		await page.getByRole("button", { name: "Usage" }).click();
		await expect(page.getByText("No chat activity in this period.")).toBeVisible({ timeout: 5000 });

		// Click Activity tab - should show empty message
		await page.getByRole("button", { name: "Activity" }).click();
		await expect(page.getByText("No recent activity.")).toBeVisible({ timeout: 5000 });
	});

	test("redirects non-admin to home", async ({ page, mockApi }) => {
		const memberMe = {
			user: { id: "user-1", email: "member@test.local", name: "Member User", role: "member" },
		};

		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => memberMe,
				"/api/admin/analytics": () => analyticsData,
				"/api/admin/system": () => systemData,
			},
		});

		await page.goto("/admin/dashboard");

		await expect(page).toHaveURL("/", { timeout: 5000 });
	});
});
