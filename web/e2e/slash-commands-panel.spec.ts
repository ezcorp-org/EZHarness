import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * The detail drawer uses the same ChatThread composer as the page variant.
 * This journey keeps the panel-specific mount wired to project-scoped slash
 * command search and insertion.
 */

const project = makeProject({ id: "proj-1", name: "Panel Slash Project" });
const conversation = makeConversation({ id: "conv-1", projectId: project.id, title: "Slash panel test" });
const parentMessage = makeMessage({
	id: "msg-parent",
	conversationId: conversation.id,
	role: "assistant",
	content: "Delegating the review.",
	parentMessageId: null,
});
const subConversationMessage = makeMessage({
	id: "sub-msg-1",
	conversationId: "sub-conv-1",
	role: "user",
	content: "Review the staged changes.",
	parentMessageId: null,
});

const commands = [
	{
		name: "review",
		description: "Review staged changes",
		source: "project:claude-commands",
		body: "Review the staged changes and report regressions.",
	},
];

test("slash commands work inside the AgentDetailPanel chat input", async ({ page, mockApi }) => {
	await mockApi({
		projects: [project],
		conversations: [conversation],
		messages: [parentMessage, subConversationMessage],
		commands,
		subConversations: [
			{
				id: "sub-conv-1",
				agentName: "TestAgent",
				agentConfigId: "cfg-1",
				parentMessageId: parentMessage.id,
				parentConversationId: conversation.id,
				messageCount: 1,
			},
		],
	});

	// The native deep link uses the route shell's supported panel resolver.
	// It avoids fabricating a transport event merely to open static history.
	await page.goto(`/project/${project.id}/chat/${conversation.id}?agent=sub-conv-1`);
	const panel = page.locator(".agent-detail-panel");
	await expect(panel).toBeVisible();

	const textarea = panel.locator("textarea");
	await expect(textarea).toBeEnabled();
	const searchResponse = page.waitForResponse((response) => {
		const url = new URL(response.url());
		return url.pathname === "/api/mentions/search"
			&& url.searchParams.get("type") === "cmd"
			&& url.searchParams.get("q") === "rev"
			&& url.searchParams.get("projectId") === project.id;
	});
	await textarea.pressSequentially("/rev");
	await searchResponse;

	const popover = page.locator("#mention-listbox");
	await expect(popover).toBeVisible();
	await expect(popover).toContainText("Slash commands");
	await expect(popover).toContainText("/review");
	const reviewRow = popover.locator("[data-source='project:claude-commands']");
	await expect(reviewRow).toContainText("Project");
	await expect(reviewRow).toContainText(".claude/commands");

	await page.keyboard.press("Enter");
	await expect(popover).toBeHidden();
	await expect(textarea).toHaveValue(/^\/review\s+$/);
	await expect(panel.locator("[data-mention-kind='command']")).toBeVisible();
});
