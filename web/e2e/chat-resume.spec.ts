import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Chat resume — last opened conversation", () => {
	const proj = makeProject({ id: "proj-1", name: "Resume Project" });
	const conv1 = makeConversation({ id: "conv-1", projectId: "proj-1", title: "First Chat", updatedAt: "2026-01-01T00:02:00.000Z" });
	const conv2 = makeConversation({ id: "conv-2", projectId: "proj-1", title: "Second Chat", updatedAt: "2026-01-01T00:01:00.000Z" });
	const msg = makeMessage({ id: "msg-1", conversationId: "conv-1", role: "user", content: "Hello" });

	test("redirects to last-opened chat from localStorage", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv1, conv2],
			messages: [msg],
		});

		// Pre-set localStorage with conv-2 as last opened
		await page.goto("/");
		await page.evaluate(
			({ key, value }) => localStorage.setItem(key, value),
			{ key: "ezcorp-last-chat:proj-1", value: "conv-2" },
		);

		// Navigate to /chat — should redirect to conv-2
		await page.goto(`/project/proj-1/chat`);
		await page.waitForURL("**/chat/conv-2", { timeout: 5000 });
		await expect(page).toHaveURL(/\/chat\/conv-2/);
	});

	test("falls back to most recent when last-opened chat is deleted", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			// Only conv-1 exists, conv-deleted does not
			conversations: [conv1],
			messages: [msg],
		});

		// Set localStorage to a conversation that no longer exists
		await page.goto("/");
		await page.evaluate(
			({ key, value }) => localStorage.setItem(key, value),
			{ key: "ezcorp-last-chat:proj-1", value: "conv-deleted" },
		);

		// Navigate to /chat — should fall back to conv-1 (most recent)
		await page.goto(`/project/proj-1/chat`);
		await page.waitForURL("**/chat/conv-1", { timeout: 5000 });
		await expect(page).toHaveURL(/\/chat\/conv-1/);
	});

	test("redirects to most recent when no localStorage entry", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv1, conv2],
			messages: [msg],
		});

		// Clear localStorage
		await page.goto("/");
		await page.evaluate(
			(key) => localStorage.removeItem(key),
			"ezcorp-last-chat:proj-1",
		);

		// Navigate to /chat — should redirect to conv-1 (first in list = most recent)
		await page.goto(`/project/proj-1/chat`);
		await page.waitForURL("**/chat/conv-1", { timeout: 5000 });
		await expect(page).toHaveURL(/\/chat\/conv-1/);
	});

	test("shows empty state when no conversations exist", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [],
		});

		// Clear localStorage
		await page.goto("/");
		await page.evaluate(
			(key) => localStorage.removeItem(key),
			"ezcorp-last-chat:proj-1",
		);

		await page.goto(`/project/proj-1/chat`);

		// Should show empty state, not redirect
		await expect(page.getByText("No conversations yet")).toBeVisible({ timeout: 5000 });
	});

	test("shows empty state when localStorage points to deleted chat and no conversations", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [],
		});

		// Set stale localStorage
		await page.goto("/");
		await page.evaluate(
			({ key, value }) => localStorage.setItem(key, value),
			{ key: "ezcorp-last-chat:proj-1", value: "conv-gone" },
		);

		await page.goto(`/project/proj-1/chat`);
		await expect(page.getByText("No conversations yet")).toBeVisible({ timeout: 5000 });
	});
});

test.describe("Chat page saves last-opened conversation", () => {
	const proj = makeProject({ id: "proj-1", name: "Save Project" });
	const conv1 = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Chat One" });
	const conv2 = makeConversation({ id: "conv-2", projectId: "proj-1", title: "Chat Two" });
	const msg = makeMessage({ id: "msg-1", conversationId: "conv-1", role: "user", content: "Hi" });

	test("opening a conversation saves its id to localStorage", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv1, conv2],
			messages: [msg],
		});

		await page.goto(`/project/proj-1/chat/conv-1`);

		// Wait for the page to load and the $effect to fire
		await page.waitForTimeout(500);

		const saved = await page.evaluate(
			(key) => localStorage.getItem(key),
			"ezcorp-last-chat:proj-1",
		);
		expect(saved).toBe("conv-1");
	});

	test("switching to a different conversation updates localStorage", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv1, conv2],
			messages: [msg],
		});

		// Open conv-1 first
		await page.goto(`/project/proj-1/chat/conv-1`);
		await page.waitForTimeout(300);

		let saved = await page.evaluate(
			(key) => localStorage.getItem(key),
			"ezcorp-last-chat:proj-1",
		);
		expect(saved).toBe("conv-1");

		// Navigate to conv-2
		await page.goto(`/project/proj-1/chat/conv-2`);
		await page.waitForTimeout(300);

		saved = await page.evaluate(
			(key) => localStorage.getItem(key),
			"ezcorp-last-chat:proj-1",
		);
		expect(saved).toBe("conv-2");
	});

	test("localStorage key is project-scoped", async ({ page, mockApi }) => {
		const proj2 = makeProject({ id: "proj-2", name: "Other Project" });
		const convOther = makeConversation({ id: "conv-other", projectId: "proj-2", title: "Other Chat" });

		await mockApi({
			projects: [proj, proj2],
			conversations: [conv1, convOther],
			messages: [msg],
		});

		// Open chat in proj-1
		await page.goto(`/project/proj-1/chat/conv-1`);
		await page.waitForTimeout(300);

		// Open chat in proj-2
		await page.goto(`/project/proj-2/chat/conv-other`);
		await page.waitForTimeout(300);

		// Both should be saved independently
		const saved1 = await page.evaluate(
			(key) => localStorage.getItem(key),
			"ezcorp-last-chat:proj-1",
		);
		const saved2 = await page.evaluate(
			(key) => localStorage.getItem(key),
			"ezcorp-last-chat:proj-2",
		);
		expect(saved1).toBe("conv-1");
		expect(saved2).toBe("conv-other");
	});
});
