import { describe, test, expect } from "bun:test";

/**
 * Logic tests for TaskPanel.svelte.
 *
 * `.svelte` files cannot be imported directly under bun test (Svelte 5 runes
 * require a runtime we don't have here), so we mirror the component's pure
 * derivation logic as plain functions and exercise them directly. Any change
 * to the derivation logic in TaskPanel.svelte must be reflected here — the
 * explicit copies make drift obvious in code review.
 *
 * Mirrors the derivations around lines 17–56 of
 * web/src/lib/components/TaskPanel.svelte.
 */

// ── Types mirrored from src/runtime/tools/task-tracking.ts ───────────────

type TaskStatus = "pending" | "active" | "completed" | "failed";

interface TrackedSubtask {
	id: string;
	title: string;
	completed: boolean;
	position: number;
}

interface TrackedTask {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	agentId?: string;
	agentName?: string;
	subtasks: TrackedSubtask[];
	priority: number;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	failedAt?: string;
	failureReason?: string;
	completionSummary?: string;
}

interface TaskSnapshot {
	conversationId: string;
	tasks: TrackedTask[];
	activeTaskId?: string;
}

// ── Pure derivations (copied verbatim from TaskPanel.svelte) ─────────────

function sortByPriority(tasks: TrackedTask[]): TrackedTask[] {
	return [...tasks].sort((a, b) => a.priority - b.priority);
}

function completedCount(tasks: TrackedTask[]): number {
	return tasks.filter((t) => t.status === "completed").length;
}

function failedCount(tasks: TrackedTask[]): number {
	return tasks.filter((t) => t.status === "failed").length;
}

function progressPercent(tasks: TrackedTask[]): number {
	const total = tasks.length;
	if (total === 0) return 0;
	return Math.round((completedCount(tasks) / total) * 100);
}

function activeTask(snapshot: TaskSnapshot): TrackedTask | undefined {
	const sorted = sortByPriority(snapshot.tasks);
	return (
		sorted.find((t) => t.id === snapshot.activeTaskId) ??
		sorted.find((t) => t.status === "active")
	);
}

function allDone(tasks: TrackedTask[]): boolean {
	return (
		tasks.length > 0 &&
		tasks.every((t) => t.status === "completed" || t.status === "failed")
	);
}

function dotColor(status: string): string {
	switch (status) {
		case "completed":
			return "bg-green-500";
		case "active":
			return "bg-blue-400 animate-pulse";
		case "failed":
			return "bg-red-500";
		default:
			return "bg-[var(--color-surface-tertiary)] border border-[var(--color-border)]";
	}
}

function completedSubtaskCount(task: TrackedTask): number {
	return task.subtasks.filter((s) => s.completed).length;
}

// Mirrors `handleTaskClick` body in TaskPanel.svelte (lines 38–42).
// Returns the string that would be passed to onsendmessage, or null if
// the click is a no-op (non-pending task or missing handler semantic).
function buildTaskClickMessage(task: TrackedTask): string | null {
	if (task.status !== "pending") return null;
	const desc = task.description ? `\n\n${task.description}` : "";
	return `Work on task: **${task.title}**${desc}`;
}

// Mirrors `formatDuration` in TaskPanel.svelte.
function formatDuration(ms: number): string {
	if (ms < 0) return "0s";
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) return `${totalMinutes}m ${seconds.toString().padStart(2, "0")}s`;
	const totalHours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (totalHours < 24) return `${totalHours}h ${minutes.toString().padStart(2, "0")}m`;
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return `${days}d ${hours}h`;
}

// Mirrors `taskDuration` in TaskPanel.svelte.
function taskDuration(task: TrackedTask, nowMs: number): string | null {
	if (!task.startedAt) return null;
	const start = Date.parse(task.startedAt);
	if (Number.isNaN(start)) return null;
	let end: number;
	if (task.status === "active") {
		end = nowMs;
	} else if (task.status === "completed" && task.completedAt) {
		end = Date.parse(task.completedAt);
	} else if (task.status === "failed" && task.failedAt) {
		end = Date.parse(task.failedAt);
	} else {
		return null;
	}
	if (Number.isNaN(end)) return null;
	return formatDuration(end - start);
}

