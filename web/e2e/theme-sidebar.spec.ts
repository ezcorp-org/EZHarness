import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });

test.describe("Theme", () => {
	test("theme toggle button is visible", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/");

		await expect(
			page.getByRole("button", { name: "Toggle theme" }).first(),
		).toBeVisible();
	});

	test("toggle dark to light removes .dark class", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/");

		// Default should be dark (FOUC script adds .dark when no stored preference
		// and prefers-color-scheme matches, or Playwright default)
		await expect(page.locator("html")).toHaveClass(/dark/);

		await page.getByRole("button", { name: "Toggle theme" }).first().click();

		await expect(page.locator("html")).not.toHaveClass(/dark/);
	});

	test("toggle light to dark adds .dark class", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });

		// Pre-set light theme before navigation so the FOUC script picks it up
		await page.addInitScript(() => {
			localStorage.setItem("ezcorp-theme", "light");
		});
		await page.goto("/");

		await expect(page.locator("html")).not.toHaveClass(/dark/);

		await page.getByRole("button", { name: "Toggle theme" }).first().click();

		await expect(page.locator("html")).toHaveClass(/dark/);
	});

	test("theme persists in localStorage", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/");

		// Toggle away from default
		await page.getByRole("button", { name: "Toggle theme" }).first().click();

		const stored = await page.evaluate(() => localStorage.getItem("ezcorp-theme"));
		expect(stored).toBeTruthy();
		expect(["dark", "light"]).toContain(stored);
	});

	test("FOUC prevention script sets .dark before hydration", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });

		// Set dark preference so the inline script in app.html adds .dark
		await page.addInitScript(() => {
			localStorage.setItem("ezcorp-theme", "dark");
		});

		// Intercept before Svelte hydration: check .dark is present on DOMContentLoaded
		const hasDarkBeforeHydration = await new Promise<boolean>((resolve) => {
			page.on("domcontentloaded", async () => {
				const result = await page.evaluate(() =>
					document.documentElement.classList.contains("dark"),
				);
				resolve(result);
			});
			page.goto("/");
		});

		expect(hasDarkBeforeHydration).toBe(true);
	});
});

test.describe("Sidebar", () => {
	test("collapse button hides sidebar", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/");

		const sidebar = page.locator("aside").first();
		await expect(sidebar).toBeVisible();

		await page.getByRole("button", { name: "Collapse sidebar" }).click();

		// After collapse the aside gets w-0 and the expand button appears
		await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
	});

	test("expand after collapse restores sidebar", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/");

		// Collapse
		await page.getByRole("button", { name: "Collapse sidebar" }).click();
		await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

		// Expand
		await page.getByRole("button", { name: "Expand sidebar" }).click();

		// Sidebar content should be visible again
		const sidebar = page.locator("aside").first();
		await expect(sidebar).toBeVisible();
		await expect(sidebar.getByText("Dashboard")).toBeVisible();
	});

	test("Ctrl+\\ shortcut toggles sidebar", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/");

		const sidebar = page.locator("aside").first();
		await expect(sidebar).toBeVisible();

		// Press Ctrl+\ to collapse
		await page.keyboard.press("Control+\\");
		await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

		// Press again to expand
		await page.keyboard.press("Control+\\");
		await expect(sidebar.getByText("Dashboard")).toBeVisible();
	});

	test("collapsed state persists in localStorage", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/");

		await page.getByRole("button", { name: "Collapse sidebar" }).click();

		const stored = await page.evaluate(() =>
			localStorage.getItem("pi-sidebar-collapsed"),
		);
		expect(stored).toBe("true");
	});

	test("mobile hamburger button appears on small viewport", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.setViewportSize({ width: 375, height: 667 });
		await page.goto("/");

		await expect(
			page.getByRole("button", { name: "Open menu" }),
		).toBeVisible();

		// Desktop sidebar should be hidden on mobile
		const sidebar = page.locator("aside.hidden.md\\:flex");
		await expect(sidebar).toBeHidden();
	});

	test("mobile drawer opens on hamburger click", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.setViewportSize({ width: 375, height: 667 });
		await page.goto("/");

		await page.getByRole("button", { name: "Open menu" }).click();

		// The overlay drawer should appear with navigation links
		const drawer = page.locator(".fixed.inset-0");
		await expect(drawer).toBeVisible();
		await expect(drawer.getByText("Dashboard")).toBeVisible();
	});

	test("mobile drawer closes on backdrop click", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.setViewportSize({ width: 375, height: 667 });
		await page.goto("/");

		await page.getByRole("button", { name: "Open menu" }).click();

		const drawer = page.locator(".fixed.inset-0");
		await expect(drawer).toBeVisible();

		// Click the backdrop to close the drawer
		const backdrop = page.getByTestId("swipe-drawer-backdrop");
		await backdrop.click({ force: true });

		await expect(drawer).toBeHidden();
	});
});
