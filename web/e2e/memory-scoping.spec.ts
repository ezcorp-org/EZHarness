import { test, expect } from "./fixtures/test-base.js";
import { selectMemoryScope } from "./fixtures/memories.js";
import { makeProject, makeMemory } from "./fixtures/data.js";

test.describe("Memory Scoping", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("activeProjectId", "proj-1"));
	});
	const proj = makeProject({ id: "proj-1", name: "Scoping Project" });
	const globalMem1 = makeMemory({ id: "g1", content: "Global org-wide preference", projectId: null, category: "preferences" });
	const globalMem2 = makeMemory({ id: "g2", content: "Global technical note", projectId: null, category: "technical" });
	const projMem1 = makeMemory({ id: "p1", content: "Project-specific config", projectId: "proj-1", category: "technical" });
	const projMem2 = makeMemory({ id: "p2", content: "Project decision log", projectId: "proj-1", category: "decisions_goals" });
	const allMemories = [globalMem1, globalMem2, projMem1, projMem2];

	test("global memories show Org-wide badge", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
		});
		await page.goto("/memories");

		const globalRow = page.getByText("Global org-wide preference").locator("..");
		await expect(globalRow.getByText("Org-wide", { exact: true })).toBeVisible();
	});

	test("project memories show Project badge", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
		});
		await page.goto("/memories");

		const projectRow = page.getByText("Project-specific config").locator("..");
		await expect(projectRow.getByText("1 project", { exact: true })).toBeVisible();
	});

	test("scope filter section with All, This Project, Org-wide buttons is visible", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
		});
		await page.goto("/memories");

		await expect(page.getByText("Scope:", { exact: true }).locator("..").getByRole("button", { name: "All", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "This Project" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Org-wide" })).toBeVisible();
	});

	test("Scope label is visible", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
		});
		await page.goto("/memories");

		await expect(page.getByText("Scope:")).toBeVisible();
	});

	test("clicking Org-wide scope filter shows only global memories", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
		});
		await page.goto("/memories");

		await selectMemoryScope(page, "global", proj.id);

		await expect(page.getByText("Global org-wide preference")).toBeVisible();
		await expect(page.getByText("Global technical note")).toBeVisible();
		await expect(page.getByText("Project-specific config")).not.toBeVisible();
		await expect(page.getByText("Project decision log")).not.toBeVisible();
	});

	test("clicking This Project scope filter shows only project memories", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
		});
		await page.goto("/memories");

		await selectMemoryScope(page, "project", proj.id);

		await expect(page.getByText("Project-specific config")).toBeVisible();
		await expect(page.getByText("Project decision log")).toBeVisible();
		await expect(page.getByText("Global org-wide preference")).not.toBeVisible();
		await expect(page.getByText("Global technical note")).not.toBeVisible();
	});

	test("clicking All scope filter shows both project and global memories", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
		});
		await page.goto("/memories");

		// First filter to Org-wide to change state
		await selectMemoryScope(page, "global", proj.id);

		// Then click All to show everything
		await selectMemoryScope(page, "all", proj.id);

		await expect(page.getByText("Global org-wide preference")).toBeVisible();
		await expect(page.getByText("Global technical note")).toBeVisible();
		await expect(page.getByText("Project-specific config")).toBeVisible();
		await expect(page.getByText("Project decision log")).toBeVisible();
	});

	test("add memory form offers project and org-wide scopes", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
		});
		await page.goto("/memories");

		// Open add memory form
		await page.getByTestId("add-memory-toggle").click();

		const scopeSelector = page.getByTestId("add-memory-form").getByTestId("project-picker");
		await expect(scopeSelector).toBeVisible();
		await scopeSelector.getByTestId("open-project-picker").click();
		await expect(page.getByTestId("project-picker-item-proj-1")).toBeVisible();
		await expect(page.getByTestId("project-picker-global")).toBeVisible();
	});

	test("add memory scope defaults to the active project", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
		});
		await page.goto("/memories");

		await page.getByTestId("add-memory-toggle").click();

		await expect(page.getByTestId("add-memory-form").getByTestId("open-project-picker")).toHaveText("1 project");
	});
});
