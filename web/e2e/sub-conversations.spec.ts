import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * User-created sub-conversations have no agent config. Agent-backed records
 * render as AgentChips; these cases cover the expandable transcript block.
 */
function makeUserSubConversation(overrides: {
	id?: string;
	agentName?: string;
	parentMessageId?: string;
} = {}) {
	return {
		id: overrides.id ?? "sub-conv-1",
		agentName: overrides.agentName ?? "summarizer",
		agentConfigId: "",
		parentMessageId: overrides.parentMessageId ?? "msg-1",
		parentConversationId: "conv-1",
		messageCount: 0,
		lastMessagePreview: null,
	};
}

function makeSubConversationMessages() {
	return [
		makeMessage({
			id: "sc-msg-1",
			conversationId: "sub-conv-1",
			role: "user",
			content: "Summarize this.",
		}),
		makeMessage({
			id: "sc-msg-2",
			conversationId: "sub-conv-1",
			role: "assistant",
			content: "Here is the summary.",
			parentMessageId: "sc-msg-1",
		}),
	];
}

test.describe("Sub-Conversations", () => {
	const proj = makeProject({ id: "proj-1", name: "Sub-Conv Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Main Chat" });
	const parentMsg = makeMessage({
		id: "msg-1",
		conversationId: "conv-1",
		role: "assistant",
		content: "I've spun up a sub-conversation for you.",
	});

	test("sub-conversation block renders with agent name", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj], conversations: [conv], messages: [parentMsg],
			subConversations: [makeUserSubConversation()],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByTestId("sub-convo-agent-name")).toHaveText("@summarizer");
	});

	test("collapsed sub-conversation shows no-message summary", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj], conversations: [conv], messages: [parentMsg],
			subConversations: [makeUserSubConversation()],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.locator(".sub-convo-summary")).toHaveText("No messages yet");
	});

	test("sub-conversation block has left border accent styling", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj], conversations: [conv], messages: [parentMsg],
			subConversations: [makeUserSubConversation()],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.locator(".sub-convo-block")).toHaveClass(/border-l-4/);
	});

	test("clicking a collapsed sub-conversation expands and lazy-loads messages", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj], conversations: [conv], messages: [parentMsg, ...makeSubConversationMessages()],
			subConversations: [makeUserSubConversation()],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.locator(".sub-convo-block button").first().click();
		await expect(page.locator(".sub-convo-messages")).toBeVisible();
	});

	test("expanded sub-conversation shows lazy-loaded message content", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj], conversations: [conv], messages: [parentMsg, ...makeSubConversationMessages()],
			subConversations: [makeUserSubConversation()],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.locator(".sub-convo-block button").first().click();
		await expect(page.getByText("Summarize this.")).toBeVisible();
		await expect(page.getByText("Here is the summary.")).toBeVisible();
	});

	test("multiple user sub-conversations render multiple blocks", async ({ page, mockApi }) => {
		const parentMsg2 = makeMessage({
			id: "msg-2", conversationId: conv.id, role: "user",
			content: "Tell the coder agent to fix the bug.", parentMessageId: parentMsg.id,
		});
		await mockApi({
			projects: [proj], conversations: [conv], messages: [parentMsg, parentMsg2],
			subConversations: [
				makeUserSubConversation(),
				makeUserSubConversation({ id: "sub-conv-2", agentName: "coder", parentMessageId: parentMsg2.id }),
			],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.locator(".sub-convo-block")).toHaveCount(2);
	});

	test("chat hydration requests sub-conversations with the tool-call snapshot", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [parentMsg] });
		const snapshot = page.waitForRequest((request) => {
			const url = new URL(request.url());
			return request.method() === "GET"
				&& url.pathname === `/api/conversations/${conv.id}/messages`
				&& url.searchParams.get("withToolCalls") === "true";
		});

		const [request] = await Promise.all([snapshot, page.goto(`/project/${proj.id}/chat/${conv.id}`)]);
		expect(new URL(request.url()).searchParams.get("withToolCalls")).toBe("true");
	});

	test("no sub-conversation blocks render when the snapshot is empty", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [parentMsg], subConversations: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.locator(".sub-convo-block")).toHaveCount(0);
	});

	test("sub-conversation block prefixes the agent name", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj], conversations: [conv], messages: [parentMsg],
			subConversations: [makeUserSubConversation({ agentName: "code-reviewer" })],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByTestId("sub-convo-agent-name")).toHaveText("@code-reviewer");
	});
});
