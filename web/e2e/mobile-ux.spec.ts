import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeAgent, makeAgentConfig } from "./fixtures/data.js";

const mobile = { width: 375, height: 812 };
const desktop = { width: 1280, height: 800 };

const proj = makeProject({ id: "proj-1", name: "Test Project" });
const meAdmin = {
	user: { id: "user-1", email: "admin@test.local", name: "Admin", role: "admin" },
};
const meMember = {
	user: { id: "user-1", email: "user@test.local", name: "Test User", role: "member" },
};

const accountData = {
	id: "user-1",
	email: "user@test.local",
	name: "Test User",
	role: "member" as const,
	createdAt: "2026-01-15T00:00:00.000Z",
};

const sessionData = {
	sessions: [
		{
			id: "sess-1",
			userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)",
			ipAddress: "192.168.1.1",
			lastActiveAt: new Date().toISOString(),
			createdAt: "2026-03-01T00:00:00.000Z",
			isCurrent: true,
		},
		{
			id: "sess-2",
			userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120",
			ipAddress: "10.0.0.1",
			lastActiveAt: "2026-03-20T00:00:00.000Z",
			createdAt: "2026-03-01T00:00:00.000Z",
			isCurrent: false,
		},
	],
};

const testAgent = makeAgent({
	name: "test-agent",
	description: "A test agent",
	capabilities: ["test"],
	source: "config",
	id: "agent-1",
	prompt: "You are a test agent",
});

