import { test, expect } from "./fixtures/test-base.js";
import { expectThemeColor } from "./fixtures/theme.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Error Pages", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });

	test("404 page renders for unknown route", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => ({
					user: { id: "u-1", email: "a@b.c", name: "U", role: "member" },
				}),
			},
		});

		await page.goto("/this-route-does-not-exist");

		await expect(page.getByText("404")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Page not found")).toBeVisible();
	});

	test("404 page follows the light and dark surface themes", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => ({
					user: { id: "u-1", email: "a@b.c", name: "U", role: "member" },
				}),
			},
		});

		await page.goto("/this-route-does-not-exist");

		await expect(page.getByText("404")).toBeVisible({ timeout: 5000 });

		const container = page.locator(".min-h-screen");
		await expect(container).toBeVisible();
		for (const colorScheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme });
			await expectThemeColor(container, "background-color", "--color-surface");
			await expectThemeColor(page.getByRole("heading", { name: "Page not found" }), "color", "--color-text-primary");
		}
	});

	test("404 Go home link navigates to root", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => ({
					user: { id: "u-1", email: "a@b.c", name: "U", role: "member" },
				}),
			},
		});

		await page.goto("/this-route-does-not-exist");

		await expect(page.getByText("Go home")).toBeVisible({ timeout: 5000 });

		await page.getByRole("link", { name: "Go home" }).click();

		await expect(page).toHaveURL("/");
	});

	test("error page shows action button", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/auth/me": () => ({
					user: { id: "u-1", email: "a@b.c", name: "U", role: "member" },
				}),
			},
		});

		await page.goto("/this-route-does-not-exist");

		await expect(page.getByText("404")).toBeVisible({ timeout: 5000 });

		// Should have an action button (Go home or Go back)
		const actionButton = page.locator("a, button").filter({ hasText: /go home|go back/i });
		await expect(actionButton.first()).toBeVisible();
	});
});
