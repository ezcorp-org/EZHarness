import { describe, test, expect } from "bun:test";

/**
 * Logic tests for assignment-related behavior in TaskPanel.svelte.
 *
 * Svelte 5 runes can't run under bun:test, so we mirror the component's
 * pure decision logic as plain functions and exercise them directly.
 *
 * Mirrors `handleTaskClick` (lines 105–113) and the assignment/badge
 * visibility guards (lines 288–315) of TaskPanel.svelte.
 */

// ── Types mirrored from stores.svelte.ts ────────────────────────────────

type AssignmentStatus = "assigned" | "running" | "completed" | "failed";

interface TaskAssignment {
	id: string;
	agentConfigId: string;
	agentName: string;
	isTeam: boolean;
	status: AssignmentStatus;
	assignedAt: string;
	startedAt?: string;
	completedAt?: string;
	failedAt?: string;
	subConversationId?: string;
	agentRunId?: string;
	resultPreview?: string;
}

type TaskStatus = "pending" | "active" | "completed" | "failed";

interface TrackedSubtask {
	id: string;
	title: string;
	completed: boolean;
	position: number;
}

interface TaskPanelTask {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	agentId?: string;
	agentName?: string;
	subtasks: TrackedSubtask[];
	assignments: TaskAssignment[];
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	failedAt?: string;
	failureReason?: string;
	completionSummary?: string;
	priority: number;
}

// ── Pure logic extracted from TaskPanel.svelte ───────────────────────────

/**
 * Mirrors `handleTaskClick` at lines 105–113 of TaskPanel.svelte.
 *
 * Returns:
 *   "ontaskclick" — the component would call ontaskclick(task)
 *   "onsendmessage" — the component would call onsendmessage(message)
 *   "noop" — the click is a no-op
 *
 * @param hasOntaskclick Whether ontaskclick prop is provided
 * @param hasOnsendmessage Whether onsendmessage prop is provided
 */
function handleTaskClickAction(
	task: TaskPanelTask,
	hasOntaskclick: boolean,
	hasOnsendmessage: boolean,
): "ontaskclick" | "onsendmessage" | "noop" {
	// Branch 1: has assignments + ontaskclick → use ontaskclick
	if (task.assignments?.length > 0 && hasOntaskclick) {
		return "ontaskclick";
	}
	// Branch 2: no assignments, pending, onsendmessage → use onsendmessage
	if (task.status !== "pending" || !hasOnsendmessage) return "noop";
	return "onsendmessage";
}

/**
 * Mirrors the message built by handleTaskClick when it calls onsendmessage.
 * Lines 111–112 of TaskPanel.svelte.
 */
function buildTaskClickMessage(task: TaskPanelTask): string {
	const desc = task.description ? `\n\n${task.description}` : "";
	return `Work on task: **${task.title}**${desc}`;
}

/**
 * Whether assignment pills should be rendered for a task.
 * Mirrors lines 298–315 of TaskPanel.svelte:
 *   `{#if task.assignments?.length > 0}`
 */
function showAssignmentPills(task: TaskPanelTask): boolean {
	return (task.assignments?.length ?? 0) > 0;
}

/**
 * Whether the legacy agent badge should be shown.
 * Mirrors lines 288–295 of TaskPanel.svelte:
 *   `{#if task.agentName && !(task.assignments?.length > 0)}`
 */
function showLegacyAgentBadge(task: TaskPanelTask): boolean {
	return !!task.agentName && !(task.assignments?.length > 0);
}

// ── Factory ─────────────────────────────────────────────────────────────

let _id = 0;

function makeAssignment(overrides: Partial<TaskAssignment> = {}): TaskAssignment {
	return {
		id: overrides.id ?? `asgn-${++_id}`,
		agentConfigId: overrides.agentConfigId ?? "cfg-1",
		agentName: overrides.agentName ?? "coder",
		isTeam: overrides.isTeam ?? false,
		status: overrides.status ?? "assigned",
		assignedAt: overrides.assignedAt ?? "2026-01-01T00:00:00Z",
		startedAt: overrides.startedAt,
		completedAt: overrides.completedAt,
		failedAt: overrides.failedAt,
		subConversationId: overrides.subConversationId,
		agentRunId: overrides.agentRunId,
		resultPreview: overrides.resultPreview,
	};
}

function makeTask(overrides: Partial<TaskPanelTask> = {}): TaskPanelTask {
	return {
		id: overrides.id ?? `task-${++_id}`,
		title: overrides.title ?? "Untitled",
		description: overrides.description ?? "",
		status: overrides.status ?? "pending",
		agentId: overrides.agentId,
		agentName: overrides.agentName,
		subtasks: overrides.subtasks ?? [],
		assignments: overrides.assignments ?? [],
		createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
		startedAt: overrides.startedAt,
		completedAt: overrides.completedAt,
		failedAt: overrides.failedAt,
		failureReason: overrides.failureReason,
		completionSummary: overrides.completionSummary,
		priority: overrides.priority ?? 0,
	};
}

// ── handleTaskClickAction ───────────────────────────────────────────────