// Mirrors `durationBadgeClass` in TaskPanel.svelte.
function durationBadgeClass(status: string): string {
	switch (status) {
		case "active":
			return "bg-blue-500/20 text-blue-300";
		case "completed":
			return "bg-green-500/15 text-green-300/80";
		case "failed":
			return "bg-red-500/15 text-red-300/80";
		default:
			return "bg-[var(--color-surface-tertiary)] text-[var(--color-text-muted)]";
	}
}

// ── Test fixtures ────────────────────────────────────────────────────────

let _id = 0;
function nextId(): string {
	return `task-${++_id}`;
}

function makeTask(overrides: Partial<TrackedTask> = {}): TrackedTask {
	return {
		id: overrides.id ?? nextId(),
		title: overrides.title ?? "Untitled",
		description: overrides.description ?? "",
		status: overrides.status ?? "pending",
		agentId: overrides.agentId,
		agentName: overrides.agentName,
		subtasks: overrides.subtasks ?? [],
		priority: overrides.priority ?? 0,
		createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
		startedAt: overrides.startedAt,
		completedAt: overrides.completedAt,
		failedAt: overrides.failedAt,
		failureReason: overrides.failureReason,
		completionSummary: overrides.completionSummary,
	};
}

function makeSubtask(
	overrides: Partial<TrackedSubtask> = {},
): TrackedSubtask {
	return {
		id: overrides.id ?? nextId(),
		title: overrides.title ?? "Subtask",
		completed: overrides.completed ?? false,
		position: overrides.position ?? 0,
	};
}

function makeSnapshot(
	tasks: TrackedTask[],
	activeTaskId?: string,
): TaskSnapshot {
	return { conversationId: "conv-1", tasks, activeTaskId };
}

// ── sortByPriority ───────────────────────────────────────────────────────

describe("sortByPriority", () => {
	test("returns tasks in ascending priority order", () => {
		const tasks = [
			makeTask({ id: "a", priority: 3 }),
			makeTask({ id: "b", priority: 1 }),
			makeTask({ id: "c", priority: 2 }),
		];
		const sorted = sortByPriority(tasks);
		expect(sorted.map((t) => t.id)).toEqual(["b", "c", "a"]);
	});

	test("stable sort preserves insertion order for equal priorities", () => {
		const tasks = [
			makeTask({ id: "x1", priority: 1 }),
			makeTask({ id: "x2", priority: 1 }),
			makeTask({ id: "x3", priority: 1 }),
			makeTask({ id: "x4", priority: 1 }),
		];
		const sorted = sortByPriority(tasks);
		expect(sorted.map((t) => t.id)).toEqual(["x1", "x2", "x3", "x4"]);
	});

	test("stable sort with mixed priorities preserves insertion order within groups", () => {
		const tasks = [
			makeTask({ id: "a", priority: 2 }),
			makeTask({ id: "b", priority: 1 }),
			makeTask({ id: "c", priority: 2 }),
			makeTask({ id: "d", priority: 1 }),
		];
		const sorted = sortByPriority(tasks);
		expect(sorted.map((t) => t.id)).toEqual(["b", "d", "a", "c"]);
	});

	test("does not mutate the input array", () => {
		const tasks = [
			makeTask({ id: "a", priority: 2 }),
			makeTask({ id: "b", priority: 1 }),
		];
		const original = tasks.map((t) => t.id);
		sortByPriority(tasks);
		expect(tasks.map((t) => t.id)).toEqual(original);
	});

	test("handles empty task list", () => {
		expect(sortByPriority([])).toEqual([]);
	});
});

// ── progressPercent ──────────────────────────────────────────────────────

