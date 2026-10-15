/**
 * Admin dashboard (`/admin/dashboard`) — the error rankings, per-source load
 * failures with Retry, the identity-check failure bounce, and the
 * auto-refresh (30 s timer and returning to the tab).
 * RENDER tier (mockApi; per-test routes win).
 */
import type { Page } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });

const systemData = {
	health: { dbSizeBytes: 0, uptimeSeconds: 0, tableRowCounts: {} },
	activityFeed: [],
	errorSummary: { totalErrors: 0, errorRate: [], recentErrors: [] },
};

const analytics = {
	chatActivity: [],
	modelUsage: [],
	agentStats: [],
	extensionStats: [],
	userStats: { totalUsers: 0, activeUsers30d: 0, signupsLast30d: [] },
	toolUsage: {
		byTool: [{ toolName: "read_file", extensionId: "builtin", count: 42, successCount: 40, errorCount: 2 }],
		byAgent: [
			{ agentConfigId: "a1", agentName: "Researcher", toolName: "read_file", count: 30, errorCount: 1 },
			{ agentConfigId: "a2", agentName: "Builder", toolName: "write_file", count: 1, errorCount: 4 },
			{ agentConfigId: "a3", agentName: "Quiet", toolName: "ls", count: 9, errorCount: 0 },
		],
		byUser: [
			{ userId: "u1", userName: "Alice", userEmail: "alice@test.local", toolName: "read_file", count: 25, errorCount: 2 },
			{ userId: "u2", userName: "Bob", userEmail: "bob@test.local", toolName: "grep", count: 1, errorCount: 5 },
		],
		byModel: [
			{ model: "claude-opus-4-7", provider: "anthropic", toolName: "read_file", count: 37, errorCount: 1 },
			{ model: "gpt-5", provider: "openai", toolName: "write_file", count: 1, errorCount: 3 },
		],
	},
};

/** Count GETs per dashboard source so refreshes are observable. */
function countRequests(page: Page) {
	const counts = { analytics: 0 };
	page.on("request", (r) => {
		if (new URL(r.url()).pathname === "/api/admin/analytics") counts.analytics++;
	});
	return counts;
}

async function mockDashboard(mockApi: (o: Record<string, unknown>) => Promise<void>) {
	await mockApi({
		projects: [proj],
		routes: {
			"/api/admin/analytics": (url: URL) => (url.pathname === "/api/admin/analytics" ? analytics : { experiments: [] }),
			"/api/admin/system": () => systemData,
		},
	});
}

test.describe("Admin dashboard edges", () => {
	test("tool errors rank by error count and leave out error-free rows @evidence", async ({ page, mockApi }, testInfo) => {
		await mockDashboard(mockApi);
		await page.goto("/admin/dashboard");
		await page.getByRole("button", { name: "Usage" }).click();

		const byAgent = page.getByTestId("tool-errors-by-agent");
		await expect(byAgent.locator(".h-bar-row")).toHaveCount(2);
		await expect(byAgent.locator(".h-bar-row").first()).toContainText("write_file");
		await expect(byAgent.locator(".h-bar-row").first()).toContainText("· 1 call");
		await expect(byAgent).not.toContainText("Quiet");

		const byUser = page.getByTestId("tool-errors-by-user");
		await expect(byUser.locator(".h-bar-row").first()).toContainText("· Bob (bob@test.local)");
		await expect(byUser.locator(".h-bar-row").last()).toContainText("· 25 calls");

		const byModel = page.getByTestId("tool-errors-by-model");
		await expect(byModel.locator(".h-bar-row").first()).toContainText("· gpt-5 (openai)");
		await expect(byModel.locator(".h-bar-value").first()).toHaveText("3");
		await captureEvidence(page, testInfo, "admin-dashboard-tool-errors");
	});

	test("an unreachable source shows Retry, and Retry reloads it", async ({ page, mockApi }) => {
		await mockDashboard(mockApi);
		let down = true;
		for (const path of ["/api/admin/analytics", "/api/admin/analytics/routing", "/api/admin/system", "/api/admin/embed-progress"]) {
			await page.route((url) => url.pathname === path, (route) => (down ? route.abort() : route.fallback()));
		}
		await page.goto("/admin/dashboard");

		await page.getByRole("button", { name: "Usage" }).click();
		await expect(page.getByTestId("source-error")).toBeVisible();
		await page.getByRole("button", { name: "Routing" }).click();
		await expect(page.getByTestId("source-error")).toBeVisible();
		await page.getByRole("button", { name: "System" }).click();
		await expect(page.getByTestId("source-error")).toHaveCount(2);

		down = false;
		await page.getByRole("button", { name: "Usage" }).click();
		await page.getByTestId("source-error").getByRole("button", { name: "Retry" }).click();
		await expect(page.getByTestId("tool-errors-by-agent")).toBeVisible();
	});

	test("a failed identity check sends the user home", async ({ page, mockApi }) => {
		await mockDashboard(mockApi);
		await page.route("**/api/auth/me", (route) => route.abort());
		await page.goto("/admin/dashboard");
		// "/" then forwards to the default chat; the admin route is left.
		await expect(page).toHaveURL(/\/project\/[^/]+\/chat/);
	});

	test("the dashboard refreshes every 30 seconds and when the tab is shown again", async ({ page, mockApi }) => {
		await page.clock.install();
		await mockDashboard(mockApi);
		const counts = countRequests(page);
		await page.goto("/admin/dashboard");
		await expect.poll(() => counts.analytics).toBe(1);

		await page.clock.fastForward(30_000);
		await expect.poll(() => counts.analytics).toBe(2);

		await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
		await expect.poll(() => counts.analytics).toBe(3);
	});
});