test.describe("Mobile UX", () => {
	test("admin dashboard shows card stacks on mobile", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);

		const analyticsData = {
			chatActivity: [],
			modelUsage: [],
			agentStats: [],
			extensionStats: [],
			userStats: { totalUsers: 10, activeUsers30d: 5, signupsLast30d: [] },
		};

		const systemData = {
			health: {
				dbSizeBytes: 1024000,
				uptimeSeconds: 3600,
				tableRowCounts: { conversations: 50, messages: 200, agents: 5, users: 10 },
			},
			activityFeed: [],
			errorSummary: {
				totalErrors: 3,
				errorRate: [],
				recentErrors: [
					{ id: "err-1", level: "error", message: "Test error", createdAt: "2026-03-24T00:00:00Z" },
				],
			},
		};

		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => meAdmin,
				"/api/admin/analytics": () => analyticsData,
				"/api/admin/system": () => systemData,
			},
		});

		await page.goto("/admin/dashboard");
		await expect(page.getByText("Admin Dashboard")).toBeVisible({ timeout: 5000 });

		// Switch to System tab to see card stacks
		await page.getByRole("button", { name: "System" }).click();

		// On mobile, resource grid should be hidden and MobileCardStack visible
		// MobileCardStack renders with md:hidden class
		const mobileCards = page.locator(".md\\:hidden");
		await expect(mobileCards.first()).toBeVisible({ timeout: 3000 });
	});

	test("account page sessions show as cards on mobile", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);

		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => meMember,
				"/api/account/sessions": () => sessionData,
				"/api/account/login-history": () => ({ entries: [] }),
				"/api/account": (url: URL) => {
					if (url.pathname === "/api/account/sessions") return sessionData;
					if (url.pathname === "/api/account/login-history") return { entries: [] };
					return accountData;
				},
			},
		});

		await page.goto("/account");
		// Wait for page load
		await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible({ timeout: 5000 });

		// Scroll to sessions section
		const sessionsHeading = page.getByRole("heading", { name: "Active Sessions" });
		await sessionsHeading.scrollIntoViewIfNeeded();
		await expect(sessionsHeading).toBeVisible({ timeout: 5000 });

		// Mobile session cards should be visible -- verify card-stack layout renders
		await expect(page.getByText("Device").first()).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("192.168.1.1", { exact: true })).toBeVisible();
		await expect(page.getByText("Current session", { exact: true })).toBeVisible();
	});

	test("breadcrumb shows on mobile for agent detail", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);

		await mockApi({
			projects: [proj],
			agents: [testAgent],
			routes: {
				"/api/auth/me": () => meMember,
			},
		});

		await page.goto("/agents/test-agent");
		await expect(page.getByText("test-agent").first()).toBeVisible({ timeout: 5000 });

		// Breadcrumb nav should be visible on mobile
		const breadcrumb = page.locator("nav[aria-label='Breadcrumb']");
		await expect(breadcrumb).toBeVisible();
		await expect(breadcrumb.getByText("Agents")).toBeVisible();
	});

	test("agent editor sections are collapsible on mobile", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);

		await mockApi({
			projects: [proj],
			agents: [testAgent],
			routes: {
				"/api/auth/me": () => meMember,
			},
		});

		await page.goto("/agents/test-agent");
		await expect(page.getByText("test-agent").first()).toBeVisible({ timeout: 5000 });

		// On mobile, collapsible sections use <details> elements
		const details = page.locator("details.md\\:hidden");
		const count = await details.count();
		expect(count).toBeGreaterThan(0);

		// Details should be open by default
		const firstDetails = details.first();
		await expect(firstDetails).toHaveAttribute("open", "");
	});

	test("desktop viewport hides mobile card stacks and shows tables", async ({ page, mockApi }) => {
		await page.setViewportSize(desktop);

		const analyticsData = {
			chatActivity: [],
			modelUsage: [],
			agentStats: [],
			extensionStats: [],
			userStats: { totalUsers: 10, activeUsers30d: 5, signupsLast30d: [] },
		};

		const systemData = {
			health: {
				dbSizeBytes: 1024000,
				uptimeSeconds: 3600,
				tableRowCounts: { conversations: 50, messages: 200, agents: 5, users: 10 },
			},
			activityFeed: [],
			errorSummary: {
				totalErrors: 3,
				errorRate: [],
				recentErrors: [
					{ id: "err-1", level: "error", message: "Test error", createdAt: "2026-03-24T00:00:00Z" },
				],
			},
		};

		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => meAdmin,
				"/api/admin/analytics": () => analyticsData,
				"/api/admin/system": () => systemData,
			},
		});

		await page.goto("/admin/dashboard");
		await expect(page.getByText("Admin Dashboard")).toBeVisible({ timeout: 5000 });

		await page.getByRole("button", { name: "System" }).click();

		// On desktop, md:hidden card stacks should NOT be visible
		const mobileCards = page.locator(".md\\:hidden");
		const mobileCount = await mobileCards.count();
		for (let i = 0; i < mobileCount; i++) {
			await expect(mobileCards.nth(i)).not.toBeVisible();
		}

		// On desktop, hidden md:block tables should be visible
		const desktopTables = page.locator(".hidden.md\\:block");
		const tableCount = await desktopTables.count();
		expect(tableCount).toBeGreaterThan(0);
		await expect(desktopTables.first()).toBeVisible();
	});

	test("breadcrumb links are clickable and navigate correctly", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);

		await mockApi({
			projects: [proj],
			agents: [testAgent],
			routes: {
				"/api/auth/me": () => meMember,
			},
		});

		await page.goto("/agents/test-agent");
		await expect(page.getByText("test-agent").first()).toBeVisible({ timeout: 5000 });

		const breadcrumb = page.locator("nav[aria-label='Breadcrumb']");
		await expect(breadcrumb).toBeVisible();

		// The "Agents" link should navigate back to agents list
		const agentsLink = breadcrumb.getByRole("link", { name: "Agents" });
		await expect(agentsLink).toBeVisible();
		await agentsLink.click();
		await expect(page).toHaveURL(/\/agents\/?$/);
	});

	test("breadcrumb has proper aria-label for accessibility", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);

		await mockApi({
			projects: [proj],
			agents: [testAgent],
			routes: {
				"/api/auth/me": () => meMember,
			},
		});

		await page.goto("/agents/test-agent");
		await expect(page.getByText("test-agent").first()).toBeVisible({ timeout: 5000 });

		// Verify aria-label="Breadcrumb" is set on the nav element
		const breadcrumb = page.locator("nav[aria-label='Breadcrumb']");
		await expect(breadcrumb).toBeVisible();
		await expect(breadcrumb).toHaveAttribute("aria-label", "Breadcrumb");

		// Verify breadcrumb contains an ordered list
		const ol = breadcrumb.locator("ol");
		await expect(ol).toBeVisible();
	});

	test("collapsible details sections can be toggled closed and reopened", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);

		await mockApi({
			projects: [proj],
			agents: [testAgent],
			routes: {
				"/api/auth/me": () => meMember,
			},
		});

		await page.goto("/agents/test-agent");
		await expect(page.getByText("test-agent").first()).toBeVisible({ timeout: 5000 });

		const details = page.locator("details.md\\:hidden");
		const count = await details.count();
		expect(count).toBeGreaterThan(0);

		const firstDetails = details.first();

		// Should be open by default
		await expect(firstDetails).toHaveAttribute("open", "");

		// Click summary to close
		const summary = firstDetails.locator("summary");
		await summary.click();
		await expect(firstDetails).not.toHaveAttribute("open", "");

		// Click summary to reopen
		await summary.click();
		await expect(firstDetails).toHaveAttribute("open", "");
	});

	test("settings audit log shows card stack on mobile", async ({ page, mockApi }) => {
		await page.setViewportSize(mobile);

		const auditEntries = [
			{ id: "aud-1", userId: "user-1", action: "auth:login", target: null, metadata: { ip: "1.2.3.4" }, createdAt: "2026-03-24T00:00:00Z" },
		];

		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => meAdmin,
				"/api/settings": () => ({}),
				"/api/users": () => ({ users: [] }),
				"/api/teams": () => ({ teams: [] }),
				"/api/auth/invite": () => ({ invites: [] }),
				"/api/audit-log": () => ({ entries: auditEntries }),
				"/api/admin/sessions": () => ({ sessions: [] }),
			},
		});

		await page.goto("/settings");
		// Wait for page to load then scroll to audit section
		await expect(page.getByRole("heading", { name: "Users" })).toBeVisible({ timeout: 5000 });

		const auditHeading = page.getByRole("heading", { name: "Audit Log" });
		await auditHeading.scrollIntoViewIfNeeded();
		await expect(auditHeading).toBeVisible({ timeout: 5000 });

		// Mobile card stack should show the audit entry within md:hidden container
		const mobileAudit = page.locator(".md\\:hidden").filter({ hasText: "auth:login" });
		await expect(mobileAudit.first()).toBeVisible({ timeout: 5000 });
	});
});