describe("progressPercent", () => {
	test("returns 0 for empty task list (0/0 → 0%)", () => {
		expect(progressPercent([])).toBe(0);
	});

	test("returns 0 when no tasks are completed", () => {
		const tasks = [
			makeTask({ status: "pending" }),
			makeTask({ status: "active" }),
			makeTask({ status: "failed" }),
		];
		expect(progressPercent(tasks)).toBe(0);
	});

	test("3/7 completed rounds to 43%", () => {
		const tasks = [
			makeTask({ status: "completed" }),
			makeTask({ status: "completed" }),
			makeTask({ status: "completed" }),
			makeTask({ status: "pending" }),
			makeTask({ status: "pending" }),
			makeTask({ status: "active" }),
			makeTask({ status: "failed" }),
		];
		// 3/7 = 0.4286 → round to 43
		expect(progressPercent(tasks)).toBe(43);
	});

	test("all 5 completed → 100%", () => {
		const tasks = Array.from({ length: 5 }, () =>
			makeTask({ status: "completed" }),
		);
		expect(progressPercent(tasks)).toBe(100);
	});

	test("mixed completed + failed: only completed counts toward progress", () => {
		// 2 completed + 2 failed out of 4 → 50% (failed is NOT progress)
		const tasks = [
			makeTask({ status: "completed" }),
			makeTask({ status: "completed" }),
			makeTask({ status: "failed" }),
			makeTask({ status: "failed" }),
		];
		expect(progressPercent(tasks)).toBe(50);
	});

	test("single completed task → 100%", () => {
		expect(progressPercent([makeTask({ status: "completed" })])).toBe(100);
	});

	test("single failed task → 0% (failed does not count toward progress)", () => {
		expect(progressPercent([makeTask({ status: "failed" })])).toBe(0);
	});
});

// ── completedCount / failedCount ─────────────────────────────────────────

describe("completedCount and failedCount", () => {
	test("counts each status independently", () => {
		const tasks = [
			makeTask({ status: "completed" }),
			makeTask({ status: "completed" }),
			makeTask({ status: "failed" }),
			makeTask({ status: "pending" }),
			makeTask({ status: "active" }),
		];
		expect(completedCount(tasks)).toBe(2);
		expect(failedCount(tasks)).toBe(1);
	});

	test("returns 0 for empty task list", () => {
		expect(completedCount([])).toBe(0);
		expect(failedCount([])).toBe(0);
	});
});

// ── activeTask ───────────────────────────────────────────────────────────

describe("activeTask derivation", () => {
	test("returns task whose id matches snapshot.activeTaskId", () => {
		const tasks = [
			makeTask({ id: "t1", status: "completed", priority: 0 }),
			makeTask({ id: "t2", status: "active", priority: 1 }),
			makeTask({ id: "t3", status: "pending", priority: 2 }),
		];
		const snapshot = makeSnapshot(tasks, "t2");
		expect(activeTask(snapshot)!.id).toBe("t2");
	});

	test("falls back to first task with status='active' when activeTaskId is stale", () => {
		const tasks = [
			makeTask({ id: "t1", status: "completed", priority: 0 }),
			makeTask({ id: "t2", status: "active", priority: 1 }),
			makeTask({ id: "t3", status: "pending", priority: 2 }),
		];
		// activeTaskId points to a deleted/nonexistent task
		const snapshot = makeSnapshot(tasks, "deleted-id");
		expect(activeTask(snapshot)!.id).toBe("t2");
	});

	test("falls back when activeTaskId is undefined", () => {
		const tasks = [
			makeTask({ id: "t1", status: "pending", priority: 0 }),
			makeTask({ id: "t2", status: "active", priority: 1 }),
		];
		const snapshot = makeSnapshot(tasks, undefined);
		expect(activeTask(snapshot)!.id).toBe("t2");
	});

	test("returns undefined when no task is active and activeTaskId is stale", () => {
		const tasks = [
			makeTask({ id: "t1", status: "pending" }),
			makeTask({ id: "t2", status: "completed" }),
		];
		const snapshot = makeSnapshot(tasks, "nope");
		expect(activeTask(snapshot)).toBeUndefined();
	});

	test("returns undefined on empty tasks list", () => {
		const snapshot = makeSnapshot([], "anything");
		expect(activeTask(snapshot)).toBeUndefined();
	});

	test("fallback respects priority order (picks lowest-priority active task)", () => {
		const tasks = [
			makeTask({ id: "later", status: "active", priority: 5 }),
			makeTask({ id: "earlier", status: "active", priority: 1 }),
		];
		const snapshot = makeSnapshot(tasks, undefined);
		// After sortByPriority, "earlier" is first
		expect(activeTask(snapshot)!.id).toBe("earlier");
	});

	test("exact-id match wins over status-based fallback", () => {
		const tasks = [
			makeTask({ id: "a", status: "active", priority: 0 }),
			makeTask({ id: "b", status: "pending", priority: 1 }),
		];
		// activeTaskId points to a pending task — should still be picked
		const snapshot = makeSnapshot(tasks, "b");
		expect(activeTask(snapshot)!.id).toBe("b");
	});
});

