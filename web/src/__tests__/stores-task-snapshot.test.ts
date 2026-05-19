import { describe, test, expect, beforeEach } from "bun:test";

/**
 * Tests for the `task:snapshot` event handling in
 * web/src/lib/stores.svelte.ts plus the `getTaskSnapshot` / `setTaskSnapshot`
 * helpers.
 *
 * Why a test double instead of importing the real store? The real store
 * uses Svelte 5 runes (`$state(...)`), which require the Svelte runtime
 * that we don't have under `bun test`. The existing
 * `permission-routing-integration.test.ts` test uses the same pattern:
 * re-implement the handler logic around plain properties and exercise it
 * so any regression in handler wiring surfaces here.
 *
 * This test mirrors the handler body in stores.svelte.ts around lines
 * 709–718 (the `task:snapshot` case) and the `getTaskSnapshot` /
 * `setTaskSnapshot` exports around lines 314–320.
 */

// ── Types mirrored from src/runtime/tools/task-tracking.ts ───────────────

type TaskStatus = "pending" | "active" | "completed" | "failed";

interface TrackedSubtask {
	id: string;
	title: string;
	completed: boolean;
	position: number;
}

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

interface TrackedTask {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	agentId?: string;
	agentName?: string;
	assignments: TaskAssignment[];
	subtasks: TrackedSubtask[];
	priority: number;
	createdAt: string;
	// Optional timestamps populated on terminal transitions — mirrors the
	// SDK's `TrackedTask` shape in packages/@ezcorp/sdk/src/runtime/task-events.ts.
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

// ── Minimal WSEvent shape (mirrors web/src/lib/ws.ts) ────────────────────

interface WSEvent {
	type: string;
	data: unknown;
}

// ── Test double for the store ────────────────────────────────────────────

class TestStore {
	/** Mirrors `store.taskSnapshots = $state<Record<string, TaskSnapshot>>({})` */
	taskSnapshots: Record<string, TaskSnapshot> = {};

	/**
	 * Mirrors the exported `getTaskSnapshot` helper:
	 *   return store.taskSnapshots[conversationId];
	 */
	getTaskSnapshot(conversationId: string): TaskSnapshot | undefined {
		return this.taskSnapshots[conversationId];
	}

	/**
	 * Mirrors the exported `setTaskSnapshot` helper:
	 *   store.taskSnapshots = {
	 *     ...store.taskSnapshots,
	 *     [snapshot.conversationId]: snapshot,
	 *   };
	 */
	setTaskSnapshot(snapshot: TaskSnapshot): void {
		this.taskSnapshots = {
			...this.taskSnapshots,
			[snapshot.conversationId]: snapshot,
		};
	}