describe("handleTaskClickAction", () => {
	test("task with assignments + ontaskclick → calls ontaskclick", () => {
		const task = makeTask({
			status: "active",
			assignments: [makeAssignment()],
		});
		expect(handleTaskClickAction(task, true, true)).toBe("ontaskclick");
	});

	test("task with assignments + ontaskclick, regardless of status → ontaskclick", () => {
		for (const status of ["pending", "active", "completed", "failed"] as TaskStatus[]) {
			const task = makeTask({ status, assignments: [makeAssignment()] });
			expect(handleTaskClickAction(task, true, true)).toBe("ontaskclick");
		}
	});

	test("task with assignments but no ontaskclick → falls through to onsendmessage or noop", () => {
		const task = makeTask({
			status: "pending",
			assignments: [makeAssignment()],
		});
		// No ontaskclick, but has onsendmessage → falls to second branch
		expect(handleTaskClickAction(task, false, true)).toBe("onsendmessage");
	});

	test("task without assignments + pending + onsendmessage → calls onsendmessage", () => {
		const task = makeTask({ status: "pending", assignments: [] });
		expect(handleTaskClickAction(task, true, true)).toBe("onsendmessage");
	});

	test("task without assignments + active → noop", () => {
		const task = makeTask({ status: "active", assignments: [] });
		expect(handleTaskClickAction(task, true, true)).toBe("noop");
	});

	test("task without assignments + completed → noop", () => {
		const task = makeTask({ status: "completed", assignments: [] });
		expect(handleTaskClickAction(task, true, true)).toBe("noop");
	});

	test("task without assignments + failed → noop", () => {
		const task = makeTask({ status: "failed", assignments: [] });
		expect(handleTaskClickAction(task, true, true)).toBe("noop");
	});

	test("task without assignments + pending + no onsendmessage → noop", () => {
		const task = makeTask({ status: "pending", assignments: [] });
		expect(handleTaskClickAction(task, false, false)).toBe("noop");
	});

	test("task with empty assignments array treated as no assignments", () => {
		const task = makeTask({ status: "pending", assignments: [] });
		expect(handleTaskClickAction(task, true, true)).toBe("onsendmessage");
	});
});

// ── buildTaskClickMessage ───────────────────────────────────────────────

describe("buildTaskClickMessage", () => {
	test("task with title only", () => {
		const task = makeTask({ title: "Deploy app" });
		expect(buildTaskClickMessage(task)).toBe("Work on task: **Deploy app**");
	});

	test("task with title + description", () => {
		const task = makeTask({ title: "Deploy app", description: "Use blue-green strategy" });
		expect(buildTaskClickMessage(task)).toBe(
			"Work on task: **Deploy app**\n\nUse blue-green strategy",
		);
	});

	test("task with empty description omits it", () => {
		const task = makeTask({ title: "Ship it", description: "" });
		expect(buildTaskClickMessage(task)).toBe("Work on task: **Ship it**");
	});
});

// ── showAssignmentPills ─────────────────────────────────────────────────

describe("showAssignmentPills", () => {
	test("task with assignments → true", () => {
		const task = makeTask({ assignments: [makeAssignment()] });
		expect(showAssignmentPills(task)).toBe(true);
	});

	test("task with multiple assignments → true", () => {
		const task = makeTask({
			assignments: [
				makeAssignment({ agentName: "coder" }),
				makeAssignment({ agentName: "reviewer" }),
			],
		});
		expect(showAssignmentPills(task)).toBe(true);
	});

	test("task with empty assignments → false", () => {
		const task = makeTask({ assignments: [] });
		expect(showAssignmentPills(task)).toBe(false);
	});
});

// ── showLegacyAgentBadge ────────────────────────────────────────────────

describe("showLegacyAgentBadge", () => {
	test("agentName set + no assignments → true (show legacy badge)", () => {
		const task = makeTask({ agentName: "coder", assignments: [] });
		expect(showLegacyAgentBadge(task)).toBe(true);
	});

	test("agentName set + has assignments → false (assignments take precedence)", () => {
		const task = makeTask({
			agentName: "coder",
			assignments: [makeAssignment()],
		});
		expect(showLegacyAgentBadge(task)).toBe(false);
	});

	test("no agentName + no assignments → false", () => {
		const task = makeTask({ agentName: undefined, assignments: [] });
		expect(showLegacyAgentBadge(task)).toBe(false);
	});

	test("no agentName + has assignments → false", () => {
		const task = makeTask({
			agentName: undefined,
			assignments: [makeAssignment()],
		});
		expect(showLegacyAgentBadge(task)).toBe(false);
	});

	test("empty-string agentName is falsy → no badge", () => {
		const task = makeTask({ agentName: "", assignments: [] });
		expect(showLegacyAgentBadge(task)).toBe(false);
	});
});

// ── Combined scenarios ──────────────────────────────────────────────────

describe("combined: click + visibility", () => {
	test("task with assignments: click → ontaskclick, show pills, hide legacy badge", () => {
		const task = makeTask({
			status: "active",
			agentName: "coder",
			assignments: [makeAssignment({ agentName: "coder" })],
		});
		expect(handleTaskClickAction(task, true, true)).toBe("ontaskclick");
		expect(showAssignmentPills(task)).toBe(true);
		expect(showLegacyAgentBadge(task)).toBe(false);
	});

	test("legacy task without assignments: click → onsendmessage if pending, show badge", () => {
		const task = makeTask({
			status: "pending",
			agentName: "coder",
			assignments: [],
		});
		expect(handleTaskClickAction(task, true, true)).toBe("onsendmessage");
		expect(showAssignmentPills(task)).toBe(false);
		expect(showLegacyAgentBadge(task)).toBe(true);
	});

	test("bare task (no agent, no assignments): click pending → onsendmessage, no pills, no badge", () => {
		const task = makeTask({
			status: "pending",
			assignments: [],
		});
		expect(handleTaskClickAction(task, true, true)).toBe("onsendmessage");
		expect(showAssignmentPills(task)).toBe(false);
		expect(showLegacyAgentBadge(task)).toBe(false);
	});
});