// ── allDone ──────────────────────────────────────────────────────────────

describe("allDone derivation", () => {
	test("false when any task is pending", () => {
		const tasks = [
			makeTask({ status: "completed" }),
			makeTask({ status: "pending" }),
		];
		expect(allDone(tasks)).toBe(false);
	});

	test("false when any task is active", () => {
		const tasks = [
			makeTask({ status: "completed" }),
			makeTask({ status: "active" }),
		];
		expect(allDone(tasks)).toBe(false);
	});

	test("true when all tasks are completed", () => {
		const tasks = [
			makeTask({ status: "completed" }),
			makeTask({ status: "completed" }),
		];
		expect(allDone(tasks)).toBe(true);
	});

	test("true when all tasks are failed", () => {
		const tasks = [
			makeTask({ status: "failed" }),
			makeTask({ status: "failed" }),
		];
		expect(allDone(tasks)).toBe(true);
	});

	test("true when tasks are a mix of completed and failed", () => {
		const tasks = [
			makeTask({ status: "completed" }),
			makeTask({ status: "failed" }),
			makeTask({ status: "completed" }),
		];
		expect(allDone(tasks)).toBe(true);
	});

	test("false for empty task list (can't be done if never had work)", () => {
		expect(allDone([])).toBe(false);
	});
});

// ── dotColor ─────────────────────────────────────────────────────────────

describe("dotColor helper", () => {
	test("completed → bg-green-500", () => {
		expect(dotColor("completed")).toBe("bg-green-500");
	});

	test("active → bg-blue-400 animate-pulse", () => {
		expect(dotColor("active")).toBe("bg-blue-400 animate-pulse");
	});

	test("failed → bg-red-500", () => {
		expect(dotColor("failed")).toBe("bg-red-500");
	});

	test("pending → muted (surface-tertiary with border)", () => {
		const result = dotColor("pending");
		expect(result).toContain("bg-[var(--color-surface-tertiary)]");
		expect(result).toContain("border");
	});

	test("unknown status falls through to muted default", () => {
		const result = dotColor("weird-state");
		expect(result).toContain("bg-[var(--color-surface-tertiary)]");
	});
});

// ── subtask / blockers derivation ────────────────────────────────────────

describe("completedSubtaskCount", () => {
	test("returns 0 when task has no subtasks", () => {
		expect(completedSubtaskCount(makeTask())).toBe(0);
	});

	test("counts only completed subtasks", () => {
		const task = makeTask({
			subtasks: [
				makeSubtask({ completed: true }),
				makeSubtask({ completed: false }),
				makeSubtask({ completed: true }),
				makeSubtask({ completed: false }),
			],
		});
		expect(completedSubtaskCount(task)).toBe(2);
	});

	test("all subtasks complete", () => {
		const task = makeTask({
			subtasks: [
				makeSubtask({ completed: true }),
				makeSubtask({ completed: true }),
			],
		});
		expect(completedSubtaskCount(task)).toBe(2);
	});

	test("per-task filtering: each task's subtasks are independent", () => {
		const a = makeTask({
			id: "a",
			subtasks: [makeSubtask({ completed: true })],
		});
		const b = makeTask({
			id: "b",
			subtasks: [
				makeSubtask({ completed: false }),
				makeSubtask({ completed: true }),
			],
		});
		expect(completedSubtaskCount(a)).toBe(1);
		expect(completedSubtaskCount(b)).toBe(1);
	});
});

