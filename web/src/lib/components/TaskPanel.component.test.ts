import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import TaskPanel from "./TaskPanel.svelte";

afterEach(() => vi.unstubAllGlobals());

function task(overrides: Record<string, unknown>) {
	return {
		id: "task-1", title: "Default task", description: "", status: "pending", priority: 1,
		subtasks: [], assignments: [], createdAt: "2026-01-01T00:00:00.000Z", ...overrides,
	};
}

describe("TaskPanel", () => {
	test("sorts tasks, expands subtasks, and sends the selected pending task to chat", async () => {
		const onsendmessage = vi.fn();
		const snapshot = {
			conversationId: "conv-1", activeTaskId: "active",
			tasks: [
				task({ id: "later", title: "Later work", priority: 3 }),
				task({ id: "active", title: "Active work", status: "active", priority: 2, startedAt: new Date(Date.now() - 4_000).toISOString() }),
				task({ id: "first", title: "First work", description: "Do this first", priority: 1, subtasks: [{ id: "sub", title: "Check output", completed: false }] }),
			],
		} as any;
		render(TaskPanel, { snapshot, conversationId: "conv-1", onsendmessage });
		const labels = Array.from(document.querySelectorAll("[data-task-id]")).map((el) => el.getAttribute("data-task-id"));
		expect(labels).toEqual(["first", "active", "later"]);
		await fireEvent.click(screen.getByText("First work"));
		expect(onsendmessage).toHaveBeenCalledWith("Work on task: **First work**\n\nDo this first");
		await fireEvent.click(screen.getByRole("button", { name: "Toggle subtasks" }));
		expect(screen.getByText("Check output")).toBeInTheDocument();
	});

	test("renders dependency blocking and does not expose a start action until its prerequisite completes", () => {
		const snapshot = {
			conversationId: "conv-1",
			tasks: [
				task({ id: "blocked", title: "Deploy", dependsOn: ["check"], assignments: [{ id: "assign", agentConfigId: "agent-1", agentName: "Builder", isTeam: false, status: "assigned" }] }),
				task({ id: "check", title: "Check tests", status: "active", priority: 0 }),
			],
		} as any;
		render(TaskPanel, { snapshot, conversationId: "conv-1" });
		expect(screen.getByTestId("blocked-badge")).toHaveTextContent("Waiting for: Check tests");
		expect(screen.getByTestId("assignment-start-blocked")).toHaveAttribute("title", "Waiting for prerequisites: Check tests");
		expect(screen.queryByRole("button", { name: "Start assignment" })).toBeNull();
	});

	test("retries a failed task using the selected model and routes team-pill clicks to team chat", async () => {
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const onteamclick = vi.fn();
		const snapshot = {
			conversationId: "conv-1",
			tasks: [task({ id: "failed", title: "Fix deploy", status: "failed", failureReason: "No credentials", assignments: [{ id: "team-assignment", agentConfigId: "team-1", agentName: "Release", isTeam: true, status: "completed" }] })],
		} as any;
		render(TaskPanel, { snapshot, conversationId: "conv-1", selectedModel: { provider: "openai", model: "gpt-5" }, onteamclick });
		await fireEvent.click(screen.getByText(/Retry/));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conv-1/tasks/failed/retry",
			expect.objectContaining({ method: "POST", body: JSON.stringify({ provider: "openai", model: "gpt-5" }) }),
		));
		await fireEvent.click(screen.getByText("@Release"));
		expect(onteamclick).toHaveBeenCalledWith("team-1", "Release");
	});

	test("shows finished states and drives start and stop assignment endpoints from their visible controls", async () => {
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const snapshot = {
			conversationId: "conv-1",
			tasks: [
				task({ id: "done", title: "Completed", status: "completed", priority: 0, completionSummary: "Release checked", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:05.000Z" }),
				task({ id: "start", title: "Ready", priority: 1, assignments: [{ id: "assigned", agentConfigId: "agent", agentName: "Starter", isTeam: false, status: "assigned" }] }),
				task({ id: "stop", title: "Running", status: "active", priority: 2, assignments: [{ id: "running", agentConfigId: "agent", agentName: "Runner", isTeam: false, status: "running", startedAt: new Date(Date.now() - 1000).toISOString() }] }),
			],
		} as any;
		render(TaskPanel, { snapshot, conversationId: "conv-1" });
		expect(screen.getByText("Release checked")).toBeInTheDocument();
		await fireEvent.click(screen.getByTitle("Start assignment"));
		await fireEvent.click(screen.getByTitle("Stop assignment (preserves context for resume)"));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conv-1/tasks/start/assignments/assigned/start",
			expect.objectContaining({ method: "POST" }),
		));
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/conv-1/tasks/stop/assignments/running/stop",
			expect.objectContaining({ method: "POST" }),
		);
	});

	test("opens an assigned task through its detail callback and reports the collapsed mixed-result summary", async () => {
		const ontaskclick = vi.fn();
		const snapshot = {
			conversationId: "conv-1",
			tasks: Array.from({ length: 13 }, (_, index) => task({
				id: `task-${index}`, title: `Task ${index}`, priority: index,
				status: index === 0 ? "completed" : index === 1 ? "failed" : "pending",
				assignments: index === 2 ? [{ id: "detail", agentConfigId: "agent", agentName: "Detail", isTeam: false, status: "completed", subConversationId: "sub-1" }] : [],
			})),
		} as any;
		render(TaskPanel, { snapshot, conversationId: "conv-1", ontaskclick });
		expect(screen.getByText("+1")).toBeInTheDocument();
		expect(screen.getByText(/1 failed/)).toBeInTheDocument();
		await fireEvent.click(screen.getByText("@Detail"));
		expect(ontaskclick).toHaveBeenCalledWith(expect.objectContaining({ id: "task-2" }));
		await fireEvent.click(screen.getByRole("button", { name: "Collapse task panel" }));
		expect(screen.getByRole("button", { name: "Expand task panel" })).toBeInTheDocument();
	});
});
