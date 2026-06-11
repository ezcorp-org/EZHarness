import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Admin Force Logout", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });

	const adminMe = {
		user: { id: "user-1", email: "admin@test.local", name: "Test Admin", role: "admin" },
	};

	const usersData = {
		users: [
			{ id: "user-2", email: "member@test.local", name: "Member User", role: "member", status: "active", createdAt: "2026-01-01T00:00:00Z" },
		],
	};

	const adminSessionsData = {
		sessions: [
			{ id: "s1", userId: "user-2", userName: "Member User", userEmail: "member@test.local", userAgent: "Mozilla", ipAddress: "1.2.3.4", lastActiveAt: "2026-03-23T12:00:00Z", createdAt: "2026-03-23T10:00:00Z" },
		],
	};

	const defaultRoutes = {
		"/api/auth/me": () => adminMe,
		"/api/users": () => usersData,
		"/api/admin/sessions": () => adminSessionsData,
		"/api/settings": () => ({}),
		"/api/teams": () => ({ teams: [] }),
		"/api/auth/invite": () => ({ invites: [] }),
		"/api/audit-log": () => ({ entries: [], total: 0 }),
		"/api/health": () => ({ status: "ok", subsystems: {} }),
	};

	test("shows user list with session count and action buttons", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: defaultRoutes,
		});

		await page.goto("/settings/admin");

		// Verify user list loads with session count
		await expect(page.getByText("Member User")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("member@test.local")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("1 sessions")).toBeVisible({ timeout: 5000 });

		// Force Logout button appears for users with active sessions
		await expect(page.getByText("Force Logout")).toBeVisible({ timeout: 5000 });

		// Other user management buttons present
		await expect(page.getByText("Reset Password")).toBeVisible();
	});

	test("hides Force Logout when user has no sessions", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				...defaultRoutes,
				// No sessions for this user
				"/api/admin/sessions": () => ({ sessions: [] }),
			},
		});

		await page.goto("/settings/admin");

		// User loads but Force Logout is hidden (no sessions)
		await expect(page.getByText("Member User")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Force Logout")).not.toBeVisible({ timeout: 3000 });
	});
});
