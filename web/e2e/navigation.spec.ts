import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Navigation", () => {
	const proj = makeProject({ id: "proj-1", name: "Nav Project" });

	test("sidebar shows default nav links without project", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/");

		const sidebar = page.locator("aside");
		await expect(sidebar.getByText("Dashboard")).toBeVisible();
		await expect(sidebar.getByText("Workflows")).toBeVisible();
		await expect(sidebar.getByText("New Agent")).toBeVisible();
	});

	test("sidebar shows project nav links with active project", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto(`/project/${proj.id}`);

		const sidebar = page.locator("aside");
		await expect(sidebar.getByText("Dashboard")).toBeVisible();
		await expect(sidebar.getByText("Chat")).toBeVisible();
		await expect(sidebar.getByText("Settings")).toBeVisible();
		await expect(sidebar.getByText("Workflows")).toBeVisible();
	});

	test("sidebar shows project name when project is active", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto(`/project/${proj.id}`);

		await expect(page.locator("aside h1")).toContainText("Nav Project");
	});

	test("clicking sidebar links navigates correctly", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto(`/project/${proj.id}`);

		await page.locator("aside").getByText("Chat").click();
		await expect(page).toHaveURL(`/project/${proj.id}/chat`);
	});

	test("connection status indicator is visible", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/");

		// The status dot should be present (red or green)
		await expect(page.locator("aside span.rounded-full")).toBeVisible();
	});
});
