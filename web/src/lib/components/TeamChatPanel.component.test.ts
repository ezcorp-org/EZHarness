import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { userFetch, backgroundFetch } = vi.hoisted(() => ({ userFetch: vi.fn(), backgroundFetch: vi.fn() }));
const { closeTeamPanel, openTeamDrillDown, closeTeamDrillDown, getTaskSnapshot, teamPanel } = vi.hoisted(() => ({
	closeTeamPanel: vi.fn(), openTeamDrillDown: vi.fn(), closeTeamDrillDown: vi.fn(), getTaskSnapshot: vi.fn(),
	teamPanel: { open: true, agentConfigId: "team-1", teamName: "Release", conversationId: "conversation-1", drillDown: null as any },
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

beforeEach(() => {
	teamPanel.open = true;
	teamPanel.agentConfigId = "team-1";
	teamPanel.teamName = "Release";
	teamPanel.conversationId = "conversation-1";
	teamPanel.drillDown = null;
	getTaskSnapshot.mockReturnValue({ tasks: [] });
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
	vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} unobserve() {} });
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
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
});
