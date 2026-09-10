import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Navigation", () => {
	const proj = makeProject({ id: "proj-1", name: "Nav Project" });

	test("global sidebar links point to the supported destinations", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [] });
		await page.goto("/");
		const sidebar = page.getByRole("navigation", { name: "Main navigation", exact: true });
		for (const [name, href] of [["Chat", "/project/global/chat"], ["Workflows", "/workflows"], ["Agents", "/agents"]] as const) {
			const link = sidebar.getByRole("link", { name, exact: true });
			await expect(link).toBeVisible();
			await expect(link).toHaveAttribute("href", href);
		}
	});

	test("project sidebar links preserve project scope", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [] });
		await page.goto(`/project/${proj.id}`);
		const sidebar = page.getByRole("navigation", { name: "Main navigation", exact: true });
		for (const [name, href] of [["Chat", `/project/${proj.id}/chat`], ["Project Settings", `/project/${proj.id}/settings`], ["Workflows", "/workflows"]] as const) {
			const link = sidebar.getByRole("link", { name, exact: true });
			await expect(link).toBeVisible();
			await expect(link).toHaveAttribute("href", href);
		}
	});

	test("sidebar shows the active project name", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [] });
		await page.goto(`/project/${proj.id}`);
		await expect(page.getByTestId("active-context-name")).toHaveText("Nav Project");
	});

	test("sidebar links navigate away and return to the same project", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [] });
		await page.goto(`/project/${proj.id}`);
		const sidebar = page.getByRole("navigation", { name: "Main navigation", exact: true });
		await sidebar.getByRole("link", { name: "Agents", exact: true }).click();
		await expect(page).toHaveURL("/agents");
		await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
		await sidebar.getByRole("link", { name: "Chat", exact: true }).click();
		await expect(page).toHaveURL(`/project/${proj.id}/chat`);
		await expect(page.getByTestId("active-context-name")).toHaveText("Nav Project");
	});

	test("connection status has an accessible connected label", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [] });
		await page.goto("/");
		await expect(page.locator("aside").getByTitle("Connected", { exact: true })).toBeVisible();
	});
});
