import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Chat", () => {
	const proj = makeProject({ id: "proj-1", name: "Chat Project" });

	test("chat list shows conversations", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [
				makeConversation({ id: "c1", projectId: "proj-1", title: "First Chat" }),
				makeConversation({ id: "c2", projectId: "proj-1", title: "Second Chat" }),
			],
		});
		await page.goto(`/project/${proj.id}/chat`);

		await expect(page.getByText("First Chat")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Second Chat")).toBeVisible({ timeout: 5000 });
	});

	test("chat list shows empty state with New Chat button", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [],
		});
		await page.goto(`/project/${proj.id}/chat`);

		await expect(page.getByText("No conversations yet").first()).toBeVisible();
		await expect(page.getByRole("button", { name: "New Chat" }).first()).toBeVisible();
	});

	test("conversation view shows messages", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test Conv" });
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "What is 2+2?",
		});
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "The answer is 4.",
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("What is 2+2?")).toBeVisible();
		await expect(page.getByText("The answer is 4.")).toBeVisible();
	});

	test("empty conversation shows prompt to send message", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();
	});

	test("chat input is visible and functional", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea");
		await expect(textarea).toBeVisible();
		await textarea.fill("Hello!");
		await expect(textarea).toHaveValue("Hello!");
	});
});
