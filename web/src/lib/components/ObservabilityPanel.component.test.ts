import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
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
			taskSnapshot: { tasks: [{ assignments: [{ subConversationId: "sub-1", status: "failed" }] }] },
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

	test("uses live tool state during a stream and handles a failed request without stale content", async () => {
		getActiveRunIdForConversation.mockReturnValue("run-live");
		getStreamingToolCalls.mockReturnValue([{ id: "live-tool", toolName: "read_file", status: "running" }]);
		vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 503 })));
		const onclose = vi.fn();
		render(ObservabilityPanel, { conversationId: "conversation-2", open: true, onclose });
		await waitFor(() => expect(fetch).toHaveBeenCalled());
		expect(screen.queryByText("Token Usage")).toBeNull();
		expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
	});
});
