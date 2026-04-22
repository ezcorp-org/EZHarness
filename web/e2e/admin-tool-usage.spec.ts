import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Admin Dashboard — Tool-Call Usage analytics", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });

	const adminMe = {
		user: { id: "user-1", email: "admin@test.local", name: "Test Admin", role: "admin" },
	};

	const systemData = {
		health: { dbSizeBytes: 0, uptimeSeconds: 0, tableRowCounts: {} },
		activityFeed: [],
		errorSummary: { totalErrors: 0, errorRate: [], recentErrors: [] },
	};

	const analyticsWithToolUsage = {
		chatActivity: [],
		modelUsage: [],
		agentStats: [],
		extensionStats: [],
		userStats: { totalUsers: 0, activeUsers30d: 0, signupsLast30d: [] },
		toolUsage: {
			byTool: [
				{ toolName: "read_file", extensionId: "builtin", count: 42, successCount: 40, errorCount: 2 },
				{ toolName: "search",    extensionId: "ext-grep", count: 11, successCount: 11, errorCount: 0 },
			],
			byAgent: [
				{ agentConfigId: "a1", agentName: "Researcher", toolName: "read_file", count: 30 },
			],
			byUser: [
				{ userId: "u1", userName: "Alice", userEmail: "alice@test.local", toolName: "read_file", count: 25 },
			],
			byModel: [
				{ model: "claude-opus-4-7", provider: "anthropic", toolName: "read_file", count: 37 },
			],
		},
	};

	test("usage tab shows all four tool-usage rankings", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => adminMe,
				"/api/admin/analytics": () => analyticsWithToolUsage,
				"/api/admin/system": () => systemData,
			},
		});

		await page.goto("/admin/dashboard");
		await expect(page.getByRole("button", { name: "Usage" })).toBeVisible({ timeout: 5000 });
		await page.getByRole("button", { name: "Usage" }).click();

		// Section headings
		await expect(page.getByRole("heading", { name: "Top Tools by Call Count" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("heading", { name: "Top (Tool × Agent) Pairs" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("heading", { name: "Top (Tool × User) Pairs" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("heading", { name: "Top (Tool × Model) Pairs" })).toBeVisible({ timeout: 5000 });

		// byTool: tool name, extension id, error-count label, count value
		const byToolSection = page.getByTestId("tool-usage-by-tool");
		await expect(byToolSection.getByText("read_file")).toBeVisible();
		await expect(byToolSection.getByText("(builtin)")).toBeVisible();
		await expect(byToolSection.getByText("· 2 errors")).toBeVisible();
		await expect(byToolSection.getByText("42")).toBeVisible();

		// byAgent
		const byAgentSection = page.getByTestId("tool-usage-by-agent");
		await expect(byAgentSection.getByText("· Researcher")).toBeVisible();
		await expect(byAgentSection.getByText("30")).toBeVisible();

		// byUser
		const byUserSection = page.getByTestId("tool-usage-by-user");
		await expect(byUserSection.getByText("· Alice (alice@test.local)")).toBeVisible();
		await expect(byUserSection.getByText("25")).toBeVisible();

		// byModel
		const byModelSection = page.getByTestId("tool-usage-by-model");
		await expect(byModelSection.getByText("· claude-opus-4-7 (anthropic)")).toBeVisible();
		await expect(byModelSection.getByText("37")).toBeVisible();
	});

	test("usage tab shows empty states when no tool-usage data", async ({ page, mockApi }) => {
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
					toolUsage: { byTool: [], byAgent: [], byUser: [], byModel: [] },
				}),
				"/api/admin/system": () => systemData,
			},
		});

		await page.goto("/admin/dashboard");
		await page.getByRole("button", { name: "Usage" }).click();

		await expect(page.getByText("No tool calls in this period.")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("No agent-attributed tool calls in this period.")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("No user-attributed tool calls in this period.")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("No model-attributed tool calls in this period.")).toBeVisible({ timeout: 5000 });
	});

	test("pluralizes error label correctly (1 error, 2 errors)", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => adminMe,
				"/api/admin/analytics": () => ({
					chatActivity: [], modelUsage: [], agentStats: [], extensionStats: [],
					userStats: { totalUsers: 0, activeUsers30d: 0, signupsLast30d: [] },
					toolUsage: {
						byTool: [
							{ toolName: "single-err", extensionId: "builtin", count: 5, successCount: 4, errorCount: 1 },
							{ toolName: "plural-err", extensionId: "builtin", count: 7, successCount: 4, errorCount: 3 },
						],
						byAgent: [], byUser: [], byModel: [],
					},
				}),
				"/api/admin/system": () => systemData,
			},
		});

		await page.goto("/admin/dashboard");
		await page.getByRole("button", { name: "Usage" }).click();

		const byToolSection = page.getByTestId("tool-usage-by-tool");
		await expect(byToolSection.getByText("· 1 error")).toBeVisible();
		await expect(byToolSection.getByText("· 3 errors")).toBeVisible();
	});
});
