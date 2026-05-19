import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("MobileTabBar visibility", () => {
	test.use({ viewport: { width: 390, height: 844 } }); // iPhone 13-ish

	test("Mobile tab bar is visible on a normal project chat route", async ({ page, mockApi }) => {
		const proj = makeProject({ id: "proj-mtb-1", name: "Tab Bar Project" });
		await mockApi({ projects: [proj] });
		await page.goto(`/project/${proj.id}/chat`);

		const tabBar = page.getByRole("navigation", { name: "Mobile navigation" });
		await expect(tabBar).toBeVisible();
		await expect(tabBar.getByRole("link", { name: "Overview" })).toBeVisible();
		await expect(tabBar.getByRole("link", { name: "Chat" })).toBeVisible();
		await expect(tabBar.getByRole("link", { name: "Settings" })).toBeVisible();
	});

	test("Mobile tab bar is visible on the Global project too (regression: was hidden by isGlobalProject guard)", async ({ page, mockApi }) => {
		await mockApi({ projects: [] });
		await page.goto("/project/global/chat");

		const tabBar = page.getByRole("navigation", { name: "Mobile navigation" });
		await expect(tabBar).toBeVisible();
		await expect(tabBar.getByRole("link", { name: "Chat" })).toBeVisible();
	});
});
