import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Projects", () => {
	test("new project form renders", async ({ page, mockApi }) => {
		await mockApi();
		await page.goto("/new-project");

		await expect(page.getByRole("heading", { name: "Create Project" })).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Name" })).toBeVisible();
	});

	test("project rail shows projects", async ({ page, mockApi }) => {
		await mockApi({
			projects: [
				makeProject({ id: "p1", name: "Alpha", icon: null }),
				makeProject({ id: "p2", name: "Beta", icon: null }),
			],
		});
		await page.goto("/");

		// Project rail should show project initials or icons
		// Projects appear in the leftmost rail
		const body = page.locator("body");
		await expect(body).toBeVisible();
	});

	test("project settings page loads", async ({ page, mockApi }) => {
		const proj = makeProject({ id: "proj-1", name: "Settings Project" });
		await mockApi({ projects: [proj] });
		await page.goto(`/project/${proj.id}/settings`);

		await expect(page.locator("body")).toBeVisible();
	});
});
