import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

// Observability + interruptibility of the opt-in autonomous
// self-continuation loop. The loop itself is host-side; what the user
// must be able to see is the cycle counter on the running assignment
// pill, and what they must be able to do is Stop it. Both are asserted
// here against the TaskPanel → AssignmentPill render path.

const TASKS_ROUTE_PATTERN = "/tasks";

interface TestAssignment {
	id: string;
	agentConfigId: string;
	agentName: string;
	isTeam: boolean;
	status: "assigned" | "running" | "completed" | "failed";
	assignedAt: string;
	startedAt?: string;
	subConversationId?: string;
	agentRunId?: string;
	autonomousCycle?: number;
	autonomousMaxCycles?: number;
}

function makeAssignment(
	overrides: Partial<TestAssignment> & { id: string; agentName: string },
): TestAssignment {
	return {
		agentConfigId: "cfg-default",
		isTeam: false,
		status: "assigned",
		assignedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function snapshotWith(assignments: TestAssignment[]) {
	return {
		conversationId: "conv-auto",
		tasks: [
			{
				id: "t1",
				title: "Open-ended objective",
				description: "",
				status: "active" as const,
				priority: 0,
				subtasks: [],
				assignments,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		],
		activeTaskId: "t1",
	};
}

test.describe("Autonomous continuation — observable + stoppable", () => {
	const proj = makeProject({ id: "proj-auto", name: "Autonomous Project" });
	const conv = makeConversation({ id: "conv-auto", projectId: "proj-auto", title: "Autonomous Convo" });

	test("running autonomous assignment shows the cycle counter and a Stop button", async ({ page, mockApi }) => {
		const snapshot = snapshotWith([
			makeAssignment({
				id: "a1",
				agentName: "worker",
				status: "running",
				startedAt: "2026-01-01T00:00:00.000Z",
				subConversationId: "sub-1",
				agentRunId: "run-1",
				autonomousCycle: 2,
				autonomousMaxCycles: 8,
			}),
		]);

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("@worker")).toBeVisible();

		// Cycle counter is visible and reports n/m.
		const cycle = page.getByTestId("autonomous-cycle");
		await expect(cycle).toBeVisible();
		await expect(cycle).toHaveText("↻2/8");
		await expect(cycle).toHaveAttribute(
			"title",
			"Autonomous self-continuation cycle 2 of 8",
		);

		// Kill switch: a running assignment exposes Stop (halts the loop
		// host-side via run:cancel → the status guard in start-assignment).
		await expect(
			page.getByTitle("Stop assignment (preserves context for resume)"),
		).toBeVisible();
	});

	test("non-autonomous running assignment does NOT show the cycle counter", async ({ page, mockApi }) => {
		const snapshot = snapshotWith([
			makeAssignment({
				id: "a1",
				agentName: "worker",
				status: "running",
				startedAt: "2026-01-01T00:00:00.000Z",
				subConversationId: "sub-1",
				agentRunId: "run-1",
				// no autonomousCycle → opt-in is off
			}),
		]);

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("@worker")).toBeVisible();
		await expect(page.getByTestId("autonomous-cycle")).not.toBeVisible();
	});
});
