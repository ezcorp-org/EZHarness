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

		await expect(page.getByRole("button", { name: "Alpha", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Beta", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Beta", exact: true }).click();
		await expect(page).toHaveURL(/\/project\/p2\/chat/);
		await expect(page.getByTestId("active-context-name")).toHaveText("Beta");
	});

	test("project settings page loads", async ({ page, mockApi }) => {
		const proj = makeProject({ id: "proj-1", name: "Settings Project" });
		await mockApi({ projects: [proj] });
		await page.goto(`/project/${proj.id}/settings`);

		await expect(page.getByRole("heading", { name: "Settings Project", exact: true })).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Settings Project");
		await expect(page.getByRole("button", { name: "Update", exact: true })).toBeEnabled();
	});

	test("project settings saves both instruction scopes and updates the project", async ({ page, mockApi }) => {
		const proj = makeProject({
			id: "proj-settings-actions",
			name: "Settings Project",
			icon: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
		});
		await mockApi({
			projects: [proj],
			settings: {
				"global:systemPrompt": "Existing global instruction",
				[`project:${proj.id}:systemPrompt`]: "Existing project instruction",
			},
		});
		await page.route("**/api/integrations/github-projects/link**", (route) =>
			route.fulfill({ status: 404, json: { error: "No connected board" } }),
		);

		await page.goto(`/project/${proj.id}/settings`);
		await expect(page.getByRole("main").getByRole("img", { name: "Settings Project" })).toBeVisible();
		await expect(page.getByTestId("project-settings-gh-status")).toHaveText("Not connected");

		const projectInstructions = page.getByPlaceholder("e.g. You are a coding assistant for this project...");
		await projectInstructions.fill("Project instructions updated by the user");
		const [projectSave] = await Promise.all([
			page.waitForRequest((request) =>
				new URL(request.url()).pathname === `/api/settings/project:${proj.id}:systemPrompt`
				&& request.method() === "PUT",
			),
			page.getByRole("button", { name: "Save Project Instructions" }).click(),
		]);
		expect(projectSave.postDataJSON()).toEqual({ value: "Project instructions updated by the user" });

		const globalInstructions = page.getByPlaceholder("e.g. You are a helpful AI assistant...");
		await globalInstructions.fill("Global instructions updated by the user");
		const [globalSave] = await Promise.all([
			page.waitForRequest((request) =>
				new URL(request.url()).pathname === "/api/settings/global:systemPrompt"
				&& request.method() === "PUT",
			),
			page.getByRole("button", { name: "Save Global Instructions" }).click(),
		]);
		expect(globalSave.postDataJSON()).toEqual({ value: "Global instructions updated by the user" });

		await page.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed Settings Project");
		const [update] = await Promise.all([
			page.waitForRequest((request) =>
				new URL(request.url()).pathname === `/api/projects/${proj.id}` && request.method() === "PUT",
			),
			page.getByRole("button", { name: "Update", exact: true }).click(),
		]);
		expect(update.postDataJSON()).toMatchObject({ name: "Renamed Settings Project", path: proj.path });
	});
});
