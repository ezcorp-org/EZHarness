import { test, expect } from "./fixtures/test-base.js";
import { selectMemoryScope } from "./fixtures/memories.js";
import { makeProject, makeConversation, makeMemory } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Memory Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

const globalMem = makeMemory({ id: "m1", content: "User name is Geff", category: "biographical", projectId: null });
const projMem = makeMemory({ id: "m2", content: "Always say hi billy", category: "preferences", projectId: "proj-1" });

test.describe("Memory Injection", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("activeProjectId", "proj-1"));
	});
	test("memories page shows both global and project memories", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			memories: [globalMem, projMem],
		});
		await page.goto("/memories");

		await expect(page.getByText("User name is Geff")).toBeVisible();
		await expect(page.getByText("Always say hi billy")).toBeVisible();

		// Verify correct scope badges
		const globalRow = page.getByText("User name is Geff").locator("..");
		await expect(globalRow.getByText("Org-wide", { exact: true })).toBeVisible();

		const projectRow = page.getByText("Always say hi billy").locator("..");
		await expect(projectRow.getByText("1 project", { exact: true })).toBeVisible();
	});

	test("memory scope filter works on memories page", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			memories: [globalMem, projMem],
		});
		await page.goto("/memories");

		// Click Org-wide filter — only global memory shows
		await selectMemoryScope(page, "global", proj.id);

		await expect(page.getByText("User name is Geff")).toBeVisible();
		await expect(page.getByText("Always say hi billy")).not.toBeVisible();

		// Click This Project filter — only project memory shows
		await selectMemoryScope(page, "project", proj.id);

		await expect(page.getByText("Always say hi billy")).toBeVisible();
		await expect(page.getByText("User name is Geff")).not.toBeVisible();

		// Click All — both show
		await selectMemoryScope(page, "all", proj.id);

		await expect(page.getByText("User name is Geff")).toBeVisible();
		await expect(page.getByText("Always say hi billy")).toBeVisible();
	});

	test("memories page shows correct count", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			memories: [globalMem, projMem],
		});
		await page.goto("/memories");

		await expect(page.getByText("2 memories")).toBeVisible();
	});

	test("chat page loads successfully with memories in system", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			memories: [globalMem, projMem],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Verify the chat UI loads — textarea and send button visible
		await expect(page.locator("textarea")).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 5000 });
	});

	test("add memory form includes scope selector", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			memories: [globalMem, projMem],
		});
		await page.goto("/memories");

		// Click "+ Add Memory" toggle
		await page.locator('[data-testid="add-memory-toggle"]').click();

		// Verify the scope selector is present with correct options
		const scopeSelector = page.getByTestId("add-memory-form").getByTestId("project-picker");
		await expect(scopeSelector).toBeVisible();
		await scopeSelector.getByTestId("open-project-picker").click();
		await expect(page.getByTestId("project-picker-item-proj-1")).toBeVisible();
		await expect(page.getByTestId("project-picker-global")).toBeVisible();
	});

	test("memory item expanded view shows full content", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			memories: [globalMem, projMem],
		});
		await page.goto("/memories");

		// Click on a memory to expand it
		await page.getByText("User name is Geff").click();

		// The expanded paragraph contains the full content.
		await expect(page.getByTestId("memory-row").filter({ hasText: "User name is Geff" }).locator("p").filter({ hasText: "User name is Geff" })).toBeVisible();
		await expect(page.getByText("Provenance")).toBeVisible();
	});

	test("both scope badges are visible on the memory list", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			memories: [globalMem, projMem],
		});
		await page.goto("/memories");

		// Verify "Org-wide" badge appears for global memory
		const globalRow = page.getByText("User name is Geff").locator("..");
		await expect(globalRow.getByText("Org-wide", { exact: true })).toBeVisible();

		// Verify "Project" badge appears for project memory
		const projectRow = page.getByText("Always say hi billy").locator("..");
		await expect(projectRow.getByText("1 project", { exact: true })).toBeVisible();
	});
});
