import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { userFetch, backgroundFetch } = vi.hoisted(() => ({ userFetch: vi.fn(), backgroundFetch: vi.fn() }));
const { closeTeamPanel, openTeamDrillDown, closeTeamDrillDown, getTaskSnapshot, teamPanel } = vi.hoisted(() => ({
	closeTeamPanel: vi.fn(), openTeamDrillDown: vi.fn(), closeTeamDrillDown: vi.fn(), getTaskSnapshot: vi.fn(),
	teamPanel: { open: true, agentConfigId: "team-1", teamName: "Release", conversationId: "conversation-1", drillDownAgent: null as any },
}));
vi.mock("$lib/utils/fetch-policy.js", () => ({ userFetch, backgroundFetch }));
vi.mock("$lib/stores.svelte.js", () => ({
	store: { teamPanel }, closeTeamPanel, openTeamDrillDown, closeTeamDrillDown, getTaskSnapshot,
}));

import TeamChatPanel from "./TeamChatPanel.svelte";

const overview = {
	team: { name: "Release", members: [{ agentConfigId: "agent-1", agentName: "Builder" }] },
	orchestrator: {
		agentConfigId: "team-1", agentName: "Release", subConversationId: "orchestrator-1", messages: [
			{ id: "prompt", role: "user", content: "Prepare release", createdAt: "2026-01-01T10:00:00.000Z", toolCalls: [] },
			{ id: "orchestrator-turn", role: "assistant", content: "I will coordinate", createdAt: "2026-01-01T10:00:01.000Z", toolCalls: [] },
		],
	},
	streams: [{
		agentConfigId: "agent-1", agentName: "Builder", subConversationId: "sub-1", messages: [
			{ id: "task", role: "user", content: "Build it", createdAt: "2026-01-01T10:00:00.000Z", toolCalls: [] },
			{ id: "builder-turn", role: "assistant", content: "", createdAt: "2026-01-01T10:00:02.000Z", toolCalls: [{ id: "tool-1", toolName: "edit_file", input: { path: "src/release.ts" }, outputSummary: "Changed release flow", success: true, durationMs: 13, status: "success" }] },
	],
	}],
};

const drillMessages = [
	{ id: "drill-task", role: "user", content: "Build the release", createdAt: "2026-01-01T10:00:00.000Z", toolCalls: [] },
	{ id: "drill-turn-1", role: "assistant", content: "I updated the release notes.", createdAt: "2026-01-01T10:00:01.000Z", toolCalls: [{ id: "drill-tool", toolName: "edit_file", input: { path: "notes.md" }, outputSummary: "Release notes updated", success: true, durationMs: 21, status: "success" }] },
	{ id: "drill-follow-up", role: "user", content: "Also check the changelog", createdAt: "2026-01-01T10:00:02.000Z", toolCalls: [] },
	{ id: "drill-turn-2", role: "assistant", content: "The changelog is ready.", createdAt: "2026-01-01T10:00:03.000Z", toolCalls: [] },
];

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

function jsonResponse(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), { status });
}

beforeEach(() => {
	teamPanel.open = true;
	teamPanel.agentConfigId = "team-1";
	teamPanel.teamName = "Release";
	teamPanel.conversationId = "conversation-1";
	teamPanel.drillDownAgent = null;
	getTaskSnapshot.mockReturnValue({ tasks: [] });
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
	vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} unobserve() {} });
	Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

