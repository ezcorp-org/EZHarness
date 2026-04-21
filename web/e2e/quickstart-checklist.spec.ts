import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("QuickStart Checklist", () => {
	const proj = makeProject({ id: "proj-1", name: "QS Project" });

	test.beforeEach(async ({ page }) => {
		// Clear localStorage to ensure checklist is not dismissed
		await page.addInitScript(() => {
			localStorage.removeItem("pi-quickstart");
			localStorage.removeItem("pi-quickstart-chat");
			localStorage.removeItem("pi-quickstart-extension");
		});
	});

	test("quickstart shows in sidebar", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });

		await page.goto(`/project/${proj.id}`);

		// "Get Started" text should appear in the sidebar
		await expect(page.getByText("Get Started")).toBeVisible({ timeout: 5000 });
	});

	test("shows 0/4 progress initially", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });

		await page.goto(`/project/${proj.id}`);

		// Progress should show 0/4
		await expect(page.getByText("0/4")).toBeVisible({ timeout: 5000 });
	});

	test("dismiss button hides checklist", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });

		await page.goto(`/project/${proj.id}`);

		await expect(page.getByText("Get Started")).toBeVisible({ timeout: 5000 });

		// Click dismiss button
		await page.getByRole("button", { name: "Dismiss checklist" }).click();

		// Checklist should disappear
		await expect(page.getByText("Get Started")).not.toBeVisible({ timeout: 3000 });
	});

	test("collapse/expand toggle", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });

		await page.goto(`/project/${proj.id}`);

		// Steps should be visible initially
		await expect(page.getByText("Set up a provider")).toBeVisible({ timeout: 5000 });

		// Click "Get Started" to collapse
		await page.getByRole("button", { name: /Get Started/ }).click();

		// Steps should be hidden
		await expect(page.getByText("Set up a provider")).not.toBeVisible({ timeout: 3000 });

		// Click again to expand
		await page.getByRole("button", { name: /Get Started/ }).click();

		// Steps should be visible again
		await expect(page.getByText("Set up a provider")).toBeVisible({ timeout: 3000 });
	});

	test("step links navigate correctly", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });

		await page.goto(`/project/${proj.id}`);

		await expect(page.getByText("Set up a provider")).toBeVisible({ timeout: 5000 });

		// Click "Set up a provider" link
		await page.getByRole("link", { name: "Set up a provider" }).click();

		// Should navigate to settings
		await expect(page).toHaveURL(/\/settings/);
	});
});
