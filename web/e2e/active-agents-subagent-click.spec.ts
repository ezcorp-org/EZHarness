import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * E2E coverage for the Active Agents → sub-agent click flow.
 *
 * When a running sub-agent appears on the Active Agents page, clicking its row
 * must land the user on the PARENT chat (the conversation that hosts the
 * sub-agent) with the right-side `AgentDetailPanel` opened on that sub-agent.
 * Top-level agent rows keep the legacy behavior — a direct jump into their own
 * conversation with no side panel.
 */

const proj = makeProject({ id: "proj-1", name: "Active Agents Project" });
const parentConv = makeConversation({
	id: "parent-1",
	projectId: "proj-1",
	title: "Parent chat",
});

// A user turn + assistant turn in the parent chat. The sub-agent is anchored to
// the assistant message via `parentMessageId`, matching the real auto-spin-up
// wiring. Without these the chat page has nothing to hydrate.
const parentUserMsg = makeMessage({
	id: "msg-user-1",
	conversationId: "parent-1",
	role: "user",
	content: "Do the thing",
	parentMessageId: null,
});
const parentAsstMsg = makeMessage({
	id: "msg-asst-1",
	conversationId: "parent-1",
	role: "assistant",
	content: "Delegating to Worker.",
	parentMessageId: "msg-user-1",
});

// Sub-conversation content (what AgentDetailPanel fetches when it opens).
const subUserMsg = makeMessage({
	id: "sub-msg-1",
	conversationId: "sub-conv-1",
	role: "user",
	content: "do the thing",
});
const subAsstMsg = makeMessage({
	id: "sub-msg-2",
	conversationId: "sub-conv-1",
	role: "assistant",
	content: "on it",
});

test.describe("Active Agents → sub-agent click", () => {
	test("sub-agent row has parent-chat href with ?agent= deep-link", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [proj],
			conversations: [parentConv],
			routes: {
				"/active-agents": () => [
					{
						runId: "run-1",
						agentName: "Worker",
						conversationId: "sub-conv-1",
						parentConversationId: "parent-1",
						projectId: "proj-1",
						conversationTitle: "Worker run",
						startedAt: Date.now(),
					},
				],
			},
		});

		await page.goto("/active-agents");
		await page.waitForLoadState("networkidle");

		// The row text includes the agent name. Grab the first link in the list.
		const row = page.getByRole("link").filter({ hasText: "Worker" }).first();
		await expect(row).toBeVisible();

		const href = await row.getAttribute("href");
		expect(href).toBe(
			"/project/proj-1/chat/parent-1?agent=sub-conv-1",
		);
	});

	test("clicking a sub-agent row navigates to parent chat and opens AgentDetailPanel", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [proj],
			conversations: [parentConv],
			messages: [parentUserMsg, parentAsstMsg, subUserMsg, subAsstMsg],
			subConversations: [
				{
					id: "sub-conv-1",
					agentName: "Worker",
					agentConfigId: "cfg-1",
					parentMessageId: "msg-asst-1",
					parentConversationId: "parent-1",
				},
			],
			routes: {
				"/active-agents": () => [
					{
						runId: "run-1",
						agentName: "Worker",
						conversationId: "sub-conv-1",
						parentConversationId: "parent-1",
						projectId: "proj-1",
						conversationTitle: "Worker run",
						startedAt: Date.now(),
					},
				],
				"/tasks": () => ({ conversationId: "parent-1", tasks: [] }),
				// AgentDetailPanel fetches this on open.
				"sub-conv-1/messages": () => ({
					messages: [subUserMsg, subAsstMsg],
				}),
			},
		});

		await page.goto("/active-agents");
		await page.waitForLoadState("networkidle");

		const row = page.getByRole("link").filter({ hasText: "Worker" }).first();
		await row.click();

		// URL reflects deep-link: parent chat + ?agent=<subConvId>
		await expect(page).toHaveURL(
			/\/project\/proj-1\/chat\/parent-1\?agent=sub-conv-1/,
		);

		// Right-side AgentDetailPanel appears.
		const panel = page.locator(".agent-detail-panel");
		await expect(panel).toBeVisible({ timeout: 10_000 });
	});

	test("top-level agent row links directly to its own chat with no ?agent= param and no side panel", async ({
		page,
		mockApi,
	}) => {
		const topConv = makeConversation({
			id: "top-conv",
			projectId: "proj-1",
			title: "Top-level run",
		});
		const topUserMsg = makeMessage({
			id: "top-msg-1",
			conversationId: "top-conv",
			role: "user",
			content: "hi",
		});

		await mockApi({
			projects: [proj],
			conversations: [topConv],
			messages: [topUserMsg],
			routes: {
				"/active-agents": () => [
					{
						runId: "run-top",
						agentName: "Orchestrator",
						conversationId: "top-conv",
						parentConversationId: null,
						projectId: "proj-1",
						conversationTitle: "Top-level run",
						startedAt: Date.now(),
					},
				],
				"/tasks": () => ({ conversationId: "top-conv", tasks: [] }),
			},
		});

		await page.goto("/active-agents");
		await page.waitForLoadState("networkidle");

		const row = page
			.getByRole("link")
			.filter({ hasText: "Orchestrator" })
			.first();

		const href = await row.getAttribute("href");
		expect(href).toBe("/project/proj-1/chat/top-conv");
		expect(href).not.toContain("?agent=");

		await row.click();
		await expect(page).toHaveURL(/\/project\/proj-1\/chat\/top-conv$/);

		// No side panel should open from a top-level agent click.
		await expect(page.locator(".agent-detail-panel")).toHaveCount(0);
	});
});