// ── buildTaskClickMessage ────────────────────────────────────────────────

describe("buildTaskClickMessage", () => {
	test("returns null for non-pending tasks (click is a no-op)", () => {
		expect(buildTaskClickMessage(makeTask({ status: "active" }))).toBeNull();
		expect(
			buildTaskClickMessage(makeTask({ status: "completed" })),
		).toBeNull();
		expect(buildTaskClickMessage(makeTask({ status: "failed" }))).toBeNull();
	});

	test("pending task with no description produces bare title message", () => {
		const task = makeTask({ title: "Write docs", status: "pending" });
		expect(buildTaskClickMessage(task)).toBe("Work on task: **Write docs**");
	});

	test("pending task with description appends it after double-newline", () => {
		const task = makeTask({
			title: "Write docs",
			description: "Focus on the API reference",
			status: "pending",
		});
		expect(buildTaskClickMessage(task)).toBe(
			"Work on task: **Write docs**\n\nFocus on the API reference",
		);
	});

	test("empty-string description is treated as no description", () => {
		const task = makeTask({
			title: "Ship it",
			description: "",
			status: "pending",
		});
		expect(buildTaskClickMessage(task)).toBe("Work on task: **Ship it**");
	});
});

// ── End-to-end snapshot derivation ───────────────────────────────────────

describe("snapshot-level derivation end-to-end", () => {
	test("realistic mixed snapshot produces consistent progress/active/allDone", () => {
		const tasks = [
			makeTask({
				id: "plan",
				title: "Plan",
				status: "completed",
				priority: 0,
			}),
			makeTask({
				id: "code",
				title: "Code",
				status: "active",
				priority: 1,
			}),
			makeTask({
				id: "test",
				title: "Test",
				status: "pending",
				priority: 2,
			}),
			makeTask({
				id: "ship",
				title: "Ship",
				status: "pending",
				priority: 3,
			}),
		];
		const snapshot = makeSnapshot(tasks, "code");
		const sorted = sortByPriority(snapshot.tasks);

		expect(sorted.map((t) => t.id)).toEqual(["plan", "code", "test", "ship"]);
		expect(completedCount(sorted)).toBe(1);
		expect(failedCount(sorted)).toBe(0);
		expect(progressPercent(sorted)).toBe(25); // 1/4 = 25%
		expect(activeTask(snapshot)!.id).toBe("code");
		expect(allDone(sorted)).toBe(false);
	});

	test("snapshot with everything done reports allDone=true and 100% even with failures", () => {
		const tasks = [
			makeTask({ id: "a", status: "completed", priority: 0 }),
			makeTask({ id: "b", status: "failed", priority: 1 }),
			makeTask({ id: "c", status: "completed", priority: 2 }),
		];
		const snapshot = makeSnapshot(tasks);
		const sorted = sortByPriority(snapshot.tasks);

		expect(allDone(sorted)).toBe(true);
		expect(completedCount(sorted)).toBe(2);
		expect(failedCount(sorted)).toBe(1);
		// 2 completed out of 3 total → 67%
		expect(progressPercent(sorted)).toBe(67);
		// No active task → no fallback → undefined
		expect(activeTask(snapshot)).toBeUndefined();
	});
});

// ── formatDuration ───────────────────────────────────────────────────────

