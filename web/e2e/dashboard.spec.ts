/** The old dashboard routes now lead to chat; agent cards remain covered by agents-list.spec.ts. */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

for (const entry of [
	{ path: "/", projectId: "global", name: "Global" },
	{ path: "/project/proj-1", projectId: "proj-1", name: "My Project" },
]) {
	test(`legacy dashboard ${entry.path} opens a usable chat workspace`, async ({ page, mockApi }) => {
		await mockApi({ projects: [makeProject({ id: entry.projectId, name: entry.name })], conversations: [] });
		await page.goto(entry.path);
		await expect(page).toHaveURL(`/project/${entry.projectId}/chat`);
		await expect(page.getByRole("heading", { name: "No conversations yet" })).toBeVisible();
		await expect(page.locator("aside").getByRole("link", { name: "Chat", exact: true })).toHaveAttribute("aria-current", "page");
		await expect(page.getByRole("button", { name: "New Conversation", exact: true })).toBeVisible();
	});
}
