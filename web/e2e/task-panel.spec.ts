import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

// ── Shape of a task as the TaskPanel component consumes it ──────────────────
// Mirrors src/runtime/tools/task-tracking.ts `TrackedTask` / `TaskSnapshot`.
interface TestSubtask {
	id: string;
	title: string;
	completed: boolean;
	position: number;
}

interface TestTask {
	id: string;
	title: string;
	description: string;
	status: "pending" | "active" | "completed" | "failed";
	priority: number;
	subtasks: TestSubtask[];
	agentId?: string;
	agentName?: string;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	failedAt?: string;
	failureReason?: string;
	completionSummary?: string;
}

interface TestTaskSnapshot {
	conversationId: string;
	tasks: TestTask[];
	activeTaskId?: string;
}

// ── Factory helpers ─────────────────────────────────────────────────────────

function makeTask(overrides: Partial<TestTask> & { id: string; title: string }): TestTask {
	return {
		description: "",
		status: "pending",
		priority: 0,
		subtasks: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function makeSubtask(overrides: Partial<TestSubtask> & { id: string; title: string }): TestSubtask {
	return {
		completed: false,
		position: 0,
		...overrides,
	};
}

function makeSnapshot(
	conversationId: string,
	tasks: TestTask[],
	activeTaskId?: string,
): TestTaskSnapshot {
	return { conversationId, tasks, activeTaskId };
}

// Pattern matched by the `routes` override (uses String.includes).
// The path is `/api/conversations/:id/tasks` — `/tasks` uniquely identifies it.
const TASKS_ROUTE_PATTERN = "/tasks";

test.describe("Task Panel", () => {
	const proj = makeProject({ id: "proj-1", name: "Task Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Task Convo" });

	test("is hidden when conversation has no tasks", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: {
				[TASKS_ROUTE_PATTERN]: () => ({ conversationId: "conv-1", tasks: [] }),
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Chat should load normally (input visible)
		await expect(page.locator("textarea").first()).toBeVisible();

		// Panel is not rendered at all when tasks.length === 0
		// (+page.svelte gates on `hasActiveTasks = !!taskSnapshot && tasks.length > 0`)
		await expect(page.getByText("Tasks", { exact: true })).not.toBeVisible();
	});

	test("shows counter, progress bar and all tasks when tasks exist", async ({ page, mockApi }) => {
		const snapshot = makeSnapshot(
			"conv-1",
			[
				makeTask({ id: "t1", title: "Set up repo", status: "completed", priority: 0 }),
				makeTask({ id: "t2", title: "Write tests", status: "active", priority: 1 }),
				makeTask({ id: "t3", title: "Deploy to prod", status: "pending", priority: 2 }),
			],
			"t2",
		);

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Tasks label renders inside the collapsed-header button
		await expect(page.getByText("Tasks", { exact: true })).toBeVisible();

		// "1/3" counter (1 completed out of 3)
		await expect(page.getByText("1/3", { exact: true })).toBeVisible();

		// All three task titles visible (panel starts expanded)
		await expect(page.getByText("Set up repo")).toBeVisible();
		await expect(page.getByText("Write tests")).toBeVisible();
		await expect(page.getByText("Deploy to prod")).toBeVisible();

		// Progress bar fill width reflects 33% (1/3 rounded)
		const progressBarFill = page.locator('[style*="width: 33%"]').first();
		await expect(progressBarFill).toBeVisible();
	});

	test("renders progress dots with correct status colors and a failed counter", async ({ page, mockApi }) => {
		const snapshot = makeSnapshot("conv-1", [
			makeTask({ id: "t1", title: "One", status: "completed", priority: 0 }),
			makeTask({ id: "t2", title: "Two", status: "completed", priority: 1 }),
			makeTask({ id: "t3", title: "Three", status: "active", priority: 2 }),
			makeTask({
				id: "t4",
				title: "Four",
				status: "failed",
				priority: 3,
				failedAt: "2026-01-01T00:01:00.000Z",
				failureReason: "Network error",
			}),
			makeTask({ id: "t5", title: "Five", status: "pending", priority: 4 }),
			makeTask({ id: "t6", title: "Six", status: "pending", priority: 5 }),
		]);

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Counter: "2/6" + " · 1 failed"
		await expect(page.getByText("2/6", { exact: true })).toBeVisible();
		await expect(page.getByText("· 1 failed")).toBeVisible();

		// Dots: the component caps displayed dots at 12; with 6 tasks we expect 6 dots.
		// Dots are spans with `rounded-full` + a status color class, inside the header button.
		const greenDots = page.locator("button span.bg-green-500.rounded-full");
		await expect(greenDots).toHaveCount(2);

		const blueDots = page.locator("button span.bg-blue-400.rounded-full");
		await expect(blueDots).toHaveCount(1);

		const redDots = page.locator("button span.bg-red-500.rounded-full");
		await expect(redDots).toHaveCount(1);
	});

	test("collapses and expands when header is clicked", async ({ page, mockApi }) => {
		const snapshot = makeSnapshot("conv-1", [
			makeTask({ id: "t1", title: "First collapsible task", status: "active", priority: 0 }),
			makeTask({ id: "t2", title: "Second collapsible task", status: "pending", priority: 1 }),
		]);

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const header = page.getByRole("button", { name: /Collapse task panel|Expand task panel/ });
		await expect(header).toBeVisible();

		// Initial state: expanded — list rows are visible
		await expect(page.getByText("First collapsible task")).toBeVisible();
		await expect(page.getByText("Second collapsible task")).toBeVisible();

		// Click to collapse
		await header.click();
		await expect(page.getByText("Second collapsible task")).not.toBeVisible();

		// Click to expand
		await header.click();
		await expect(page.getByText("Second collapsible task")).toBeVisible();
	});

	test("highlights the active task row with border and background tint", async ({ page, mockApi }) => {
		const snapshot = makeSnapshot(
			"conv-1",
			[
				makeTask({ id: "t1", title: "Done already", status: "completed", priority: 0 }),
				makeTask({ id: "t2", title: "Currently working", status: "active", priority: 1 }),
				makeTask({ id: "t3", title: "Waiting", status: "pending", priority: 2 }),
			],
			"t2",
		);

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// The row wrapping the active task gets `bg-blue-500` (via class:bg-blue-500={isActive}).
		// Locate the div.group that contains the active title and check it carries that class.
		const activeRowWrapper = page.locator("div.group", { hasText: "Currently working" });
		await expect(activeRowWrapper).toHaveClass(/bg-blue-500/);
		await expect(activeRowWrapper).toHaveClass(/bg-opacity-5/);

		// Inner row should have `border-l-2` + `border-blue-400` (active styling).
		const activeRowInner = activeRowWrapper.locator(".border-l-2.border-blue-400");
		await expect(activeRowInner).toBeVisible();
	});

	test("subtasks expand and collapse via chevron click", async ({ page, mockApi }) => {
		const snapshot = makeSnapshot("conv-1", [
			makeTask({
				id: "t1",
				title: "Task with subtasks",
				status: "active",
				priority: 0,
				subtasks: [
					makeSubtask({ id: "s1", title: "Sub alpha done", completed: true, position: 0 }),
					makeSubtask({ id: "s2", title: "Sub bravo done", completed: true, position: 1 }),
					makeSubtask({ id: "s3", title: "Sub charlie open", completed: false, position: 2 }),
				],
			}),
		]);

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Parent task title rendered with subtask counter (2/3)
		await expect(page.getByText("Task with subtasks")).toBeVisible();
		await expect(page.getByText("(2/3)")).toBeVisible();

		// Subtasks hidden initially
		await expect(page.getByText("Sub alpha done")).not.toBeVisible();
		await expect(page.getByText("Sub charlie open")).not.toBeVisible();

		// Click the subtask toggle chevron
		const toggleBtn = page.getByRole("button", { name: "Toggle subtasks" });
		await toggleBtn.click();

		// Subtask titles now visible
		await expect(page.getByText("Sub alpha done")).toBeVisible();
		await expect(page.getByText("Sub bravo done")).toBeVisible();
		await expect(page.getByText("Sub charlie open")).toBeVisible();

		// Completed subtasks get `bg-green-500` on the checkbox span, incomplete do not.
		// There are 2 completed subtask checkboxes.
		const completedBoxes = page
			.locator(".pb-1.pl-9 span.bg-green-500.rounded-sm");
		await expect(completedBoxes).toHaveCount(2);
	});

	test("shows @agent badge when task has agentName", async ({ page, mockApi }) => {
		const snapshot = makeSnapshot("conv-1", [
			makeTask({
				id: "t1",
				title: "Assigned task",
				status: "active",
				priority: 0,
				agentName: "coder",
				agentId: "cfg-coder",
			}),
			makeTask({ id: "t2", title: "Unassigned task", status: "pending", priority: 1 }),
		]);

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("@coder")).toBeVisible();
		// Unassigned task should not render a badge
		await expect(page.getByText("@coder")).toHaveCount(1);
	});

	test("shows failure reason under a failed task", async ({ page, mockApi }) => {
		const snapshot = makeSnapshot("conv-1", [
			makeTask({ id: "t1", title: "Build step", status: "completed", priority: 0 }),
			makeTask({
				id: "t2",
				title: "Broken step",
				status: "failed",
				priority: 1,
				failedAt: "2026-01-01T00:01:00.000Z",
				failureReason: "DB connection refused",
			}),
		]);

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("Broken step")).toBeVisible();
		await expect(page.getByText("DB connection refused")).toBeVisible();
		// Failure reason uses italic + red text
		const reason = page.getByText("DB connection refused");
		await expect(reason).toHaveClass(/italic/);
	});

	test("clicking a pending task sends a 'Work on task: ...' message", async ({ page, mockApi }) => {
		const snapshot = makeSnapshot("conv-1", [
			makeTask({
				id: "t1",
				title: "Refactor billing",
				description: "Clean up the billing module",
				status: "pending",
				priority: 0,
			}),
		]);

		// Capture POSTed messages so we can assert the user clicked → message sent.
		const sentMessages: string[] = [];
		await page.route("**/api/conversations/*/messages", async (route) => {
			if (route.request().method() === "POST") {
				const body = route.request().postDataJSON();
				if (body?.content) sentMessages.push(String(body.content));
				return route.fulfill({
					json: {
						userMessage: {
							id: "sent-msg-1",
							conversationId: "conv-1",
							role: "user",
							content: body?.content ?? "",
							model: null,
							provider: null,
							usage: null,
							runId: null,
							parentMessageId: null,
							createdAt: "2026-01-01T00:00:00.000Z",
						},
						runId: "run-task-click",
					},
				});
			}
			// GET falls through to mockApi default
			return route.continue();
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Pending task is rendered as a button (only pending tasks are clickable)
		const taskButton = page.getByRole("button", { name: /Refactor billing/ });
		await expect(taskButton).toBeVisible();
		await taskButton.click();

		// The component calls onsendmessage("Work on task: **{title}**\n\n{description}")
		// which the chat page wires to handleSend → POST /api/conversations/:id/messages.
		await expect.poll(() => sentMessages.length, { timeout: 5000 }).toBeGreaterThan(0);

		const msg = sentMessages[0]!;
		expect(msg).toContain("Work on task:");
		expect(msg).toContain("Refactor billing");
	});

	test("updates reactively when a task:snapshot WebSocket event fires", async ({ page, mockApi, emitWs }) => {
		const initial = makeSnapshot(
			"conv-1",
			[
				makeTask({ id: "t1", title: "Initial only task", status: "active", priority: 0 }),
			],
			"t1",
		);

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => initial },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("Initial only task")).toBeVisible();
		// Counter starts at 0/1
		await expect(page.getByText("0/1", { exact: true })).toBeVisible();

		// Push a new snapshot via the fake WebSocket
		await emitWs({
			type: "task:snapshot",
			data: {
				conversationId: "conv-1",
				tasks: [
					makeTask({ id: "t1", title: "Initial only task", status: "completed", priority: 0 }),
					makeTask({ id: "t2", title: "Newly added task", status: "active", priority: 1 }),
				],
				activeTaskId: "t2",
			},
		});

		// Panel reflects the new state: second task appears, counter flips to 1/2
		await expect(page.getByText("Newly added task")).toBeVisible();
		await expect(page.getByText("1/2", { exact: true })).toBeVisible();
	});
});

