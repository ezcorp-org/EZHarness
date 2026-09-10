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
		const settings: Record<string, string> = {
			"global:systemPrompt": "Existing global instruction",
			[`project:${proj.id}:systemPrompt`]: "Existing project instruction",
		};
		let releaseProjectSave!: () => void;
		const projectSaveHeld = new Promise<void>((resolve) => { releaseProjectSave = resolve; });
		let releaseGlobalSave!: () => void;
		const globalSaveHeld = new Promise<void>((resolve) => { releaseGlobalSave = resolve; });
		let releaseUpdate!: () => void;
		const updateHeld = new Promise<void>((resolve) => { releaseUpdate = resolve; });
		await mockApi({ projects: [proj], settings });
		await page.route("**/api/settings", (route) => route.fulfill({ json: settings }));
		await page.route(`**/api/settings/project:${proj.id}:systemPrompt`, async (route) => {
			await projectSaveHeld;
			settings[`project:${proj.id}:systemPrompt`] = (route.request().postDataJSON() as { value: string }).value;
			await route.fulfill({ json: { ok: true } });
		});
		await page.route("**/api/settings/global:systemPrompt", async (route) => {
			await globalSaveHeld;
			settings["global:systemPrompt"] = (route.request().postDataJSON() as { value: string }).value;
			await route.fulfill({ json: { ok: true } });
		});
		await page.route(`**/api/projects/${proj.id}`, async (route) => {
			if (route.request().method() !== "PUT") return route.fallback();
			await updateHeld;
			Object.assign(proj, route.request().postDataJSON());
			await route.fulfill({ json: proj });
		});
		await page.route("**/api/integrations/github-projects/link**", (route) =>
			route.fulfill({ status: 404, json: { error: "No connected board" } }),
		);

		await page.goto(`/project/${proj.id}/settings`);
		await expect(page.getByRole("main").getByRole("img", { name: "Settings Project" })).toBeVisible();
		await expect(page.getByTestId("project-settings-gh-status")).toHaveText("Not connected");

		const projectInstructions = page.getByPlaceholder("e.g. You are a coding assistant for this project...");
		const projectSaveButton = projectInstructions.locator("xpath=following-sibling::div[1]//button");
		await projectInstructions.fill("Project instructions updated by the user");
		const projectSaveResponse = page.waitForResponse((response) =>
			new URL(response.url()).pathname === `/api/settings/project:${proj.id}:systemPrompt`
			&& response.request().method() === "PUT",
		);
		await projectSaveButton.click();
		await expect(projectSaveButton).toBeDisabled();
		await expect(projectSaveButton).toHaveText("Saving...");
		releaseProjectSave();
		const projectSave = await projectSaveResponse;
		expect(projectSave.status()).toBe(200);
		expect(projectSave.request().postDataJSON()).toEqual({ value: "Project instructions updated by the user" });
		await expect(projectSaveButton).toBeEnabled();
		await expect(page.getByTestId("save-indicator-saved")).toHaveCount(1);

		const globalInstructions = page.getByPlaceholder("e.g. You are a helpful AI assistant...");
		const globalSaveButton = globalInstructions.locator("xpath=following-sibling::div[1]//button");
		await globalInstructions.fill("Global instructions updated by the user");
		const globalSaveResponse = page.waitForResponse((response) =>
			new URL(response.url()).pathname === "/api/settings/global:systemPrompt"
			&& response.request().method() === "PUT",
		);
		await globalSaveButton.click();
		await expect(globalSaveButton).toBeDisabled();
		await expect(globalSaveButton).toHaveText("Saving...");
		releaseGlobalSave();
		const globalSave = await globalSaveResponse;
		expect(globalSave.status()).toBe(200);
		expect(globalSave.request().postDataJSON()).toEqual({ value: "Global instructions updated by the user" });
		await expect(globalSaveButton).toBeEnabled();
		await expect(page.getByTestId("save-indicator-saved")).toHaveCount(2);

		const updateButton = page.locator("form button[type=submit]");
		await page.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed Settings Project");
		const updateResponse = page.waitForResponse((response) =>
			new URL(response.url()).pathname === `/api/projects/${proj.id}` && response.request().method() === "PUT",
		);
		await updateButton.click();
		await expect(updateButton).toBeDisabled();
		await expect(updateButton).toHaveText("Saving...");
		releaseUpdate();
		const update = await updateResponse;
		expect(update.status()).toBe(200);
		expect(update.request().postDataJSON()).toMatchObject({ name: "Renamed Settings Project", path: proj.path });
		await expect(page.getByTestId("save-indicator-saved")).toHaveCount(3);
		await page.reload();
		await expect(projectInstructions).toHaveValue("Project instructions updated by the user");
		await expect(globalInstructions).toHaveValue("Global instructions updated by the user");
		await expect(page.getByRole("heading", { name: "Renamed Settings Project", exact: true })).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Renamed Settings Project");
	});


	test("shows a project-instruction save error and permits a native retry", async ({ page, mockApi }) => {
		const proj = makeProject({ id: "proj-settings-retry", name: "Retry Settings Project" });
		let saves = 0;
		await mockApi({ projects: [proj] });
		await page.route(`**/api/settings/project:${proj.id}:systemPrompt`, (route) => {
			saves += 1;
			return route.fulfill(saves === 1
				? { status: 500, json: { error: "Save refused" } }
				: { json: { ok: true } });
		});

		await page.goto(`/project/${proj.id}/settings`);
		const instructions = page.getByPlaceholder("e.g. You are a coding assistant for this project...");
		const saveButton = instructions.locator("xpath=following-sibling::div[1]//button");
		await instructions.fill("Retry this project instruction");
		await saveButton.click();
		await expect(page.getByTestId("save-indicator-error")).toHaveText("Save failed — try again");
		await expect(saveButton).toBeEnabled();

		const retried = page.waitForResponse((response) =>
			new URL(response.url()).pathname === `/api/settings/project:${proj.id}:systemPrompt`
			&& response.request().method() === "PUT" && response.status() === 200,
		);
		await saveButton.click();
		await retried;
		await expect(page.getByTestId("save-indicator-saved")).toHaveCount(1);
		expect(saves).toBe(2);
	});

	test("keeps settings usable when the integration check fails and deletes the project", async ({ page, mockApi }) => {
		const proj = makeProject({ id: "proj-settings-delete", name: "Delete Settings Project" });
		await mockApi({ projects: [proj] });
		await page.route("**/api/integrations/github-projects/link**", (route) => route.abort("failed"));

		await page.goto(`/project/${proj.id}/settings`);
		await expect(page.getByTestId("project-settings-gh-status")).toHaveText("Not connected");
		page.once("dialog", (dialog) => dialog.accept());
		const [deleted] = await Promise.all([
			page.waitForResponse((response) =>
				new URL(response.url()).pathname === `/api/projects/${proj.id}` && response.request().method() === "DELETE",
			),
			page.getByRole("button", { name: "Delete", exact: true }).click(),
		]);
		expect(deleted.status()).toBe(200);
		await expect(page).toHaveURL(/\/$/);
		await expect(page.getByRole("button", { name: "Delete Settings Project", exact: true })).toHaveCount(0);
	});
});
