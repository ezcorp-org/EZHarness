import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage, makeMemory } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Memory Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

const globalMem = makeMemory({ id: "m1", content: "User name is Geff", category: "biographical", projectId: null });
const projMem = makeMemory({ id: "m2", content: "Always say hi billy", category: "preferences", projectId: "proj-1" });

function scopeRoute(url: URL) {
	const scope = url.searchParams.get("scope");
	const pid = url.searchParams.get("projectId");
	let filtered = [globalMem, projMem];
	if (scope === "global") filtered = filtered.filter(m => !m.projectId);
	else if (scope === "project" && pid) filtered = filtered.filter(m => m.projectId === pid);
	const status = url.searchParams.get("status");
	if (status) filtered = filtered.filter(m => m.status === status);
	const category = url.searchParams.get("category");
	if (category) filtered = filtered.filter(m => m.category === category);
	const search = url.searchParams.get("search");
	if (search) filtered = filtered.filter(m => m.content.toLowerCase().includes(search.toLowerCase()));
	return filtered;
}

test.describe("Memory Injection", () => {
	test("memories page shows both global and project memories", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			memories: [globalMem, projMem],
			routes: { "/api/memories": scopeRoute },
		});
		await page.goto("/memories");

		await expect(page.getByText("User name is Geff")).toBeVisible();
		await expect(page.getByText("Always say hi billy")).toBeVisible();

		// Verify correct scope badges
		const globalRow = page.getByText("User name is Geff").locator("..");
		await expect(globalRow.getByText("Org-wide")).toBeVisible();

		const projectRow = page.getByText("Always say hi billy").locator("..");
		await expect(projectRow.getByText("Project")).toBeVisible();
	});

	test("memory scope filter works on memories page", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			memories: [globalMem, projMem],
			routes: { "/api/memories": scopeRoute },
		});
		await page.goto("/memories");

		// Click Org-wide filter — only global memory shows
		await page.getByRole("button", { name: "Org-wide" }).click();
		await page.waitForTimeout(500);
		await expect(page.getByText("User name is Geff")).toBeVisible();
		await expect(page.getByText("Always say hi billy")).not.toBeVisible();

		// Click This Project filter — only project memory shows
		await page.getByRole("button", { name: "This Project" }).click();
		await page.waitForTimeout(500);
		await expect(page.getByText("Always say hi billy")).toBeVisible();
		await expect(page.getByText("User name is Geff")).not.toBeVisible();

		// Click All — both show
		await page.getByRole("button", { name: "All" }).click();
		await page.waitForTimeout(500);
		await expect(page.getByText("User name is Geff")).toBeVisible();
		await expect(page.getByText("Always say hi billy")).toBeVisible();
	});

	test("memories page shows correct count", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			memories: [globalMem, projMem],
			routes: { "/api/memories": scopeRoute },
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
			routes: { "/api/memories": scopeRoute },
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
			routes: { "/api/memories": scopeRoute },
		});
		await page.goto("/memories");

		// Click "+ Add Memory" toggle
		await page.locator('[data-testid="add-memory-toggle"]').click();

		// Verify the scope selector is present with correct options
		const scopeSelector = page.locator('[data-testid="add-memory-scope"]');
		await expect(scopeSelector).toBeVisible();
		await expect(scopeSelector.getByText("This Project")).toBeVisible();
		await expect(scopeSelector.getByText("Org-wide")).toBeVisible();
	});

	test("memory item expanded view shows full content", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			memories: [globalMem, projMem],
			routes: { "/api/memories": scopeRoute },
		});
		await page.goto("/memories");

		// Click on a memory to expand it
		await page.getByText("User name is Geff").click();

		// Full content should be visible along with provenance section
		await expect(page.getByText("User name is Geff")).toBeVisible();
		await expect(page.getByText("Provenance")).toBeVisible();
	});

	test("both scope badges are visible on the memory list", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			memories: [globalMem, projMem],
			routes: { "/api/memories": scopeRoute },
		});
		await page.goto("/memories");

		// Verify "Org-wide" badge appears for global memory
		const globalRow = page.getByText("User name is Geff").locator("..");
		await expect(globalRow.getByText("Org-wide")).toBeVisible();

		// Verify "Project" badge appears for project memory
		const projectRow = page.getByText("Always say hi billy").locator("..");
		await expect(projectRow.getByText("Project")).toBeVisible();
	});
});
