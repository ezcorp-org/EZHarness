import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Chat composer autofocus on new chat", () => {
	const proj = makeProject({ id: "proj-1", name: "Autofocus Project" });

	test("landing page autofocuses the global composer", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [] });
		await page.goto("/");

		const textarea = page.locator("textarea.chat-textarea");
		await expect(textarea).toBeFocused({ timeout: 3000 });
	});

	test("empty conversation autofocuses the composer", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "empty-conv", projectId: "proj-1" });
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea.chat-textarea");
		await expect(textarea).toBeFocused({ timeout: 3000 });
	});

	test("non-empty conversation does NOT autofocus the composer", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "filled-conv", projectId: "proj-1" });
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "filled-conv",
			role: "user",
			content: "previous question",
		});
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "filled-conv",
			role: "assistant",
			content: "previous answer",
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Wait for the messages to render so we know the conversation finished loading.
		await expect(page.getByText("previous answer")).toBeVisible({ timeout: 5000 });

		const textarea = page.locator("textarea.chat-textarea");
		await expect(textarea).not.toBeFocused();
	});

	test("clicking 'New Chat' from sidebar focuses composer in the new conversation", async ({ page, mockApi }) => {
		// `setupApiMocks` returns `id: "new-conv"` from POST /api/conversations,
		// so the post-create navigation lands on /project/proj-1/chat/new-conv.
		// The GET for that id falls through to a 404, but the conv page still
		// renders the composer and messages list is [] → autofocus condition met.
		// Navigate directly to an existing conv so the sidebar (with its
		// "New Chat" button) is on screen — going to /chat would auto-redirect
		// to the most recent conv anyway, but with the sidebar collapsed on
		// the empty-state path.
		const existing = makeConversation({ id: "old-1", projectId: "proj-1", title: "Existing Conv" });
		await mockApi({ projects: [proj], conversations: [existing] });
		await page.goto(`/project/${proj.id}/chat/${existing.id}`);

		const newChatBtn = page.getByRole("button", { name: "New Chat" }).first();
		await expect(newChatBtn).toBeVisible({ timeout: 5000 });
		await newChatBtn.click();
		await page.waitForURL(`**/project/${proj.id}/chat/new-conv`, { timeout: 5000 });

		const textarea = page.locator("textarea.chat-textarea");
		await expect(textarea).toBeFocused({ timeout: 3000 });
	});

	test("focus is not re-stolen after the user blurs the textarea on an empty conv", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "empty-2", projectId: "proj-1" });
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea.chat-textarea");
		await expect(textarea).toBeFocused({ timeout: 3000 });

		// User explicitly blurs (e.g. Tab away). Autofocus should not yank
		// focus back without a state change — `messageCount` is still 0 so
		// the helper still returns true, but the $effect dependencies have
		// not changed, so it should not re-fire.
		await textarea.blur();
		await page.locator("body").click();
		// Brief settle window — if the effect were thrashing, it would re-fire here.
		await page.waitForTimeout(300);
		await expect(textarea).not.toBeFocused();
	});
});
