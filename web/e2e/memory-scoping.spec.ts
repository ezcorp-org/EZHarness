import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeMemory } from "./fixtures/data.js";

test.describe("Memory Scoping", () => {
	const proj = makeProject({ id: "proj-1", name: "Scoping Project" });
	const globalMem1 = makeMemory({ id: "g1", content: "Global org-wide preference", projectId: null, category: "preferences" });
	const globalMem2 = makeMemory({ id: "g2", content: "Global technical note", projectId: null, category: "technical" });
	const projMem1 = makeMemory({ id: "p1", content: "Project-specific config", projectId: "proj-1", category: "technical" });
	const projMem2 = makeMemory({ id: "p2", content: "Project decision log", projectId: "proj-1", category: "decisions_goals" });
	const allMemories = [globalMem1, globalMem2, projMem1, projMem2];

	function scopeRoute(url: URL) {
		const scope = url.searchParams.get("scope");
		const projectId = url.searchParams.get("projectId");
		let filtered = [...allMemories];
		if (scope === "global") filtered = filtered.filter(m => !m.projectId);
		else if (scope === "project" && projectId) filtered = filtered.filter(m => m.projectId === projectId);
		else if (scope === "all" && projectId) filtered = filtered.filter(m => m.projectId === projectId || !m.projectId);
		const status = url.searchParams.get("status");
		if (status) filtered = filtered.filter(m => m.status === status);
		const category = url.searchParams.get("category");
		if (category) filtered = filtered.filter(m => m.category === category);
		const search = url.searchParams.get("search");
		if (search) filtered = filtered.filter(m => m.content.toLowerCase().includes(search.toLowerCase()));
		return filtered;
	}

	test("global memories show Org-wide badge", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
			routes: { "/api/memories": scopeRoute },
		});
		await page.goto("/memories");

		const globalRow = page.getByText("Global org-wide preference").locator("..");
		await expect(globalRow.getByText("Org-wide")).toBeVisible();
	});

	test("project memories show Project badge", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
			routes: { "/api/memories": scopeRoute },
		});
		await page.goto("/memories");

		const projectRow = page.getByText("Project-specific config").locator("..");
		await expect(projectRow.getByText("Project")).toBeVisible();
	});

	test("scope filter section with All, This Project, Org-wide buttons is visible", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
			routes: { "/api/memories": scopeRoute },
		});
		await page.goto("/memories");

		await expect(page.getByRole("button", { name: "All" })).toBeVisible();
		await expect(page.getByRole("button", { name: "This Project" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Org-wide" })).toBeVisible();
	});

	test("Scope label is visible", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
			routes: { "/api/memories": scopeRoute },
		});
		await page.goto("/memories");

		await expect(page.getByText("Scope:")).toBeVisible();
	});

	test("clicking Org-wide scope filter shows only global memories", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
			routes: { "/api/memories": scopeRoute },
		});
		await page.goto("/memories");

		await page.getByRole("button", { name: "Org-wide" }).click();
		await page.waitForTimeout(500);

		await expect(page.getByText("Global org-wide preference")).toBeVisible();
		await expect(page.getByText("Global technical note")).toBeVisible();
		await expect(page.getByText("Project-specific config")).not.toBeVisible();
		await expect(page.getByText("Project decision log")).not.toBeVisible();
	});

	test("clicking This Project scope filter shows only project memories", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
			routes: { "/api/memories": scopeRoute },
		});
		await page.goto("/memories");

		await page.getByRole("button", { name: "This Project" }).click();
		await page.waitForTimeout(500);

		await expect(page.getByText("Project-specific config")).toBeVisible();
		await expect(page.getByText("Project decision log")).toBeVisible();
		await expect(page.getByText("Global org-wide preference")).not.toBeVisible();
		await expect(page.getByText("Global technical note")).not.toBeVisible();
	});

	test("clicking All scope filter shows both project and global memories", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
			routes: { "/api/memories": scopeRoute },
		});
		await page.goto("/memories");

		// First filter to Org-wide to change state
		await page.getByRole("button", { name: "Org-wide" }).click();
		await page.waitForTimeout(500);

		// Then click All to show everything
		await page.getByRole("button", { name: "All" }).click();
		await page.waitForTimeout(500);

		await expect(page.getByText("Global org-wide preference")).toBeVisible();
		await expect(page.getByText("Global technical note")).toBeVisible();
		await expect(page.getByText("Project-specific config")).toBeVisible();
		await expect(page.getByText("Project decision log")).toBeVisible();
	});

	test("add memory form shows scope selector with This Project and Org-wide options", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
			routes: { "/api/memories": scopeRoute },
		});
		await page.goto("/memories");

		// Open add memory form
		await page.getByRole("button", { name: /add/i }).click();

		const scopeSelector = page.locator('[data-testid="add-memory-scope"]');
		await expect(scopeSelector).toBeVisible();
		await expect(scopeSelector.getByText("This Project")).toBeVisible();
		await expect(scopeSelector.getByText("Org-wide")).toBeVisible();
	});

	test("add memory form scope selector has correct data-testid", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			memories: allMemories,
			routes: { "/api/memories": scopeRoute },
		});
		await page.goto("/memories");

		await page.getByRole("button", { name: /add/i }).click();

		await expect(page.locator('[data-testid="add-memory-scope"]')).toBeVisible();
	});
});