// ── Task assignments E2E ────────────────────────────────────────────────

test.describe("task assignments", () => {
	const proj = makeProject({ id: "proj-asgn", name: "Assignment Project" });
	const conv = makeConversation({ id: "conv-asgn", projectId: "proj-asgn", title: "Assignment Convo" });

	// Helper: a task with assignment data baked in
	interface TestAssignment {
		id: string;
		agentConfigId: string;
		agentName: string;
		isTeam: boolean;
		status: "assigned" | "running" | "completed" | "failed";
		assignedAt: string;
		startedAt?: string;
		completedAt?: string;
		failedAt?: string;
		subConversationId?: string;
		agentRunId?: string;
		resultPreview?: string;
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

	// Extend the existing TestTask shape to include assignments
	interface TestTaskWithAssignments {
		id: string;
		title: string;
		description: string;
		status: "pending" | "active" | "completed" | "failed";
		priority: number;
		subtasks: Array<{ id: string; title: string; completed: boolean; position: number }>;
		agentId?: string;
		agentName?: string;
		assignments: TestAssignment[];
		createdAt: string;
		startedAt?: string;
		completedAt?: string;
		failedAt?: string;
		failureReason?: string;
		completionSummary?: string;
	}

	function makeTaskWithAssignments(
		overrides: Partial<TestTaskWithAssignments> & { id: string; title: string },
	): TestTaskWithAssignments {
		return {
			description: "",
			status: "pending",
			priority: 0,
			subtasks: [],
			assignments: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			...overrides,
		};
	}

	test("task with assignments renders assignment pills showing agent names", async ({ page, mockApi }) => {
		const snapshot = {
			conversationId: "conv-asgn",
			tasks: [
				makeTaskWithAssignments({
					id: "t1",
					title: "Build feature",
					status: "active",
					priority: 0,
					assignments: [
						makeAssignment({ id: "a1", agentName: "coder" }),
					],
				}),
			],
			activeTaskId: "t1",
		};

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Task title visible
		await expect(page.getByText("Build feature")).toBeVisible();
		// Assignment pill shows agent name
		await expect(page.getByText("@coder")).toBeVisible();
	});

	test("assignment pill shows 'team' badge for team assignments", async ({ page, mockApi }) => {
		const snapshot = {
			conversationId: "conv-asgn",
			tasks: [
				makeTaskWithAssignments({
					id: "t1",
					title: "Coordinate deploy",
					status: "active",
					priority: 0,
					assignments: [
						makeAssignment({ id: "a1", agentName: "ops-team", isTeam: true }),
					],
				}),
			],
			activeTaskId: "t1",
		};

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("@ops-team")).toBeVisible();
		// Team SVG icon has a title attribute "Team"
		await expect(page.locator('[title="Team"]')).toBeVisible();
	});

	test("running assignment shows elapsed timer", async ({ page, mockApi }) => {
		// startedAt is set to a fixed time; we can't control `Date.now()` in
		// the browser, but the component renders a timer based on real time.
		// We just verify the timer element appears for a running assignment.
		const snapshot = {
			conversationId: "conv-asgn",
			tasks: [
				makeTaskWithAssignments({
					id: "t1",
					title: "Long running task",
					status: "active",
					priority: 0,
					startedAt: "2026-01-01T00:00:00.000Z",
					assignments: [
						makeAssignment({
							id: "a1",
							agentName: "worker",
							status: "running",
							startedAt: new Date(Date.now() - 45_000).toISOString(),
						}),
					],
				}),
			],
			activeTaskId: "t1",
		};

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("@worker")).toBeVisible();
		// The timer displays tabular-nums text — look for a span with the class
		const timerSpan = page.locator("span.tabular-nums");
		await expect(timerSpan.first()).toBeVisible();
	});

	test("completed assignment shows green check icon", async ({ page, mockApi }) => {
		const snapshot = {
			conversationId: "conv-asgn",
			tasks: [
				makeTaskWithAssignments({
					id: "t1",
					title: "Done task",
					status: "completed",
					priority: 0,
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: "2026-01-01T00:05:00.000Z",
					assignments: [
						makeAssignment({
							id: "a1",
							agentName: "finisher",
							status: "completed",
							startedAt: "2026-01-01T00:00:00.000Z",
							completedAt: "2026-01-01T00:05:00.000Z",
						}),
					],
				}),
			],
		};

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("@finisher")).toBeVisible();
		// Completed assignment renders an SVG with a checkmark path (stroke "M5 13l4 4L19 7")
		const checkSvg = page.locator('svg path[d="M5 13l4 4L19 7"]');
		await expect(checkSvg.first()).toBeVisible();
	});

	test("assign (+) button appears on task row hover", async ({ page, mockApi }) => {
		const snapshot = {
			conversationId: "conv-asgn",
			tasks: [
				makeTaskWithAssignments({
					id: "t1",
					title: "Hoverable task",
					status: "pending",
					priority: 0,
				}),
			],
		};

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// The "+" button has title "Assign agent or team" and starts with opacity-0
		const assignBtn = page.getByRole("button", { name: "Assign agent or team" });
		// Before hover it exists in DOM but is invisible (opacity-0)
		await expect(assignBtn).toBeAttached();

		// Hover over the task row to reveal the button
		const taskRow = page.locator("div.group", { hasText: "Hoverable task" });
		await taskRow.hover();

		// After hover, group-hover:opacity-100 makes it visible
		await expect(assignBtn).toBeVisible();
	});

	test("multiple assignments on same task render correctly", async ({ page, mockApi }) => {
		const snapshot = {
			conversationId: "conv-asgn",
			tasks: [
				makeTaskWithAssignments({
					id: "t1",
					title: "Multi-agent task",
					status: "active",
					priority: 0,
					assignments: [
						makeAssignment({ id: "a1", agentName: "coder", status: "running", startedAt: new Date(Date.now() - 10_000).toISOString() }),
						makeAssignment({ id: "a2", agentName: "reviewer", status: "assigned" }),
						makeAssignment({ id: "a3", agentName: "ops-team", isTeam: true, status: "completed", completedAt: "2026-01-01T00:05:00.000Z" }),
					],
				}),
			],
			activeTaskId: "t1",
		};

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// All three agent names visible
		await expect(page.getByText("@coder")).toBeVisible();
		await expect(page.getByText("@reviewer")).toBeVisible();
		await expect(page.getByText("@ops-team")).toBeVisible();

		// Team badge for ops-team
		await expect(page.locator('[title="Team"]')).toBeVisible();
	});

	test("task with assignments hides legacy agent badge", async ({ page, mockApi }) => {
		const snapshot = {
			conversationId: "conv-asgn",
			tasks: [
				makeTaskWithAssignments({
					id: "t1",
					title: "Modern task",
					status: "active",
					priority: 0,
					agentName: "coder",
					assignments: [
						makeAssignment({ id: "a1", agentName: "coder", status: "running" }),
					],
				}),
			],
			activeTaskId: "t1",
		};

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => snapshot },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// The assignment pill shows @coder
		await expect(page.getByText("@coder")).toBeVisible();
		// But it should NOT be rendered as a purple legacy badge.
		// The legacy badge uses bg-purple-500/20 class — verify none exist.
		const legacyBadges = page.locator("span.bg-purple-500\\/20");
		await expect(legacyBadges).toHaveCount(0);
	});

	test("assignment snapshot updates reactively via WebSocket", async ({ page, mockApi, emitWs }) => {
		const initial = {
			conversationId: "conv-asgn",
			tasks: [
				makeTaskWithAssignments({
					id: "t1",
					title: "Evolving task",
					status: "active",
					priority: 0,
					assignments: [
						makeAssignment({ id: "a1", agentName: "coder", status: "assigned" }),
					],
				}),
			],
			activeTaskId: "t1",
		};

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => initial },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("@coder")).toBeVisible();

		// Push an updated snapshot with a new assignment added
		await emitWs({
			type: "task:snapshot",
			data: {
				conversationId: "conv-asgn",
				tasks: [
					makeTaskWithAssignments({
						id: "t1",
						title: "Evolving task",
						status: "active",
						priority: 0,
						assignments: [
							makeAssignment({ id: "a1", agentName: "coder", status: "running", startedAt: new Date().toISOString() }),
							makeAssignment({ id: "a2", agentName: "reviewer", status: "assigned" }),
						],
					}),
				],
				activeTaskId: "t1",
			},
		});

		// Both assignments now visible
		await expect(page.getByText("@coder")).toBeVisible();
		await expect(page.getByText("@reviewer")).toBeVisible();
	});
});
