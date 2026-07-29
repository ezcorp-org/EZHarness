/**
 * Task-panel snapshot reducer.
 *
 * The task panel renders off one record per conversation. Three things write
 * to it and they can race:
 *
 *   1. `task:snapshot` — the whole authoritative state, emitted by the
 *      task-tracking extension and by every task-lifecycle HTTP handler.
 *   2. `task:assignment_update` — a single assignment delta.
 *   3. the cold-start hydrate (`GET /api/conversations/:id/tasks`), which the
 *      chat page fires on mount, on conversation switch, and after an SSE
 *      reconnect.
 *
 * (3) is the slow one: it reads the DB and can easily resolve AFTER live
 * events that were emitted later. Applying it blindly rolls the panel back to
 * an older state — the "tracker went backwards / is wrong" symptom. So the
 * state carries a per-conversation `seq` that counts live events applied, and
 * a hydrate response is dropped when `seq` moved while its fetch was in
 * flight.
 *
 * These are plain functions over a plain state object on purpose: the store
 * (`$lib/stores.svelte.ts`) is a rune module that bun can't execute, so
 * keeping the logic here is what makes it directly testable — and stops the
 * test suite from re-implementing the reducer to assert on it.
 *
 * Every function returns the SAME state reference when nothing changed, so
 * callers can skip a reactive write.
 */

import type { TaskAssignment, TaskPanelTask, TaskSnapshot } from "$lib/stores.svelte.js";

export interface TaskSnapshotState {
	/** conversationId → the snapshot the panel renders. */
	snapshots: Record<string, TaskSnapshot>;
	/**
	 * conversationId → number of live bus events applied so far. Monotonic;
	 * used only to detect that a hydrate response has been overtaken.
	 */
	seq: Record<string, number>;
}

export interface ApplyResult {
	state: TaskSnapshotState;
	/**
	 * The event referenced a conversation (or task) with no loaded snapshot,
	 * so the delta could not be applied and is now lost. The caller should
	 * cold-start hydrate that conversation to resync. Before this existed the
	 * update was silently dropped and the panel stayed stale until the next
	 * full snapshot happened to arrive.
	 */
	hydrateNeeded: boolean;
}

export function emptyTaskSnapshotState(): TaskSnapshotState {
	return { snapshots: {}, seq: {} };
}

/** Live-event counter for a conversation (0 when it has seen none). */
export function seqFor(state: TaskSnapshotState, conversationId: string): number {
	return state.seq[conversationId] ?? 0;
}

function bump(state: TaskSnapshotState, conversationId: string, snapshot: TaskSnapshot): TaskSnapshotState {
	return {
		snapshots: { ...state.snapshots, [conversationId]: snapshot },
		seq: { ...state.seq, [conversationId]: seqFor(state, conversationId) + 1 },
	};
}

/**
 * Apply a full `task:snapshot` event. Always wins — it is the authoritative
 * state at emit time and arrives in bus order.
 */
export function applyLiveSnapshot(
	state: TaskSnapshotState,
	payload: TaskSnapshot | undefined | null,
): ApplyResult {
	if (!payload?.conversationId) return { state, hydrateNeeded: false };
	const snapshot: TaskSnapshot = {
		conversationId: payload.conversationId,
		tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
		...(payload.activeTaskId !== undefined ? { activeTaskId: payload.activeTaskId } : {}),
	};
	return { state: bump(state, payload.conversationId, snapshot), hydrateNeeded: false };
}

export interface AssignmentUpdatePayload {
	conversationId: string;
	taskId: string;
	assignment: TaskAssignment;
	structuredResultError?: string;
	structuredResultOverCap?: boolean;
}

/**
 * Fold a `task:assignment_update` delta into the conversation's snapshot.
 *
 * Also mirrors the extension's task-level rollup client-side: the extension
 * emits a fresh `task:snapshot` when it processes this same event, but that
 * round-trip goes through the subprocess RPC and can lag, so the task would
 * visibly sit on "active" after its last assignment finished. Rolling up here
 * flips it the instant the last assignment reaches a terminal state.
 *
 * `nowIso` is injected rather than read from the clock so the rollup
 * timestamps are assertable.
 */
