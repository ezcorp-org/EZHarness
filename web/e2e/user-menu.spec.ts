import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("User Menu Dropdown", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });

	const meResponse = {
		user: { id: "user-1", email: "user@test.local", name: "Test User", role: "member" },
	};

	test("user menu button is visible when authenticated", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => meResponse,
			},
		});

		await page.goto(`/project/${proj.id}`);

		const userMenuButton = page.locator(".user-menu-container button");
		await expect(userMenuButton).toBeVisible({ timeout: 5000 });
	});

	test("clicking user menu opens dropdown with Account and Logout", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => meResponse,
			},
		});

		await page.goto(`/project/${proj.id}`);

		const userMenuButton = page.locator(".user-menu-container button");
		await expect(userMenuButton).toBeVisible({ timeout: 5000 });

		await userMenuButton.click();

		await expect(page.getByRole("link", { name: "Account" })).toBeVisible({ timeout: 3000 });
		await expect(page.getByRole("button", { name: "Logout" })).toBeVisible();
	});

	test("Account link navigates to /account", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => meResponse,
				"/api/account": () => ({
					id: "user-1",
					email: "user@test.local",
					name: "Test User",
					role: "member",
					createdAt: "2026-01-01T00:00:00.000Z",
				}),
			},
		});

		await page.goto(`/project/${proj.id}`);

		const userMenuButton = page.locator(".user-menu-container button");
		await expect(userMenuButton).toBeVisible({ timeout: 5000 });
		await userMenuButton.click();

		await page.getByRole("link", { name: "Account" }).click();

		await expect(page).toHaveURL(/\/account/);
	});

	test("clicking outside closes the dropdown", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => meResponse,
			},
		});

		await page.goto(`/project/${proj.id}`);

		const userMenuButton = page.locator(".user-menu-container button");
		await expect(userMenuButton).toBeVisible({ timeout: 5000 });

		// Open menu
		await userMenuButton.click();
		await expect(page.getByRole("link", { name: "Account" })).toBeVisible({ timeout: 3000 });

		// Click outside the menu
		await page.locator("main").first().click({ force: true });

		// Menu should close
		await expect(page.getByRole("link", { name: "Account" })).not.toBeVisible({ timeout: 3000 });
	});

	test("Logout button redirects to login", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => meResponse,
			},
		});

		await page.route("**/api/auth/logout", (route) => {
			return route.fulfill({ json: { success: true } });
		});

		await page.goto(`/project/${proj.id}`);

		const userMenuButton = page.locator(".user-menu-container button");
		await expect(userMenuButton).toBeVisible({ timeout: 5000 });

		await userMenuButton.click();
		await page.getByRole("button", { name: "Logout" }).click();

		await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
	});
});