describe("formatDuration", () => {
	test("negative values clamp to 0s", () => {
		expect(formatDuration(-1)).toBe("0s");
		expect(formatDuration(-60_000)).toBe("0s");
	});

	test("renders seconds only for durations under a minute", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(1_000)).toBe("1s");
		expect(formatDuration(45_000)).toBe("45s");
		expect(formatDuration(59_999)).toBe("59s"); // floor
	});

	test("renders minutes and zero-padded seconds between 1m and 1h", () => {
		expect(formatDuration(60_000)).toBe("1m 00s");
		expect(formatDuration(65_000)).toBe("1m 05s");
		expect(formatDuration(2 * 60_000 + 13_000)).toBe("2m 13s");
		expect(formatDuration(59 * 60_000 + 59_000)).toBe("59m 59s");
	});

	test("renders hours and zero-padded minutes between 1h and 24h", () => {
		expect(formatDuration(60 * 60_000)).toBe("1h 00m");
		expect(formatDuration(60 * 60_000 + 7 * 60_000)).toBe("1h 07m");
		expect(formatDuration(23 * 60 * 60_000 + 45 * 60_000)).toBe("23h 45m");
	});

	test("renders days and hours at 24h and beyond", () => {
		expect(formatDuration(24 * 60 * 60_000)).toBe("1d 0h");
		expect(formatDuration(25 * 60 * 60_000)).toBe("1d 1h");
		expect(formatDuration(3 * 24 * 60 * 60_000 + 4 * 60 * 60_000)).toBe("3d 4h");
	});

	test("sub-second durations render as 0s (floor)", () => {
		expect(formatDuration(500)).toBe("0s");
		expect(formatDuration(999)).toBe("0s");
	});
});

// ── taskDuration ─────────────────────────────────────────────────────────

describe("taskDuration", () => {
	test("returns null when task has never started (no startedAt)", () => {
		const task = makeTask({ status: "pending" });
		expect(taskDuration(task, Date.now())).toBeNull();
	});

	test("returns null for pending tasks even if startedAt is set", () => {
		// Defensive: a task that was started and put back to pending shouldn't show a timer.
		const task = makeTask({
			status: "pending",
			startedAt: "2026-01-01T00:00:00Z",
		});
		expect(taskDuration(task, Date.parse("2026-01-01T00:00:10Z"))).toBeNull();
	});

	test("returns null when startedAt is not a valid ISO string", () => {
		const task = makeTask({ status: "active", startedAt: "not a date" });
		expect(taskDuration(task, Date.now())).toBeNull();
	});

	test("active task: live count-up from startedAt to now", () => {
		const task = makeTask({
			status: "active",
			startedAt: "2026-01-01T12:00:00Z",
		});
		const now = Date.parse("2026-01-01T12:00:45Z");
		expect(taskDuration(task, now)).toBe("45s");

		const nowLater = Date.parse("2026-01-01T12:03:20Z");
		expect(taskDuration(task, nowLater)).toBe("3m 20s");
	});

	test("active task: timer ticks forward as now advances (simulates 1s setInterval)", () => {
		const task = makeTask({
			status: "active",
			startedAt: "2026-01-01T00:00:00Z",
		});
		const samples = [0, 1, 5, 10, 30, 59, 60, 90].map((sec) =>
			taskDuration(task, Date.parse(`2026-01-01T00:00:00Z`) + sec * 1000),
		);
		expect(samples).toEqual(["0s", "1s", "5s", "10s", "30s", "59s", "1m 00s", "1m 30s"]);
	});

	test("completed task: total elapsed from startedAt to completedAt (ignores now)", () => {
		const task = makeTask({
			status: "completed",
			startedAt: "2026-01-01T00:00:00Z",
			completedAt: "2026-01-01T00:02:30Z",
		});
		// now is irrelevant for completed tasks — passing an unrelated value
		// must not change the displayed duration.
		const unrelatedNow = Date.parse("2026-06-15T14:22:00Z");
		expect(taskDuration(task, unrelatedNow)).toBe("2m 30s");
	});

	test("completed task: returns null when completedAt is missing", () => {
		const task = makeTask({
			status: "completed",
			startedAt: "2026-01-01T00:00:00Z",
		});
		expect(taskDuration(task, Date.now())).toBeNull();
	});

	test("failed task: total elapsed from startedAt to failedAt", () => {
		const task = makeTask({
			status: "failed",
			startedAt: "2026-01-01T00:00:00Z",
			failedAt: "2026-01-01T00:00:10Z",
			failureReason: "boom",
		});
		expect(taskDuration(task, Date.now())).toBe("10s");
	});

	test("failed task: returns null when failedAt is missing", () => {
		const task = makeTask({
			status: "failed",
			startedAt: "2026-01-01T00:00:00Z",
		});
		expect(taskDuration(task, Date.now())).toBeNull();
	});

	test("handles multi-hour active task durations", () => {
		const task = makeTask({
			status: "active",
			startedAt: "2026-01-01T00:00:00Z",
		});
		const now = Date.parse("2026-01-01T02:15:00Z");
		expect(taskDuration(task, now)).toBe("2h 15m");
	});

	test("handles multi-day active task durations", () => {
		const task = makeTask({
			status: "active",
			startedAt: "2026-01-01T00:00:00Z",
		});
		const now = Date.parse("2026-01-04T05:00:00Z");
		expect(taskDuration(task, now)).toBe("3d 5h");
	});
});

