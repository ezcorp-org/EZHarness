import type { Locator, Page } from "@playwright/test";
import { expect } from "./hydration.js";
import type { MockOverrides } from "./api-mocks.js";
import { makeConversation, makeMessage, makeProject } from "./data.js";

export type MockApi = (overrides?: MockOverrides) => Promise<void>;

export const panelProject = makeProject({ id: "proj-1", name: "Panel Chat Project" });
export const panelConversation = makeConversation({
	id: "conv-1",
	projectId: panelProject.id,
	title: "Panel Chat Test",
});

const userMessage = makeMessage({
	id: "panel-user-1",
	conversationId: panelConversation.id,
	role: "user",
	content: "Delegate this work",
	parentMessageId: null,
});
const assistantMessage = makeMessage({
	id: "panel-assistant-1",
	conversationId: panelConversation.id,
	role: "assistant",
	content: "Delegating to TestAgent.",
	parentMessageId: userMessage.id,
	createdAt: "2026-01-01T00:00:30.000Z",
});
const taskMessage = makeMessage({
	id: "panel-task-1",
	conversationId: "sub-conv-1",
	role: "user",
	content: "Inspect the current implementation",
	createdAt: "2026-01-01T00:01:00.000Z",
});
const replyMessage = makeMessage({
	id: "panel-reply-1",
	conversationId: "sub-conv-1",
	role: "assistant",
	content: "The initial implementation is ready for review.",
	parentMessageId: taskMessage.id,
	createdAt: "2026-01-01T00:01:30.000Z",
});

export function panelMock(overrides: Partial<MockOverrides> = {}): MockOverrides {
	return {
		projects: [panelProject],
		conversations: [panelConversation, makeConversation({ id: "sub-conv-1", projectId: panelProject.id, parentConversationId: panelConversation.id, provider: "anthropic", model: "claude-sonnet-4-20250514" })],
		messages: [userMessage, assistantMessage, taskMessage, replyMessage],
		subConversations: [{
			id: "sub-conv-1",
			agentName: "TestAgent",
			agentConfigId: "cfg-1",
			parentMessageId: assistantMessage.id,
			parentConversationId: panelConversation.id,
			messageCount: 2,
			lastMessagePreview: replyMessage.content,
		}],
		routes: { "/tasks": () => ({ conversationId: panelConversation.id, tasks: [] }) },
		...overrides,
	};
}

/** Open the actual clickable AgentChip rendered from hydrated sub-conversation data. */
export async function openAgentPanel(page: Page, mockApi: MockApi, overrides: Partial<MockOverrides> = {}): Promise<Locator> {
	await mockApi(panelMock(overrides));
	await page.goto(`/project/${panelProject.id}/chat/${panelConversation.id}`);
	const chip = page.getByTestId("agent-chip").first();
	await chip.waitFor({ state: "visible" });
	await chip.click();
	const panel = page.locator(".agent-detail-panel");
	await panel.waitFor({ state: "visible" });
	return panel;
}

export async function openTeamPanel(page: Page, mockApi: MockApi) {
	const task = {
		id: "team-task", title: "Team task", description: "", status: "active" as const, priority: 0,
		assignments: [{ id: "team-assignment", agentConfigId: "team-cfg-1", agentName: "TestTeam", isTeam: true, status: "running", assignedAt: "2026-01-01T00:00:00Z", subConversationId: "sub-conv-1" }],
		subtasks: [], createdAt: "2026-01-01T00:00:00Z",
	};
	await mockApi(panelMock({
		taskSnapshots: { [panelConversation.id]: { tasks: [task], activeTaskId: task.id } },
		routes: {
			"/tasks": () => ({ conversationId: panelConversation.id, tasks: [task] }),
			"team/team-cfg-1/messages": () => ({
				team: { name: "TestTeam", members: [{ agentConfigId: "cfg-1", agentName: "TestAgent" }] },
				orchestrator: { agentConfigId: "team-cfg-1", agentName: "TestAgent", subConversationId: "sub-conv-1", messages: [{ id: "team-reply", role: "assistant", content: "Team response", createdAt: "2026-01-01T00:01:00Z", toolCalls: [] }] },
				streams: [],
			}),
		},
	}));
	await page.goto(`/project/${panelProject.id}/chat/${panelConversation.id}`);
	const teamPill = page.getByText("@TestTeam", { exact: true });
	await expect(teamPill).toBeVisible();
	await teamPill.click();
	const panel = page.getByRole("dialog", { name: "Team chat" });
	await expect(panel).toBeVisible();
	return panel;
}