afterEach(() => {
	if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
	else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
	localStorage.clear();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("TeamChatPanel", () => {
	test("loads the overview, exposes tool details, and opens the selected agent drill-down", async () => {
		userFetch.mockResolvedValue(new Response(JSON.stringify(overview), { status: 200 }));
		render(TeamChatPanel);
		await screen.findByText("@Builder");
		expect(screen.getByText("I will coordinate")).toBeInTheDocument();
		await fireEvent.click(screen.getByText("edit_file"));
		expect(screen.getByText("Changed release flow")).toBeInTheDocument();
		await fireEvent.click(screen.getByText("@Builder"));
		expect(openTeamDrillDown).toHaveBeenCalledWith("sub-1", "Builder", 0);
		expect(userFetch).toHaveBeenCalledWith("/api/conversations/conversation-1/team/team-1/messages");
	});

	test("sends a team chat message to the orchestrator and refreshes the visible timeline", async () => {
		userFetch.mockImplementation(async (url: string, options?: RequestInit) => {
			if (options?.method === "POST") return new Response("{}", { status: 200 });
			return new Response(JSON.stringify(overview), { status: 200 });
		});
		render(TeamChatPanel);
		await screen.findByRole("combobox");
		const input = screen.getByRole("combobox");
		await fireEvent.input(input, { target: { value: "Ask for a status" } });
		await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() => expect(userFetch).toHaveBeenCalledWith(
			"/api/conversations/orchestrator-1/agent-chat",
			expect.objectContaining({ method: "POST", body: JSON.stringify({ content: "Ask for a status" }) }),
		));
		await screen.findByText("Agents are thinking");
	});

	test("keeps the panel usable after an overview failure and closes it through the visible control", async () => {
		userFetch.mockRejectedValue(new Error("offline"));
		render(TeamChatPanel);
		await screen.findByText("No team data available");
		await fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(closeTeamPanel).toHaveBeenCalledTimes(1);
	});

	test("refreshes immediately after an agent completes and polls while the overview remains open", async () => {
		vi.useFakeTimers();
		userFetch.mockImplementation(async () => new Response(JSON.stringify(overview), { status: 200 }));
		backgroundFetch.mockResolvedValue(new Response(JSON.stringify(overview), { status: 200 }));
		render(TeamChatPanel);
		await screen.findByText("@Builder");
		window.dispatchEvent(new Event("ez:agent_complete"));
		await vi.waitFor(() => expect(userFetch).toHaveBeenCalledTimes(2));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(backgroundFetch).toHaveBeenCalledWith(
			"team:conversation-1:team-1",
			"/api/conversations/conversation-1/team/team-1/messages",
			{},
			{ minIntervalMs: 4500 },
		);
	});

	test("shows a selected agent's task, turns, tool details, and drill controls", async () => {
		teamPanel.drillDownAgent = { subConversationId: "sub-1", agentName: "Builder", turnIndex: 1 };
		userFetch.mockResolvedValue(jsonResponse({ messages: drillMessages }));

		render(TeamChatPanel);

		await screen.findByText("Build the release");
		expect(screen.getByText("2 turns")).toBeInTheDocument();
		expect(screen.getByText("1 tool call")).toBeInTheDocument();
		expect(screen.getByText("Also check the changelog")).toBeInTheDocument();
		expect(screen.getByText("I updated the release notes.")).toBeInTheDocument();
		await fireEvent.click(screen.getByText("edit_file"));
		expect(screen.getByText("Release notes updated")).toBeInTheDocument();
		expect(userFetch).toHaveBeenCalledWith("/api/conversations/sub-1/messages?withToolCalls=true");

		await fireEvent.click(screen.getByText("Back to team"));
		await fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(closeTeamDrillDown).toHaveBeenCalledOnce();
		expect(closeTeamPanel).toHaveBeenCalledOnce();
	});

	test("sends to the drilled-in agent then clears the thinking indicator after its completion event", async () => {
		teamPanel.drillDownAgent = { subConversationId: "sub-1", agentName: "Builder", turnIndex: 0 };
		let refreshedMessages = drillMessages;
		userFetch.mockImplementation(async (url: string, options?: RequestInit) => {
			if (url.endsWith("/agent-chat")) return jsonResponse({ ok: true });
			if (url.includes("/team/")) return jsonResponse(overview);
			if (options?.method === "POST") return jsonResponse({ ok: true });
			return jsonResponse({ messages: refreshedMessages });
		});

		render(TeamChatPanel);
		await screen.findByText("Build the release");
		const input = screen.getByRole("combobox");
		await fireEvent.input(input, { target: { value: "Please verify the tag" } });
		await fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(userFetch).toHaveBeenCalledWith(
			"/api/conversations/sub-1/agent-chat",
			expect.objectContaining({ method: "POST", body: JSON.stringify({ content: "Please verify the tag" }) }),
		));
		await screen.findByText("@Builder is thinking");

		refreshedMessages = [...drillMessages, { id: "completed", role: "assistant", content: "The tag is verified.", createdAt: "2026-01-01T10:00:04.000Z", toolCalls: [] }];
		window.dispatchEvent(new Event("ez:agent_complete"));

		await screen.findByText("The tag is verified.");
		await waitFor(() => expect(screen.queryByText("@Builder is thinking")).not.toBeInTheDocument());
		expect(userFetch).toHaveBeenCalledWith("/api/conversations/conversation-1/team/team-1/messages");
	});

	test("polls drill activity and broadcasts when the overview has no orchestrator", async () => {
		vi.useFakeTimers();
		const noOrchestrator = {
			team: overview.team,
			streams: [
				{ ...overview.streams[0], messages: [{ ...overview.streams[0].messages[0] }, { ...overview.streams[0].messages[1], content: "Builder ready" }] },
				{ agentConfigId: "agent-2", agentName: "Reviewer", subConversationId: "sub-2", messages: [{ id: "review-task", role: "user", content: "Review it", createdAt: "2026-01-01T10:00:00.000Z", toolCalls: [] }, { id: "review-turn", role: "assistant", content: "Review ready", createdAt: "2026-01-01T10:00:02.000Z", toolCalls: [] }] },
			],
		};
		teamPanel.drillDownAgent = { subConversationId: "sub-1", agentName: "Builder", turnIndex: 0 };
		userFetch.mockResolvedValue(jsonResponse({ messages: drillMessages }));
		backgroundFetch.mockResolvedValue(jsonResponse({ messages: [...drillMessages, { id: "poll-turn", role: "assistant", content: "Polling update", createdAt: "2026-01-01T10:00:05.000Z", toolCalls: [] }] }));

		const { unmount } = render(TeamChatPanel);
		await screen.findByText("Build the release");
		await vi.advanceTimersByTimeAsync(5000);
		await screen.findByText("Polling update");
		expect(backgroundFetch).toHaveBeenCalledWith("drill:sub-1", "/api/conversations/sub-1/messages?withToolCalls=true", {}, { minIntervalMs: 4500 });
		unmount();

		teamPanel.drillDownAgent = null;
		userFetch.mockImplementation(async (_url: string, options?: RequestInit) => {
			if (options?.method === "POST") return jsonResponse({ ok: true });
			return jsonResponse(noOrchestrator);
		});
		render(TeamChatPanel);
		await screen.findByText("Builder ready");
		const input = screen.getByRole("combobox");
		await fireEvent.input(input, { target: { value: "Tell everyone" } });
		await fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(userFetch).toHaveBeenCalledWith("/api/conversations/sub-1/agent-chat", expect.objectContaining({ method: "POST" })));
		expect(userFetch).toHaveBeenCalledWith("/api/conversations/sub-2/agent-chat", expect.objectContaining({ method: "POST" }));
	});

	test("renders later team messages as user chat bubbles", async () => {
		const withUserMessage = {
			...overview,
			orchestrator: {
				...overview.orchestrator,
				messages: [...overview.orchestrator.messages, { id: "team-follow-up", role: "user", content: "Please publish now", createdAt: "2026-01-01T10:00:03.000Z", toolCalls: [] }],
			},
		};
		userFetch.mockResolvedValue(jsonResponse(withUserMessage));
		render(TeamChatPanel);
		await screen.findByText("Please publish now");
		expect(screen.getByText("You")).toBeInTheDocument();
	});
});
