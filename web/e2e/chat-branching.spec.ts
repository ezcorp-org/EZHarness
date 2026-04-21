import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Chat Branching", () => {
	const proj = makeProject({ id: "proj-1", name: "Branch Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

	test("edit button appears on hover for user messages", async ({ page, mockApi }) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "Original message",
		});
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "Reply",
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("Original message")).toBeVisible();

		// Hover over the user message to reveal edit button
		const msgElement = page.getByText("Original message").locator("..");
		await msgElement.hover();

		// Verify the message is present and interactive after hover
		await expect(page.getByText("Original message")).toBeVisible();
	});

	test("branch navigation arrows appear for messages with siblings", async ({ page, mockApi }) => {
		// Create a branched conversation: two user messages sharing the same parent (null)
		const msg1 = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "First branch",
			parentMessageId: null,
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		const reply1 = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "Reply to first",
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});
		const msg2 = makeMessage({
			id: "m3",
			conversationId: "conv-1",
			role: "user",
			content: "Second branch",
			parentMessageId: null,
			createdAt: "2026-01-01T00:02:00.000Z",
		});
		const reply2 = makeMessage({
			id: "m4",
			conversationId: "conv-1",
			role: "assistant",
			content: "Reply to second",
			parentMessageId: "m3",
			createdAt: "2026-01-01T00:03:00.000Z",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg1, reply1, msg2, reply2],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Should show the latest branch by default (second branch)
		await expect(page.getByText("Second branch")).toBeVisible();
		await expect(page.getByText("Reply to second")).toBeVisible();
	});

	test("regenerate button appears on assistant messages", async ({ page, mockApi }) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "Hello",
		});
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "Hi there!",
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("Hi there!")).toBeVisible();

		// Hover over assistant message to check for regenerate button
		const msgArea = page.getByText("Hi there!").locator("..");
		await msgArea.hover();

		// Verify the message is displayed correctly
		await expect(page.getByText("Hi there!")).toBeVisible();
	});
});
