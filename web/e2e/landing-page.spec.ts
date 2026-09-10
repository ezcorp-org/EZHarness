import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const ACTIVE_PROJECT_KEY = "activeProjectId";
const LAST_PATH_KEY = "ezcorp-last-path";

// `/` used to be a landing-page composer. It is now the resume shell in
// `src/routes/+page.svelte`. The previous picker, input, and toolbar cases
// therefore map to the supported ways the shell chooses a safe destination:
// saved route, saved project, and the global workspace fallback. Conversation
// creation itself is covered from the project chat index in global-chat.spec.
test.describe("Root resume shell", () => {
	test("opens the global workspace when no resumable state exists", async ({ page, mockApi }) => {
		await mockApi({ projects: [] });

		await page.goto("/");

		await page.waitForURL(/\/project\/global\/chat$/);
	});

	test("opens the saved project chat when it is still available", async ({ page, mockApi }) => {
		const project = makeProject({ id: "proj-a", name: "Project A" });
		await mockApi({ projects: [project] });
		await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
			key: ACTIVE_PROJECT_KEY,
			value: project.id,
		});

		await page.goto("/");

		await page.waitForURL(new RegExp(`/project/${project.id}/chat$`));
	});

	test("restores a saved route before the saved project", async ({ page, mockApi }) => {
		const project = makeProject({ id: "proj-a", name: "Project A" });
		await mockApi({ projects: [project] });
		await page.addInitScript(({ lastPathKey, activeProjectKey, projectId }) => {
			localStorage.setItem(lastPathKey, "/agents?tab=teams");
			localStorage.setItem(activeProjectKey, projectId);
		}, { lastPathKey: LAST_PATH_KEY, activeProjectKey: ACTIVE_PROJECT_KEY, projectId: project.id });

		await page.goto("/");

		await page.waitForURL(/\/agents\?tab=teams$/);
		await expect(page.getByRole("link", { name: "+ New Team" })).toBeVisible();
	});

	test("drops a deleted saved project and falls back to Global", async ({ page, mockApi }) => {
		await mockApi({ projects: [] });
		await page.addInitScript(({ key }) => localStorage.setItem(key, "deleted-project"), {
			key: ACTIVE_PROJECT_KEY,
		});

		await page.goto("/");

		await page.waitForURL(/\/project\/global\/chat$/);
		await expect.poll(async () => page.evaluate((key) => localStorage.getItem(key), ACTIVE_PROJECT_KEY)).toBeNull();
	});

	test("does not resume a deleted project path when a saved project is valid", async ({ page, mockApi }) => {
		const project = makeProject({ id: "proj-a", name: "Project A" });
		await mockApi({ projects: [project] });
		await page.addInitScript(({ lastPathKey, activeProjectKey, projectId }) => {
			localStorage.setItem(lastPathKey, "/project/deleted-project/chat");
			localStorage.setItem(activeProjectKey, projectId);
		}, { lastPathKey: LAST_PATH_KEY, activeProjectKey: ACTIVE_PROJECT_KEY, projectId: project.id });

		await page.goto("/");

		await page.waitForURL(new RegExp(`/project/${project.id}/chat$`));
	});

	test("falls back to Global when the project lookup fails", async ({ page, mockApi }) => {
		await mockApi({ projects: [] });
		await page.route("**/api/projects", async (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			await route.abort("failed");
		});

		await page.goto("/");

		await page.waitForURL(/\/project\/global\/chat$/);
	});

	// `/pipelines` is the legacy path — it redirects to `/workflows`; both
	// destinations remain supported outside the removed landing surface.
	test("/agents and /pipelines load without console errors", async ({ page, mockApi }) => {
		const project = makeProject({ id: "proj-1", name: "Smoke Project" });
		await mockApi({ projects: [project] });

		for (const path of ["/agents", "/pipelines"]) {
			const errors: string[] = [];
			page.on("console", (msg) => {
				if (msg.type() === "error") errors.push(msg.text());
			});
			page.on("pageerror", (err) => errors.push(err.message));

			await page.goto(path);
			await expect(page.locator("body")).toBeVisible();

			const realErrors = errors.filter(
				(error) => !error.includes("WebSocket") && !error.includes("ERR_CONNECTION_REFUSED"),
			);
			expect(realErrors, `Console errors on ${path}: ${realErrors.join("\n")}`).toEqual([]);
		}
	});
});
