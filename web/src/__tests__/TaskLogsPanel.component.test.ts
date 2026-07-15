import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { openTeamPanel } = vi.hoisted(() => ({
	openTeamPanel: vi.fn(),
}));

vi.mock("$lib/stores.svelte.js", () => ({ openTeamPanel }));

import TaskLogsPanel from "$lib/components/TaskLogsPanel.svelte";

const task = {
	id: "task-1",
	title: "Repair the panel",
	description: "Show every sub-agent turn",
	status: "active",
	subtasks: [],
	assignments: [
		{
			id: "assignment-1",
			agentConfigId: "agent-1",
			agentName: "Builder",
			isTeam: false,
			status: "running",
			assignedAt: "2026-01-01T00:00:00.000Z",
			subConversationId: "sub-1",
		},
	],
	createdAt: "2026-01-01T00:00:00.000Z",
	priority: 0,
} as any;

beforeEach(() => {
	openTeamPanel.mockClear();
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("TaskLogsPanel sub-agent turns", () => {
	test("renders hydrated tool activity for a tool-only turn instead of a blank turn", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({
					streams: [
						{
							assignmentId: "assignment-1",
							agentName: "Builder",
							subConversationId: "sub-1",
							status: "running",
							messages: [
								{
									id: "turn-1",
									role: "assistant",
									content: "",
									createdAt: "2026-01-01T00:00:01.000Z",
									toolCalls: [
										{
											id: "tool-1",
											toolName: "edit_file",
											input: { path: "src/panel.ts" },
											outputSummary: "Updated file",
											success: true,
											durationMs: 12,
											status: "success",
										},
									],
								},
							],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { findByText, getByText } = render(TaskLogsPanel, {
			task,
			conversationId: "conversation-1",
			open: true,
			onclose: vi.fn(),
		});

		expect(await findByText("edit_file")).toBeInTheDocument();
		expect(getByText("Turn 1")).toBeInTheDocument();
		expect(getByText(/src\/panel\.ts/)).toBeInTheDocument();
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conversation-1/tasks/task-1/messages",
		);
	});
});
