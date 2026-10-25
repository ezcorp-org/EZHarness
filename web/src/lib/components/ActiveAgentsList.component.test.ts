import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import ActiveAgentsList from "./ActiveAgentsList.svelte";

const agent = (runId: string, projectId: string | null, agentName = `agent-${runId}`) => ({
	runId,
	agentName,
	conversationId: `conv-${runId}`,
	parentConversationId: null,
	projectId,
	conversationTitle: null,
	startedAt: Date.now(),
});

/** Answers `/api/active-agents` and `/api/projects` from the given bodies; a number is an HTTP error status. */
function stubFetch(routes: { agents: unknown; projects?: unknown }) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		const body = url.startsWith("/api/projects") ? routes.projects : routes.agents;
		if (typeof body === "number") return new Response("", { status: body });
		if (body instanceof Error) throw body;
		return Response.json(body);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("ActiveAgentsList", () => {
	test("shows the HTTP failure when the agent list cannot load", async () => {
		stubFetch({ agents: 503 });
		render(ActiveAgentsList, { pollMs: 60_000 });
		expect(await screen.findByText("Failed to load: HTTP 503")).toBeInTheDocument();
	});

	test("shows a thrown non-Error failure as text", async () => {
		vi.stubGlobal("fetch", vi.fn(() => Promise.reject("offline")));
		render(ActiveAgentsList, { pollMs: 60_000 });
		expect(await screen.findByText("Failed to load: offline")).toBeInTheDocument();
	});

	test("says so when no agent is running", async () => {
		stubFetch({ agents: [] });
		render(ActiveAgentsList, { pollMs: 60_000 });
		expect(await screen.findByText("No active agents right now.")).toBeInTheDocument();
	});

	test("lists running agents ungrouped, scoped to the project it is given", async () => {
		const fetchMock = stubFetch({ agents: [agent("run-0001", "p1", "Planner"), agent("run-0002", null, "Builder")] });
		render(ActiveAgentsList, { projectId: "p 1", pollMs: 60_000 });
		expect(await screen.findByText("Planner")).toBeInTheDocument();
		expect(screen.getByText("Builder")).toBeInTheDocument();
		expect(screen.queryByTestId("active-agents-grouped")).toBeNull();
		expect(fetchMock).toHaveBeenCalledWith("/api/active-agents?projectId=p%201");
		expect(fetchMock).not.toHaveBeenCalledWith("/api/projects");
	});

	test("shows a run's conversation title and its elapsed minutes", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
		stubFetch({
			agents: [{ ...agent("run-0003", null, "Reviewer"), conversationTitle: "Fix the login", startedAt: Date.now() - 150_000 }],
		});
		render(ActiveAgentsList, { pollMs: 60_000 });
		expect(await screen.findByText("— Fix the login")).toBeInTheDocument();
		expect(screen.getByText("2m 30s")).toBeInTheDocument();
	});

	test("groups agents by project name with the unassigned group last", async () => {
		stubFetch({
			agents: [agent("r2", "p2"), agent("r1", null), agent("r3", "p1"), agent("r4", null)],
			projects: [{ id: "p1", name: "alpha" }, { id: "p2", name: "Beta" }],
		});
		render(ActiveAgentsList, { groupByProject: true, pollMs: 60_000 });
		await screen.findByTestId("active-agents-grouped");
		const headings = screen.getAllByTestId("active-agents-group-heading").map((h) => h.textContent?.replace(/\s+/g, " ").trim());
		expect(headings).toEqual(["alpha (1)", "Beta (1)", "Unassigned (2)"]);
	});

	test("polls on its interval and stops when it is destroyed", async () => {
		vi.useFakeTimers();
		const fetchMock = stubFetch({ agents: [] });
		const { unmount } = render(ActiveAgentsList, { pollMs: 1_000 });
		await vi.advanceTimersByTimeAsync(2_500);
		const calls = fetchMock.mock.calls.length;
		expect(calls).toBe(3);
		unmount();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fetchMock.mock.calls.length).toBe(calls);
	});
});
