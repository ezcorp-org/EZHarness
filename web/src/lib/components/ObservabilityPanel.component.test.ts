import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

const { getActiveRunIdForConversation, getStreamingToolCalls } = vi.hoisted(() => ({
	getActiveRunIdForConversation: vi.fn(),
	getStreamingToolCalls: vi.fn(),
}));

vi.mock("$lib/stores.svelte.js", () => ({
	getActiveRunIdForConversation,
	getStreamingToolCalls,
}));

import ObservabilityPanel from "./ObservabilityPanel.svelte";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

function response(data: unknown) {
	return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ObservabilityPanel", () => {
	test("loads and presents saved metrics, failures, and top-level run diagnostics", async () => {
		getActiveRunIdForConversation.mockReturnValue(undefined);
		vi.stubGlobal("fetch", vi.fn(async () => response({
			stats: { totalInputTokens: 1250, totalOutputTokens: 2_500_000, totalToolCalls: 3, avgDurationMs: 1250, turnCount: 4 },
			events: [
				{ id: "tool", eventType: "tool_call", data: {}, durationMs: 12, createdAt: "2026-01-01T10:00:00.000Z" },
				{ id: "agent", eventType: "agent_call", data: { agentName: "Builder", resultPreview: "Build failed", subConversationId: "sub-1" }, durationMs: 20, createdAt: "2026-01-01T10:00:01.000Z" },
				{ id: "run", eventType: "run_error", data: { error: "Watchdog timed out", runId: "abcdefgh123" }, durationMs: null, createdAt: "2026-01-01T10:00:02.000Z" },
			],
		})));
		render(ObservabilityPanel, {
			conversationId: "conversation-1",
			open: true,
			onclose: vi.fn(),
		taskSnapshot: {
			conversationId: "conversation-1",
			tasks: [{
				id: "task-1",
				title: "Build release",
				description: "Prepare artifacts",
				status: "failed",
				subtasks: [],
				assignments: [{
					id: "assignment-1",
					agentConfigId: "agent-1",
					agentName: "Builder",
					isTeam: false,
					subConversationId: "sub-1",
					status: "failed",
					assignedAt: "2026-01-01T10:00:00.000Z",
					failedAt: "2026-01-01T10:00:02.000Z",
				}],
				createdAt: "2026-01-01T10:00:00.000Z",
				failedAt: "2026-01-01T10:00:02.000Z",
				priority: 0,
			}],
		},
		});
		await screen.findByText("Token Usage");
		expect(screen.getByText("1.3K")).toBeInTheDocument();
		expect(screen.getAllByText("2.5M")).toHaveLength(2);
		expect(screen.getByText("1.3s")).toBeInTheDocument();
		expect(screen.getByText("Execution Timeline")).toBeInTheDocument();
		expect(screen.getByText("Sub-agent Invocations")).toBeInTheDocument();
		expect(screen.getByText("Builder").parentElement?.parentElement).toHaveTextContent("Failed");
		expect(screen.getByText("Watchdog timed out")).toBeInTheDocument();
		expect(fetch).toHaveBeenCalledWith("/api/observability/conversation-1");
	});

	test("uses live tool state during a stream", async () => {
		getActiveRunIdForConversation.mockReturnValue("run-live");
		getStreamingToolCalls.mockReturnValue([{
			id: "live-tool",
			toolName: "read_file",
			status: "running",
			startedAt: Date.now() - 100,
			input: { path: "release.md" },
			output: "release notes",
		}]);
		vi.stubGlobal("fetch", vi.fn(async () => response({
			stats: { totalInputTokens: 0, totalOutputTokens: 0, totalToolCalls: 1, avgDurationMs: 0, turnCount: 1 },
			events: [],
		})));
		const onclose = vi.fn();
		render(ObservabilityPanel, { conversationId: "conversation-2", open: true, onclose });
		await screen.findByText("Execution Timeline");
		expect(screen.getByText("read_file")).toBeInTheDocument();
		await fireEvent.click(screen.getByText("read_file"));
		expect(screen.getByText(/release notes/)).toBeInTheDocument();
		expect(getStreamingToolCalls).toHaveBeenCalledWith("run-live");
	});

	test("keeps the panel usable after a failed request", async () => {
		getActiveRunIdForConversation.mockReturnValue(undefined);
		vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 503 })));
		const onclose = vi.fn();
		render(ObservabilityPanel, { conversationId: "conversation-2", open: true, onclose });
		await waitFor(() => expect(fetch).toHaveBeenCalled());
		expect(screen.queryByText("Token Usage")).toBeNull();
		await fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onclose).toHaveBeenCalledOnce();
	});
});
