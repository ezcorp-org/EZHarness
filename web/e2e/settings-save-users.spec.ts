/**
 * Phase 4 of the settings UX overhaul, end-to-end:
 *   - default tier auto-saves on click and survives a reload
 *     (stateful mock: PUT mutates the same store GET serves)
 *   - users search filters and paginates without a nested scrollbox
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });
const memberMe = {
	user: { id: "member-1", email: "member@test.local", name: "Member", role: "member" },
};
const adminMe = {
	user: { id: "admin-1", email: "admin@test.local", name: "Admin", role: "admin" },
};

test.describe("tier auto-save", () => {
	test("clicking a tier persists without a Save button and survives reload", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes: { "/api/auth/me": () => memberMe } });

		// Stateful settings mock layered over the generic fixture: PUT
		// writes into the same object GET serves, so a reload reflects
		// the persisted tier. (Registered after mockApi → matched first.)
		const settingsState: Record<string, unknown> = { "provider:defaultTier": "balanced" };
		await page.route("**/api/settings**", async (route) => {
			const req = route.request();
			if (req.method() === "PUT") {
				const key = decodeURIComponent(new URL(req.url()).pathname.replace("/api/settings/", ""));
				settingsState[key] = req.postDataJSON()?.value;
				return route.fulfill({ json: { ok: true } });
			}
			return route.fulfill({ json: settingsState });
		});

		await page.goto("/settings/models");

		// No legacy save buttons anywhere on the page.
		await expect(page.getByRole("button", { name: "Save Tier" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Save Order" })).toHaveCount(0);

		await page.locator("#tier").getByRole("button", { name: "Powerful" }).click();
		await expect(page.getByTestId("save-indicator-saved").first()).toBeVisible();

		await page.reload();
		await expect(page.locator("#tier").getByRole("button", { name: "Powerful" })).toHaveClass(/bg-blue-600/);
	});
});

test.describe("users search + pagination", () => {
	const users = Array.from({ length: 25 }, (_, i) => ({
		id: `u${i}`,
		email: `user${i}@test.local`,
		name: `User ${i}`,
		role: "member",
		status: "active",
	}));

	const routes = {
		"/api/auth/me": () => adminMe,
		"/api/users": () => ({ users }),
		"/api/admin/sessions": () => ({ sessions: [] }),
		"/api/teams": () => ({ teams: [] }),
		"/api/auth/invite": () => ({ invites: [] }),
		"/api/audit-log": () => ({ entries: [], total: 0 }),
		"/api/health": () => ({ status: "healthy", db: { status: "up" }, embeddings: { status: "ready" }, providers: {} }),
	};

	test("search filters; pagination shows 20 then loads the rest", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], routes });
		await page.goto("/settings/admin");

		const usersSection = page.locator("#users");
		await expect(usersSection.getByText("User 0", { exact: true })).toBeVisible();
		await expect(usersSection.getByText("User 19", { exact: true })).toBeVisible();
		await expect(usersSection.getByText("User 24", { exact: true })).not.toBeVisible();

		await page.getByTestId("users-load-more").click();
		await expect(usersSection.getByText("User 24", { exact: true })).toBeVisible();
		await expect(page.getByTestId("users-load-more")).not.toBeVisible();

		await page.getByTestId("users-search").fill("user13@test.local");
		await expect(usersSection.getByText("User 13", { exact: true })).toBeVisible();
		await expect(usersSection.getByText("User 0", { exact: true })).not.toBeVisible();

		// Default member/active/no-session rows carry no badge noise.
		await expect(usersSection.getByText("member", { exact: true })).toHaveCount(0);
		await expect(usersSection.getByText("active", { exact: true })).toHaveCount(0);
	});
});
