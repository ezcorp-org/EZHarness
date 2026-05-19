/**
 * Tests for the "blocked task" derivation in TaskPanel.svelte.
 *
 * Svelte 5 runes can't run under bun:test, so we mirror the pure logic of
 * `unsatisfiedDepsFor` / `isTaskBlocked` as standalone functions and verify
 * they return the same shape the component consumes. These helpers
 * intentionally mirror the backend `isBlocked` / `unsatisfiedDeps` in
 * src/runtime/tools/task-tracking.ts so both sides agree on what "blocked"
 * means; the `task-dependencies.test.ts` backend suite exercises the
 * backend side, this file verifies the frontend copy.
 */
import { describe, test, expect } from "bun:test";

// ── Types mirrored from web/src/lib/stores.svelte.ts ────────────────────

type TaskStatus = "pending" | "active" | "completed" | "failed";
interface TaskPanelTask {
	id: string;
	title: string;
	status: TaskStatus;
	dependsOn?: string[];
	// Other fields omitted — helpers only read `id`, `title`, `status`, `dependsOn`.
}

// ── Logic copies from web/src/lib/components/TaskPanel.svelte ───────────

function unsatisfiedDepsFor(task: TaskPanelTask, allTasks: TaskPanelTask[]): TaskPanelTask[] {
	if (!task.dependsOn || task.dependsOn.length === 0) return [];
	const byId = new Map(allTasks.map((t) => [t.id, t]));
	const out: TaskPanelTask[] = [];
	for (const depId of task.dependsOn) {
		const dep = byId.get(depId);
		if (!dep) continue; // unknown dep — treat as satisfied
		if (dep.status !== "completed") out.push(dep);
	}
	return out;
}

function isTaskBlocked(task: TaskPanelTask, allTasks: TaskPanelTask[]): boolean {
	if (task.status !== "pending") return false;
	return unsatisfiedDepsFor(task, allTasks).length > 0;
}

// ── Fixtures ────────────────────────────────────────────────────────────

function t(id: string, status: TaskStatus, dependsOn?: string[]): TaskPanelTask {
	return { id, title: id.toUpperCase(), status, dependsOn };
}

describe("isTaskBlocked", () => {
	test("task with no deps is never blocked", () => {
		const task = t("a", "pending");
		expect(isTaskBlocked(task, [task])).toBe(false);
	});

	test("pending task with empty dependsOn is not blocked", () => {
		const task = t("a", "pending", []);
		expect(isTaskBlocked(task, [task])).toBe(false);
	});

	test("pending task whose prereq is still pending is blocked", () => {
		const a = t("a", "pending");
		const b = t("b", "pending", ["a"]);
		expect(isTaskBlocked(b, [a, b])).toBe(true);
	});

	test("pending task whose prereq is active is blocked", () => {
		const a = t("a", "active");
		const b = t("b", "pending", ["a"]);
		expect(isTaskBlocked(b, [a, b])).toBe(true);
	});

	test("pending task whose prereq is completed is NOT blocked", () => {
		const a = t("a", "completed");
		const b = t("b", "pending", ["a"]);
		expect(isTaskBlocked(b, [a, b])).toBe(false);
	});

	test("pending task whose prereq is failed is blocked (stays blocked forever)", () => {
		const a = t("a", "failed");
		const b = t("b", "pending", ["a"]);
		expect(isTaskBlocked(b, [a, b])).toBe(true);
	});

	test("non-pending tasks (active/completed/failed) are never reported as blocked", () => {
		const a = t("a", "pending");
		for (const status of ["active", "completed", "failed"] as const) {
			const b = t("b", status, ["a"]);
			expect(isTaskBlocked(b, [a, b])).toBe(false);
		}
	});

	test("multiple prereqs: blocked when ANY is incomplete", () => {
		const a = t("a", "completed");
		const b = t("b", "pending");
		const c = t("c", "pending", ["a", "b"]);
		expect(isTaskBlocked(c, [a, b, c])).toBe(true);
	});

	test("multiple prereqs: unblocked when ALL are completed", () => {
		const a = t("a", "completed");
		const b = t("b", "completed");
		const c = t("c", "pending", ["a", "b"]);
		expect(isTaskBlocked(c, [a, b, c])).toBe(false);
	});

	test("unknown dep ID (deleted task) is treated as satisfied", () => {
		const a = t("a", "pending", ["ghost"]);
		expect(isTaskBlocked(a, [a])).toBe(false);
	});
});

describe("unsatisfiedDepsFor", () => {
	test("returns the incomplete prereq task objects in dependsOn order", () => {
		const a = t("a", "completed");
		const b = t("b", "pending");
		const c = t("c", "active");
		const target = t("target", "pending", ["a", "b", "c"]);
		const waiting = unsatisfiedDepsFor(target, [a, b, c, target]);
		expect(waiting.map((x) => x.id)).toEqual(["b", "c"]);
	});

	test("empty array when no deps specified", () => {
		expect(unsatisfiedDepsFor(t("a", "pending"), [])).toEqual([]);
	});

	test("empty array when all deps are completed", () => {
		const a = t("a", "completed");
		const b = t("b", "completed");
		const target = t("target", "pending", ["a", "b"]);
		expect(unsatisfiedDepsFor(target, [a, b, target])).toEqual([]);
	});

	test("skips unknown dep IDs (same as backend)", () => {
		const a = t("a", "pending");
		const target = t("target", "pending", ["a", "ghost"]);
		expect(unsatisfiedDepsFor(target, [a, target]).map((x) => x.id)).toEqual(["a"]);
	});
});

// ── UI-intent tests: what the component will render ──────────────────────

describe("rendering intent for blocked tasks", () => {
	test("a blocked task has at least one blockedBy entry to show in the badge", () => {
		const a = t("build", "pending");
		const b = t("deploy", "pending", ["build"]);
		const blockedBy = unsatisfiedDepsFor(b, [a, b]);
		expect(blockedBy).toHaveLength(1);
		expect(blockedBy[0]!.title).toBe("BUILD");
	});

	test("after prereq completes, blockedBy is empty and isTaskBlocked flips false", () => {
		const a = t("build", "completed");
		const b = t("deploy", "pending", ["build"]);
		expect(isTaskBlocked(b, [a, b])).toBe(false);
		expect(unsatisfiedDepsFor(b, [a, b])).toEqual([]);
	});

	test("diamond pattern: D waits for B and C, even when A is already done", () => {
		const a = t("a", "completed");
		const b = t("b", "pending", ["a"]);
		const c = t("c", "pending", ["a"]);
		const d = t("d", "pending", ["b", "c"]);
		const all = [a, b, c, d];
		expect(isTaskBlocked(b, all)).toBe(false);
		expect(isTaskBlocked(c, all)).toBe(false);
		expect(isTaskBlocked(d, all)).toBe(true);
		expect(unsatisfiedDepsFor(d, all).map((x) => x.id)).toEqual(["b", "c"]);
	});
});