export function applyAssignmentUpdate(
	state: TaskSnapshotState,
	payload: AssignmentUpdatePayload,
	nowIso: string,
): ApplyResult {
	const { conversationId, taskId, assignment } = payload;
	if (!conversationId || !taskId || !assignment?.id) {
		return { state, hydrateNeeded: false };
	}

	const snapshot = state.snapshots[conversationId];
	// No snapshot loaded yet (fresh tab, or the run started before this page
	// opened) — the delta has nowhere to go. Ask for a hydrate instead of
	// dropping it on the floor.
	if (!snapshot) return { state, hydrateNeeded: true };

	const taskIdx = snapshot.tasks.findIndex((t) => t.id === taskId);
	if (taskIdx < 0) return { state, hydrateNeeded: true };

	// The schema-failure flag rides the top-level event field (the backend
	// keeps it OFF the assignment object). A terminal update carrying
	// `structuredResultError` WITHOUT `structuredResultOverCap` is a genuine
	// schema failure; a validated-but-oversized result is not.
	const schemaFailed =
		payload.structuredResultError !== undefined && !payload.structuredResultOverCap;
	const merged: TaskAssignment = { ...assignment, schemaFailed };

	const task = snapshot.tasks[taskIdx]!;
	const assignments = [...(task.assignments ?? [])];
	const idx = assignments.findIndex((a) => a.id === merged.id);
	if (idx >= 0) assignments[idx] = merged;
	else assignments.push(merged);

	let next: TaskPanelTask = { ...task, assignments };
	let activeTaskId = snapshot.activeTaskId;

	const allTerminal =
		assignments.length > 0 &&
		assignments.every((a) => a.status === "completed" || a.status === "failed");
	if (next.status !== "completed" && next.status !== "failed" && allTerminal) {
		const anyFailed = assignments.some((a) => a.status === "failed");
		next = anyFailed
			? { ...next, status: "failed", failedAt: next.failedAt ?? nowIso }
			: { ...next, status: "completed", completedAt: next.completedAt ?? nowIso };
		if (activeTaskId === next.id) activeTaskId = undefined;
	}

	const tasks = [...snapshot.tasks];
	tasks[taskIdx] = next;

	return {
		state: bump(state, conversationId, {
			conversationId,
			tasks,
			...(activeTaskId !== undefined ? { activeTaskId } : {}),
		}),
		hydrateNeeded: false,
	};
}

/**
 * Apply a cold-start hydrate response.
 *
 * Dropped when a live event for the same conversation landed while the fetch
 * was in flight (`seqFor(...) !== seqAtFetchStart`) — the live stream is
 * newer by definition, and letting the slower read win is what makes the
 * panel flicker backwards.
 */
export function applyHydratedSnapshot(
	state: TaskSnapshotState,
	conversationId: string,
	payload: { tasks?: unknown; activeTaskId?: string } | null | undefined,
	seqAtFetchStart: number,
): TaskSnapshotState {
	if (!conversationId || !payload) return state;
	if (seqFor(state, conversationId) !== seqAtFetchStart) return state;

	const tasks = Array.isArray(payload.tasks) ? (payload.tasks as TaskPanelTask[]) : [];
	// Nothing persisted and nothing on screen — don't churn the store (and
	// don't manufacture an empty record that `hasAnyTasks` has to filter).
	if (tasks.length === 0 && !state.snapshots[conversationId]) return state;

	return {
		// The hydrate is not a live event, so `seq` is deliberately untouched:
		// it counts only what arrived on the bus.
		seq: state.seq,
		snapshots: {
			...state.snapshots,
			[conversationId]: {
				conversationId,
				tasks,
				...(payload.activeTaskId !== undefined ? { activeTaskId: payload.activeTaskId } : {}),
			},
		},
	};
}