	/**
	 * Mirrors the `task:snapshot` case body in the `initStores`
	 * WebSocket subscriber. Accepts any WSEvent and only mutates state if
	 * it is a well-formed snapshot event.
	 */
	handleWSEvent(event: WSEvent): void {
		switch (event.type) {
			case "task:snapshot": {
				const snapshot = event.data as unknown as TaskSnapshot;
				if (snapshot?.conversationId) {
					this.taskSnapshots = {
						...this.taskSnapshots,
						[snapshot.conversationId]: snapshot,
					};
				}
				break;
			}
			case "task:assignment_update": {
				const { conversationId, taskId, assignment } = event.data as {
					conversationId: string; taskId: string; assignment: TaskAssignment;
				};
				const snapshot = this.taskSnapshots[conversationId];
				if (snapshot) {
					const task = snapshot.tasks.find(t => t.id === taskId);
					if (task) {
						const idx = (task.assignments ?? []).findIndex(a => a.id === assignment.id);
						if (idx >= 0) {
							task.assignments[idx] = assignment;
						} else {
							task.assignments = [...(task.assignments ?? []), assignment];
						}
						if (
							task.status !== "completed" &&
							task.status !== "failed" &&
							task.assignments.length > 0 &&
							task.assignments.every(a => a.status === "completed" || a.status === "failed")
						) {
							const anyFailed = task.assignments.some(a => a.status === "failed");
							task.status = anyFailed ? "failed" : "completed";
							const ts = new Date().toISOString();
							if (anyFailed) task.failedAt = task.failedAt ?? ts;
							else task.completedAt = task.completedAt ?? ts;
							if (snapshot.activeTaskId === task.id) snapshot.activeTaskId = undefined;
						}
						this.taskSnapshots = { ...this.taskSnapshots, [conversationId]: { ...snapshot } };
					}
				}
				break;
			}
		}
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────

function makeAssignment(overrides: Partial<TaskAssignment> = {}): TaskAssignment {
	return {
		id: overrides.id ?? "assign-1",
		agentConfigId: overrides.agentConfigId ?? "config-1",
		agentName: overrides.agentName ?? "researcher",
		isTeam: overrides.isTeam ?? false,
		status: overrides.status ?? "assigned",
		assignedAt: overrides.assignedAt ?? "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function makeTask(overrides: Partial<TrackedTask> = {}): TrackedTask {
	return {
		id: overrides.id ?? "task-1",
		title: overrides.title ?? "Do the thing",
		description: overrides.description ?? "",
		status: overrides.status ?? "pending",
		assignments: overrides.assignments ?? [],
		subtasks: overrides.subtasks ?? [],
		priority: overrides.priority ?? 0,
		createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
		agentId: overrides.agentId,
		agentName: overrides.agentName,
	};
}

function makeSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		conversationId: overrides.conversationId ?? "conv-1",
		tasks: overrides.tasks ?? [makeTask()],
		activeTaskId: overrides.activeTaskId,
	};
}

function snapshotEvent(snapshot: unknown): WSEvent {
	return { type: "task:snapshot", data: snapshot };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("task:snapshot WS event handling", () => {
	let store: TestStore;

	beforeEach(() => {
		store = new TestStore();
	});

	test("dispatches task:snapshot and records snapshot under its conversationId", () => {
		const snap = makeSnapshot({
			conversationId: "conv-1",
			tasks: [makeTask({ id: "t1", status: "active" })],
			activeTaskId: "t1",
		});

		store.handleWSEvent(snapshotEvent(snap));

		expect(store.taskSnapshots["conv-1"]).toEqual(snap);
	});

	test("multiple conversations are kept separate", () => {
		const snapA = makeSnapshot({
			conversationId: "conv-A",
			tasks: [makeTask({ id: "a1" })],
		});
		const snapB = makeSnapshot({
			conversationId: "conv-B",
			tasks: [makeTask({ id: "b1" }), makeTask({ id: "b2" })],
		});

		store.handleWSEvent(snapshotEvent(snapA));
		store.handleWSEvent(snapshotEvent(snapB));

		expect(store.taskSnapshots["conv-A"]).toEqual(snapA);
		expect(store.taskSnapshots["conv-B"]).toEqual(snapB);
		expect(Object.keys(store.taskSnapshots).sort()).toEqual([
			"conv-A",
			"conv-B",
		]);
	});

	test("updating one conversation does not affect the other", () => {
		const snapA = makeSnapshot({ conversationId: "conv-A" });
		const snapB = makeSnapshot({ conversationId: "conv-B" });

		store.handleWSEvent(snapshotEvent(snapA));
		store.handleWSEvent(snapshotEvent(snapB));

		const updatedA = makeSnapshot({
			conversationId: "conv-A",
			tasks: [
				makeTask({ id: "new-1", status: "completed" }),
				makeTask({ id: "new-2", status: "active" }),
			],
			activeTaskId: "new-2",
		});
		store.handleWSEvent(snapshotEvent(updatedA));

		expect(store.taskSnapshots["conv-A"]).toEqual(updatedA);
		// conv-B is still the original
		expect(store.taskSnapshots["conv-B"]).toEqual(snapB);
	});

	test("re-dispatching for the same conversation replaces the snapshot entirely", () => {
		const initial = makeSnapshot({
			conversationId: "conv-1",
			tasks: [
				makeTask({ id: "t1", status: "pending" }),
				makeTask({ id: "t2", status: "pending" }),
			],
		});
		const replaced = makeSnapshot({
			conversationId: "conv-1",
			tasks: [makeTask({ id: "t3", status: "completed" })],
		});

		store.handleWSEvent(snapshotEvent(initial));
		store.handleWSEvent(snapshotEvent(replaced));

		expect(store.taskSnapshots["conv-1"]).toEqual(replaced);
		// No residue from the initial snapshot
		expect(store.taskSnapshots["conv-1"]!.tasks.map((t) => t.id)).toEqual([
			"t3",
		]);
	});

	test("handler treats taskSnapshots as immutable (new object reference on update)", () => {
		const snap = makeSnapshot({ conversationId: "conv-1" });
		store.handleWSEvent(snapshotEvent(snap));
		const before = store.taskSnapshots;

		const snap2 = makeSnapshot({
			conversationId: "conv-2",
			tasks: [makeTask({ id: "z" })],
		});
		store.handleWSEvent(snapshotEvent(snap2));
		const after = store.taskSnapshots;

		// Svelte 5 fine-grained reactivity requires a new reference for updates
		// to propagate — the handler must spread rather than mutate.
		expect(after).not.toBe(before);
		expect(before["conv-2"]).toBeUndefined();
		expect(after["conv-2"]).toEqual(snap2);
	});

	// ── Invalid-shape safety ─────────────────────────────────────────────

	test("task:snapshot event with no conversationId is ignored and does not crash", () => {
		const bogus = { tasks: [], activeTaskId: undefined } as unknown;
		store.handleWSEvent(snapshotEvent(bogus));
		expect(store.taskSnapshots).toEqual({});
	});

	test("task:snapshot event with null data is ignored", () => {
		store.handleWSEvent(snapshotEvent(null));
		expect(store.taskSnapshots).toEqual({});
	});

	test("task:snapshot event with undefined data is ignored", () => {
		store.handleWSEvent(snapshotEvent(undefined));
		expect(store.taskSnapshots).toEqual({});
	});

	test("task:snapshot event with empty-string conversationId is ignored (truthy check)", () => {
		const bogus = { conversationId: "", tasks: [] } as unknown;
		store.handleWSEvent(snapshotEvent(bogus));
		expect(store.taskSnapshots).toEqual({});
	});

	test("invalid snapshot does not wipe existing snapshots", () => {
		const good = makeSnapshot({ conversationId: "conv-1" });
		store.handleWSEvent(snapshotEvent(good));

		// Dispatch a malformed snapshot
		store.handleWSEvent(snapshotEvent({ tasks: [] }));

		// Existing snapshot is untouched
		expect(store.taskSnapshots["conv-1"]).toEqual(good);
	});

	test("non-task events do not affect taskSnapshots", () => {
		const snap = makeSnapshot({ conversationId: "conv-1" });
		store.handleWSEvent(snapshotEvent(snap));

		store.handleWSEvent({ type: "run:start", data: { run: { id: "r1" } } });
		store.handleWSEvent({ type: "tool:complete", data: {} });
		store.handleWSEvent({ type: "ws:connected", data: {} });

		expect(store.taskSnapshots).toEqual({ "conv-1": snap });
	});
});

// ── getTaskSnapshot helper ───────────────────────────────────────────────

describe("getTaskSnapshot", () => {
	let store: TestStore;

	beforeEach(() => {
		store = new TestStore();
	});

	test("returns undefined for unknown conversationId", () => {
		expect(store.getTaskSnapshot("missing")).toBeUndefined();
	});

	test("returns the snapshot for a known conversationId", () => {
		const snap = makeSnapshot({ conversationId: "conv-1" });
		store.handleWSEvent(snapshotEvent(snap));
		expect(store.getTaskSnapshot("conv-1")).toEqual(snap);
	});

	test("returns undefined when queried for a different conversation", () => {
		const snap = makeSnapshot({ conversationId: "conv-1" });
		store.handleWSEvent(snapshotEvent(snap));
		expect(store.getTaskSnapshot("conv-2")).toBeUndefined();
	});

	test("reflects the latest snapshot after multiple updates", () => {
		store.handleWSEvent(
			snapshotEvent(
				makeSnapshot({
					conversationId: "conv-1",
					tasks: [makeTask({ id: "v1" })],
				}),
			),
		);
		store.handleWSEvent(
			snapshotEvent(
				makeSnapshot({
					conversationId: "conv-1",
					tasks: [makeTask({ id: "v2" })],
				}),
			),
		);
		const got = store.getTaskSnapshot("conv-1");
		expect(got!.tasks.map((t) => t.id)).toEqual(["v2"]);
	});
});

// ── setTaskSnapshot helper ───────────────────────────────────────────────

describe("setTaskSnapshot", () => {
	let store: TestStore;

	beforeEach(() => {
		store = new TestStore();
	});

	test("stores the snapshot under snapshot.conversationId", () => {
		const snap = makeSnapshot({
			conversationId: "conv-set",
			tasks: [makeTask({ id: "x" })],
		});
		store.setTaskSnapshot(snap);
		expect(store.taskSnapshots["conv-set"]).toEqual(snap);
	});

	test("preserves snapshots for other conversations", () => {
		const a = makeSnapshot({ conversationId: "conv-A" });
		const b = makeSnapshot({ conversationId: "conv-B" });
		store.setTaskSnapshot(a);
		store.setTaskSnapshot(b);

		expect(store.taskSnapshots["conv-A"]).toEqual(a);
		expect(store.taskSnapshots["conv-B"]).toEqual(b);
	});

	test("overwrites existing snapshot for the same conversationId", () => {
		const first = makeSnapshot({
			conversationId: "conv-1",
			tasks: [makeTask({ id: "old" })],
		});
		const second = makeSnapshot({
			conversationId: "conv-1",
			tasks: [makeTask({ id: "new" })],
		});
		store.setTaskSnapshot(first);
		store.setTaskSnapshot(second);

		expect(store.taskSnapshots["conv-1"]).toEqual(second);
	});

	test("setTaskSnapshot creates a new object reference (immutable update)", () => {
		const a = makeSnapshot({ conversationId: "conv-A" });
		store.setTaskSnapshot(a);
		const before = store.taskSnapshots;

		const b = makeSnapshot({ conversationId: "conv-B" });
		store.setTaskSnapshot(b);
		expect(store.taskSnapshots).not.toBe(before);
	});

	test("handler + setTaskSnapshot are interchangeable", () => {
		const viaHandler = makeSnapshot({ conversationId: "conv-h" });
		const viaSetter = makeSnapshot({ conversationId: "conv-s" });

		store.handleWSEvent(snapshotEvent(viaHandler));
		store.setTaskSnapshot(viaSetter);

		expect(store.getTaskSnapshot("conv-h")).toEqual(viaHandler);
		expect(store.getTaskSnapshot("conv-s")).toEqual(viaSetter);
	});

	// ── teamPanel state helpers ─────────────────────────────────────────

	describe("teamPanel state helpers", () => {
		/**
		 * Since Svelte 5 runes don't run under bun:test, we recreate the
		 * helper logic as plain functions operating on a plain object that
		 * mirrors store.teamPanel.
		 */
		type TeamPanelState = {
			open: boolean;
			agentConfigId: string | null;
			teamName: string | null;
			conversationId: string | null;
			drillDownAgent: { subConversationId: string; agentName: string } | null;
		};

		const defaults: TeamPanelState = {
			open: false, agentConfigId: null, teamName: null, conversationId: null, drillDownAgent: null,
		};

		function openTeamPanel(
			panel: TeamPanelState, conversationId: string, agentConfigId: string, teamName: string,
		): TeamPanelState {
			return { open: true, agentConfigId, teamName, conversationId, drillDownAgent: null };
		}

		function closeTeamPanel(): TeamPanelState {
			return { open: false, agentConfigId: null, teamName: null, conversationId: null, drillDownAgent: null };
		}

		function openTeamDrillDown(
			panel: TeamPanelState, subConversationId: string, agentName: string,
		): TeamPanelState {
			return { ...panel, drillDownAgent: { subConversationId, agentName } };
		}

		function closeTeamDrillDown(panel: TeamPanelState): TeamPanelState {
			return { ...panel, drillDownAgent: null };
		}

		let panel: TeamPanelState;

		beforeEach(() => {
			panel = { ...defaults };
		});

		test("openTeamPanel sets all fields correctly", () => {
			panel = openTeamPanel(panel, "conv-42", "cfg-7", "Alpha Squad");
			expect(panel.open).toBe(true);
			expect(panel.agentConfigId).toBe("cfg-7");
			expect(panel.teamName).toBe("Alpha Squad");
			expect(panel.conversationId).toBe("conv-42");
			expect(panel.drillDownAgent).toBeNull();
		});

		test("closeTeamPanel resets to closed state", () => {
			panel = openTeamPanel(panel, "conv-42", "cfg-7", "Alpha Squad");
			panel = closeTeamPanel();
			expect(panel).toEqual(defaults);
		});

		test("openTeamDrillDown sets drillDownAgent while keeping panel open", () => {
			panel = openTeamPanel(panel, "conv-42", "cfg-7", "Alpha Squad");
			panel = openTeamDrillDown(panel, "sub-conv-99", "researcher");
			expect(panel.open).toBe(true);
			expect(panel.agentConfigId).toBe("cfg-7");
			expect(panel.teamName).toBe("Alpha Squad");
			expect(panel.conversationId).toBe("conv-42");
			expect(panel.drillDownAgent).toEqual({ subConversationId: "sub-conv-99", agentName: "researcher" });
		});

		test("closeTeamDrillDown clears drillDownAgent, keeps panel open with same team", () => {
			panel = openTeamPanel(panel, "conv-42", "cfg-7", "Alpha Squad");
			panel = openTeamDrillDown(panel, "sub-conv-99", "researcher");
			panel = closeTeamDrillDown(panel);
			expect(panel.open).toBe(true);
			expect(panel.agentConfigId).toBe("cfg-7");
			expect(panel.teamName).toBe("Alpha Squad");
			expect(panel.conversationId).toBe("conv-42");
			expect(panel.drillDownAgent).toBeNull();
		});

		test("full navigation: open → drill down → close drill down → close panel", () => {
			// Start closed
			expect(panel).toEqual(defaults);

			// Open
			panel = openTeamPanel(panel, "conv-1", "cfg-A", "DevOps Team");
			expect(panel.open).toBe(true);
			expect(panel.drillDownAgent).toBeNull();

			// Drill down into a sub-agent
			panel = openTeamDrillDown(panel, "sub-conv-5", "deployer");
			expect(panel.open).toBe(true);
			expect(panel.drillDownAgent!.agentName).toBe("deployer");
			expect(panel.drillDownAgent!.subConversationId).toBe("sub-conv-5");

			// Close drill down — back to team overview
			panel = closeTeamDrillDown(panel);
			expect(panel.open).toBe(true);
			expect(panel.teamName).toBe("DevOps Team");
			expect(panel.drillDownAgent).toBeNull();

			// Close panel entirely
			panel = closeTeamPanel();
			expect(panel).toEqual(defaults);
		});
	});

	// ── task:assignment_update handler ───────────────────────────────────

	describe("task:assignment_update handler", () => {
		test("adds a new assignment to an existing task", () => {
			const snap = makeSnapshot({
				conversationId: "conv-au",
				tasks: [makeTask({ id: "t1" })],
			});
			store.setTaskSnapshot(snap);

			const assignment = makeAssignment({ id: "a1", agentName: "coder" });
			store.handleWSEvent({
				type: "task:assignment_update",
				data: { conversationId: "conv-au", taskId: "t1", assignment },
			});

			const updated = store.getTaskSnapshot("conv-au")!;
			expect(updated.tasks[0].assignments).toHaveLength(1);
			expect(updated.tasks[0].assignments[0].id).toBe("a1");
			expect(updated.tasks[0].assignments[0].agentName).toBe("coder");
		});

		test("updates an existing assignment in-place", () => {
			const snap = makeSnapshot({
				conversationId: "conv-au2",
				tasks: [makeTask({
					id: "t1",
					assignments: [makeAssignment({ id: "a1", status: "assigned" })],
				})],
			});
			store.setTaskSnapshot(snap);

			const updated = makeAssignment({ id: "a1", status: "running", startedAt: "2026-01-01T01:00:00Z" });
			store.handleWSEvent({
				type: "task:assignment_update",
				data: { conversationId: "conv-au2", taskId: "t1", assignment: updated },
			});

			const result = store.getTaskSnapshot("conv-au2")!;
			expect(result.tasks[0].assignments).toHaveLength(1);
			expect(result.tasks[0].assignments[0].status).toBe("running");
		});

		test("no-ops when conversation not in store", () => {
			store.handleWSEvent({
				type: "task:assignment_update",
				data: { conversationId: "missing", taskId: "t1", assignment: makeAssignment() },
			});
			expect(store.getTaskSnapshot("missing")).toBeUndefined();
		});

		test("no-ops when task not found", () => {
			const snap = makeSnapshot({
				conversationId: "conv-au3",
				tasks: [makeTask({ id: "t1" })],
			});
			store.setTaskSnapshot(snap);

			store.handleWSEvent({
				type: "task:assignment_update",
				data: { conversationId: "conv-au3", taskId: "wrong", assignment: makeAssignment() },
			});

			expect(store.getTaskSnapshot("conv-au3")!.tasks[0].assignments).toHaveLength(0);
		});
	});

	describe("task:assignment_update client-side rollup", () => {
		test("task flips to completed when single assignment finishes", () => {
			const snap = makeSnapshot({
				conversationId: "conv-r1",
				tasks: [makeTask({
					id: "t1",
					status: "active",
					assignments: [makeAssignment({ id: "a1", status: "running" })],
				})],
				activeTaskId: "t1",
			});
			store.setTaskSnapshot(snap);

			store.handleWSEvent({
				type: "task:assignment_update",
				data: {
					conversationId: "conv-r1",
					taskId: "t1",
					assignment: makeAssignment({ id: "a1", status: "completed" }),
				},
			});

			const result = store.getTaskSnapshot("conv-r1")!;
			expect(result.tasks[0].status).toBe("completed");
			expect(result.tasks[0].completedAt).toBeDefined();
			expect(result.activeTaskId).toBeUndefined();
		});

		test("task stays active while one of two assignments is still running", () => {
			const snap = makeSnapshot({
				conversationId: "conv-r2",
				tasks: [makeTask({
					id: "t1",
					status: "active",
					assignments: [
						makeAssignment({ id: "a1", status: "running" }),
						makeAssignment({ id: "a2", status: "running" }),
					],
				})],
			});
			store.setTaskSnapshot(snap);

			store.handleWSEvent({
				type: "task:assignment_update",
				data: {
					conversationId: "conv-r2",
					taskId: "t1",
					assignment: makeAssignment({ id: "a1", status: "completed" }),
				},
			});

			const result = store.getTaskSnapshot("conv-r2")!;
			expect(result.tasks[0].status).toBe("active");
		});

		test("task flips to completed after both of two assignments finish", () => {
			const snap = makeSnapshot({
				conversationId: "conv-r3",
				tasks: [makeTask({
					id: "t1",
					status: "active",
					assignments: [
						makeAssignment({ id: "a1", status: "running" }),
						makeAssignment({ id: "a2", status: "running" }),
					],
				})],
			});
			store.setTaskSnapshot(snap);

			store.handleWSEvent({
				type: "task:assignment_update",
				data: {
					conversationId: "conv-r3",
					taskId: "t1",
					assignment: makeAssignment({ id: "a1", status: "completed" }),
				},
			});
			store.handleWSEvent({
				type: "task:assignment_update",
				data: {
					conversationId: "conv-r3",
					taskId: "t1",
					assignment: makeAssignment({ id: "a2", status: "completed" }),
				},
			});

			const result = store.getTaskSnapshot("conv-r3")!;
			expect(result.tasks[0].status).toBe("completed");
		});

		test("task flips to failed when any assignment is failed and all are terminal", () => {
			const snap = makeSnapshot({
				conversationId: "conv-r4",
				tasks: [makeTask({
					id: "t1",
					status: "active",
					assignments: [
						makeAssignment({ id: "a1", status: "completed" }),
						makeAssignment({ id: "a2", status: "running" }),
					],
				})],
			});
			store.setTaskSnapshot(snap);

			store.handleWSEvent({
				type: "task:assignment_update",
				data: {
					conversationId: "conv-r4",
					taskId: "t1",
					assignment: makeAssignment({ id: "a2", status: "failed" }),
				},
			});

			const result = store.getTaskSnapshot("conv-r4")!;
			expect(result.tasks[0].status).toBe("failed");
			expect(result.tasks[0].failedAt).toBeDefined();
		});

		test("already-terminal task is not mutated by a late update", () => {
			const task = makeTask({
				id: "t1",
				status: "completed",
				assignments: [makeAssignment({ id: "a1", status: "completed" })],
			});
			(task as { completedAt?: string }).completedAt = "2026-01-01T00:00:00Z";
			const snap = makeSnapshot({ conversationId: "conv-r5", tasks: [task] });
			store.setTaskSnapshot(snap);

			store.handleWSEvent({
				type: "task:assignment_update",
				data: {
					conversationId: "conv-r5",
					taskId: "t1",
					assignment: makeAssignment({ id: "a1", status: "completed", resultPreview: "newer" }),
				},
			});

			const result = store.getTaskSnapshot("conv-r5")!;
			expect(result.tasks[0].status).toBe("completed");
			expect((result.tasks[0] as { completedAt?: string }).completedAt).toBe("2026-01-01T00:00:00Z");
			expect(result.tasks[0].assignments[0].resultPreview).toBe("newer");
		});
	});
});