// ── durationBadgeClass ───────────────────────────────────────────────────

describe("durationBadgeClass", () => {
	test("active gets prominent blue styling", () => {
		expect(durationBadgeClass("active")).toBe("bg-blue-500/20 text-blue-300");
	});

	test("completed gets muted green styling (visible but not loud)", () => {
		expect(durationBadgeClass("completed")).toBe("bg-green-500/15 text-green-300/80");
	});

	test("failed gets muted red styling", () => {
		expect(durationBadgeClass("failed")).toBe("bg-red-500/15 text-red-300/80");
	});

	test("unknown/pending status gets neutral fallback", () => {
		expect(durationBadgeClass("pending")).toBe(
			"bg-[var(--color-surface-tertiary)] text-[var(--color-text-muted)]",
		);
		expect(durationBadgeClass("weird-status")).toBe(
			"bg-[var(--color-surface-tertiary)] text-[var(--color-text-muted)]",
		);
	});
});

// ── Persistent visibility: completed tasks never disappear ──────────────

describe("completed tasks remain visible forever", () => {
	test("sortByPriority keeps completed tasks in the list alongside active ones", () => {
		const tasks = [
			makeTask({ id: "done", status: "completed", priority: 0, startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:30Z" }),
			makeTask({ id: "running", status: "active", priority: 1, startedAt: "2026-01-01T00:00:30Z" }),
			makeTask({ id: "todo", status: "pending", priority: 2 }),
		];
		const sorted = sortByPriority(tasks);
		// All three statuses present — completed is NOT filtered out.
		expect(sorted.map((t) => t.id)).toEqual(["done", "running", "todo"]);
		expect(sorted.map((t) => t.status)).toEqual(["completed", "active", "pending"]);
	});

	test("progress math reflects every completed task forever (no expiry)", () => {
		// A conversation where every task completed long ago — panel should still
		// show 100% and the list should still render.
		const tasks = [
			makeTask({ id: "a", status: "completed", priority: 0, startedAt: "2020-01-01T00:00:00Z", completedAt: "2020-01-01T00:01:00Z" }),
			makeTask({ id: "b", status: "completed", priority: 1, startedAt: "2020-01-01T00:01:00Z", completedAt: "2020-01-01T00:02:00Z" }),
		];
		expect(completedCount(tasks)).toBe(2);
		expect(progressPercent(tasks)).toBe(100);
		expect(allDone(tasks)).toBe(true);
		// Durations for old completed tasks remain stable no matter how far "now" has advanced.
		const farFuture = Date.parse("2030-05-15T00:00:00Z");
		expect(taskDuration(tasks[0]!, farFuture)).toBe("1m 00s");
		expect(taskDuration(tasks[1]!, farFuture)).toBe("1m 00s");
	});

	test("allDone is true for a completed run but the tasks array still has entries to render", () => {
		const tasks = [
			makeTask({ id: "x", status: "completed", priority: 0 }),
			makeTask({ id: "y", status: "failed", priority: 1 }),
		];
		expect(allDone(tasks)).toBe(true);
		// Crucially, allDone does NOT signal that tasks should be cleared.
		// The component's visibility check is tasks.length > 0, which is still truthy.
		expect(tasks.length).toBeGreaterThan(0);
	});
});
