import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * The sub-conversation API returns full Conversation objects. The chat page maps:
 *   agentName = s.title ?? "Agent"
 *   agentConfigId = s.agentConfigId ?? ""
 *   parentMessageId = (s as any).parentMessageId ?? ""
 *
 * SubConversationBlock uses agentName from the conversation object (not from a
 * separate field) and shows summary as "No messages yet" when collapsed with no
 * messages passed (messages prop defaults to [] and no messageCount/lastMessagePreview).
 */
function makeSubConvoApiResponse(overrides: {
	id?: string;
	title?: string;
	agentConfigId?: string | null;
	parentMessageId?: string;
	projectId?: string;
} = {}) {
	const base = makeConversation({
		id: overrides.id ?? "sub-conv-1",
		title: overrides.title ?? "summarizer",
		projectId: overrides.projectId ?? "proj-1",
		agentConfigId: overrides.agentConfigId ?? "cfg-1",
	});
	return { ...base, parentMessageId: overrides.parentMessageId ?? "msg-1" };
}

test.describe("Sub-Conversations", () => {
	const proj = makeProject({ id: "proj-1", name: "Sub-Conv Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Main Chat" });

	// A parent message that has a sub-conversation attached
	const parentMsg = makeMessage({
		id: "msg-1",
		conversationId: "conv-1",
		role: "assistant",
		content: "I've spun up a sub-conversation for you.",
	});

	test("sub-conversation block renders with agent name", async ({ page, mockApi }) => {
		const subConvo = makeSubConvoApiResponse({ title: "summarizer", parentMessageId: "msg-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [parentMsg],
			routes: {
				"/api/conversations/conv-1/sub-conversations": () => [subConvo],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// The block shows @agentName (which is the sub-conversation's title)
		const agentName = page.getByTestId("sub-convo-agent-name");
		await expect(agentName).toBeVisible({ timeout: 5000 });
		await expect(agentName).toContainText("@summarizer");
	});

	test("collapsed sub-conversation shows 'No messages yet' when no messages loaded", async ({ page, mockApi }) => {
		const subConvo = makeSubConvoApiResponse({ title: "summarizer", parentMessageId: "msg-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [parentMsg],
			routes: {
				"/api/conversations/conv-1/sub-conversations": () => [subConvo],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Collapsed block shows summary — "No messages yet" when no messages passed
		const summaryEl = page.locator(".sub-convo-summary");
		await expect(summaryEl).toBeVisible({ timeout: 5000 });
		await expect(summaryEl).toContainText("No messages yet");
	});

	test("sub-conversation block has left border accent styling", async ({ page, mockApi }) => {
		const subConvo = makeSubConvoApiResponse({ title: "summarizer", parentMessageId: "msg-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [parentMsg],
			routes: {
				"/api/conversations/conv-1/sub-conversations": () => [subConvo],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		const block = page.locator(".sub-convo-block");
		await expect(block).toBeVisible({ timeout: 5000 });
		// Should have border-l-4 class indicating the left accent border
		await expect(block).toHaveClass(/border-l-4/);
	});

	test("clicking collapsed sub-conversation block expands it and lazy-loads messages", async ({ page, mockApi }) => {
		const subConvo = makeSubConvoApiResponse({ id: "sub-conv-1", title: "summarizer", parentMessageId: "msg-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [parentMsg],
			routes: {
				"/api/conversations/conv-1/sub-conversations": () => [subConvo],
				"/api/conversations/sub-conv-1/messages": () => [
					{ id: "sc-msg-1", role: "user", content: "Summarize this.", conversationId: "sub-conv-1", createdAt: "2026-01-01T00:00:00.000Z", model: null, provider: null, usage: null, runId: null, parentMessageId: null },
					{ id: "sc-msg-2", role: "assistant", content: "Here is the summary.", conversationId: "sub-conv-1", createdAt: "2026-01-01T00:01:00.000Z", model: null, provider: null, usage: null, runId: null, parentMessageId: null },
				],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Wait for block to render
		await expect(page.locator(".sub-convo-block")).toBeVisible({ timeout: 5000 });

		// Click the header button to expand
		await page.locator(".sub-convo-block button").first().click();

		// Expanded content — messages area becomes visible
		await expect(page.locator(".sub-convo-messages")).toBeVisible({ timeout: 3000 });
	});

	test("expanded sub-conversation shows lazy-loaded message content", async ({ page, mockApi }) => {
		const subConvo = makeSubConvoApiResponse({ id: "sub-conv-1", title: "summarizer", parentMessageId: "msg-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [parentMsg],
			routes: {
				"/api/conversations/conv-1/sub-conversations": () => [subConvo],
				"/api/conversations/sub-conv-1/messages": () => [
					{ id: "sc-msg-1", role: "user", content: "Summarize this.", conversationId: "sub-conv-1", createdAt: "2026-01-01T00:00:00.000Z", model: null, provider: null, usage: null, runId: null, parentMessageId: null },
					{ id: "sc-msg-2", role: "assistant", content: "Here is the summary.", conversationId: "sub-conv-1", createdAt: "2026-01-01T00:01:00.000Z", model: null, provider: null, usage: null, runId: null, parentMessageId: null },
				],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		await expect(page.locator(".sub-convo-block")).toBeVisible({ timeout: 5000 });
		// Click to expand
		await page.locator(".sub-convo-block button").first().click();

		await expect(page.getByText("Summarize this.")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Here is the summary.")).toBeVisible();
	});

	test("multiple sub-conversations render multiple blocks", async ({ page, mockApi }) => {
		// Both messages on the same linear branch (msg-2 is a reply to msg-1)
		// so both are visible simultaneously.
		// Each sub-conversation has a different parentMessageId.
		const parentMsg2 = makeMessage({
			id: "msg-2",
			conversationId: "conv-1",
			role: "user",
			content: "Tell the coder agent to fix the bug.",
			parentMessageId: "msg-1",
		});
		const subConvo1 = makeSubConvoApiResponse({ id: "sub-conv-1", title: "summarizer", parentMessageId: "msg-1" });
		const subConvo2 = makeSubConvoApiResponse({ id: "sub-conv-2", title: "coder", parentMessageId: "msg-2" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [parentMsg, parentMsg2],
			routes: {
				"/api/conversations/conv-1/sub-conversations": () => [subConvo1, subConvo2],
				// Provide messages response for the active leaf (msg-2 branch)
				"/api/conversations/conv-1/messages": () => [parentMsg, parentMsg2],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		const blocks = page.locator(".sub-convo-block");
		await expect(blocks).toHaveCount(2, { timeout: 5000 });
	});

	test("sub-conversations API endpoint is called for the main conversation", async ({ page, mockApi }) => {
		const requests: string[] = [];

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [parentMsg],
			routes: {
				"/api/conversations/conv-1/sub-conversations": (url) => {
					requests.push(url.pathname);
					return [];
				},
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.waitForTimeout(500);

		const matched = requests.some((p) => p.includes("/sub-conversations"));
		expect(matched).toBe(true);
	});

	test("no sub-conversation blocks rendered when API returns empty array", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [parentMsg],
			routes: {
				"/api/conversations/conv-1/sub-conversations": () => [],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.waitForTimeout(500);

		const blocks = page.locator(".sub-convo-block");
		await expect(blocks).toHaveCount(0);
	});

	test("sub-conversation block shows agent name with @ prefix", async ({ page, mockApi }) => {
		const subConvo = makeSubConvoApiResponse({ title: "code-reviewer", parentMessageId: "msg-1" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [parentMsg],
			routes: {
				"/api/conversations/conv-1/sub-conversations": () => [subConvo],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		await expect(page.getByTestId("sub-convo-agent-name")).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId("sub-convo-agent-name")).toContainText("@code-reviewer");
	});
});
