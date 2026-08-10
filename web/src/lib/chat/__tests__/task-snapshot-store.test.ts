/**
 * Unit tests for the task-panel snapshot reducer.
 *
 * The reducer is the one place that decides which of the three writers wins
 * when they race: the `task:snapshot` bus event, the `task:assignment_update`
 * delta, and the cold-start hydrate. Those ordering rules are the whole
 * reason the panel used to go blank on refresh and show stale state during a
 * run, so they get exhaustive coverage here.
 */

import { describe, test, expect } from "bun:test";
import type { TaskAssignment, TaskPanelTask, TaskSnapshot } from "$lib/stores.svelte.js";
import {
  applyAssignmentUpdate,
  applyHydratedSnapshot,
  applyLiveSnapshot,
  emptyTaskSnapshotState,
  seqFor,
  type AssignmentUpdatePayload,
  type TaskSnapshotState,
} from "../task-snapshot-store.js";

const NOW = "2026-07-28T12:00:00.000Z";

function makeAssignment(overrides: Partial<TaskAssignment> = {}): TaskAssignment {
  return {
    id: "a1",
    agentConfigId: "cfg-1",
    agentName: "researcher",
    isTeam: false,
    status: "assigned",
    assignedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskPanelTask> = {}): TaskPanelTask {
  return {
    id: "t1",
    title: "Do the thing",
    description: "",
    status: "pending",
    assignments: [],
    subtasks: [],
    priority: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    conversationId: "conv-1",
    tasks: [makeTask()],
    ...overrides,
  };
}

function update(overrides: Partial<AssignmentUpdatePayload> = {}): AssignmentUpdatePayload {
  return {
    conversationId: "conv-1",
    taskId: "t1",
    assignment: makeAssignment(),
    ...overrides,
  };
}

/** Seed a state with one live snapshot already applied. */
function seeded(snapshot: TaskSnapshot = makeSnapshot()): TaskSnapshotState {
  return applyLiveSnapshot(emptyTaskSnapshotState(), snapshot).state;
}

describe("emptyTaskSnapshotState / seqFor", () => {
  test("starts with no snapshots and no sequence entries", () => {
    const s = emptyTaskSnapshotState();
    expect(s.snapshots).toEqual({});
    expect(s.seq).toEqual({});
  });

  test("seqFor defaults to 0 for an unknown conversation", () => {
    expect(seqFor(emptyTaskSnapshotState(), "nope")).toBe(0);
  });
});

describe("applyLiveSnapshot", () => {
  test("records the snapshot under its conversationId and bumps seq", () => {
    const { state, hydrateNeeded } = applyLiveSnapshot(emptyTaskSnapshotState(), makeSnapshot());
    expect(state.snapshots["conv-1"]?.tasks).toHaveLength(1);
    expect(seqFor(state, "conv-1")).toBe(1);
    expect(hydrateNeeded).toBe(false);
  });

  test("keeps conversations independent", () => {
    let s = applyLiveSnapshot(emptyTaskSnapshotState(), makeSnapshot()).state;
    s = applyLiveSnapshot(
      s,
      makeSnapshot({ conversationId: "conv-2", tasks: [makeTask({ id: "t9" })] }),
    ).state;
    expect(Object.keys(s.snapshots).sort()).toEqual(["conv-1", "conv-2"]);
    expect(s.snapshots["conv-2"]?.tasks[0]?.id).toBe("t9");
    expect(seqFor(s, "conv-1")).toBe(1);
    expect(seqFor(s, "conv-2")).toBe(1);
  });

  test("replaces the snapshot wholesale on re-emit", () => {
    let s = seeded();
    s = applyLiveSnapshot(s, makeSnapshot({ tasks: [makeTask({ id: "t2", title: "New" })] })).state;
    expect(s.snapshots["conv-1"]?.tasks.map((t) => t.id)).toEqual(["t2"]);
    expect(seqFor(s, "conv-1")).toBe(2);
  });

  test("carries activeTaskId through, and omits it when absent", () => {
    const withActive = applyLiveSnapshot(
      emptyTaskSnapshotState(),
      makeSnapshot({ activeTaskId: "t1" }),
    ).state;
    expect(withActive.snapshots["conv-1"]?.activeTaskId).toBe("t1");

    const without = applyLiveSnapshot(emptyTaskSnapshotState(), makeSnapshot()).state;
    expect("activeTaskId" in (without.snapshots["conv-1"] as object)).toBe(false);
  });

  test("coerces a non-array tasks field to an empty list", () => {
    const s = applyLiveSnapshot(emptyTaskSnapshotState(), {
      conversationId: "conv-1",
      tasks: "boom",
    } as unknown as TaskSnapshot).state;
    expect(s.snapshots["conv-1"]?.tasks).toEqual([]);
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["no conversationId", { tasks: [] } as unknown as TaskSnapshot],
    ["empty conversationId", { conversationId: "", tasks: [] } as TaskSnapshot],
  ])("ignores a malformed payload (%s) without touching state", (_label, payload) => {
    const before = seeded();
    const after = applyLiveSnapshot(before, payload as TaskSnapshot);
    expect(after.state).toBe(before);
    expect(after.hydrateNeeded).toBe(false);
  });

  test("returns a fresh snapshots object so reactive consumers re-render", () => {
    const before = seeded();
    const after = applyLiveSnapshot(before, makeSnapshot()).state;
    expect(after.snapshots).not.toBe(before.snapshots);
  });
});

describe("applyAssignmentUpdate", () => {
  test("appends an assignment the task doesn't have yet", () => {
    const { state } = applyAssignmentUpdate(seeded(), update(), NOW);
    const task = state.snapshots["conv-1"]?.tasks[0];
    expect(task?.assignments).toHaveLength(1);
    expect(task?.assignments[0]?.id).toBe("a1");
    expect(seqFor(state, "conv-1")).toBe(2);
  });

  test("replaces an assignment in place when the id already exists", () => {
    const base = seeded(
      makeSnapshot({
        tasks: [makeTask({ assignments: [makeAssignment({ status: "assigned" })] })],
      }),
    );
    const { state } = applyAssignmentUpdate(
      base,
      update({ assignment: makeAssignment({ status: "running", startedAt: NOW }) }),
      NOW,
    );
    const assignments = state.snapshots["conv-1"]?.tasks[0]?.assignments ?? [];
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.status).toBe("running");
    expect(assignments[0]?.startedAt).toBe(NOW);
  });

  test("does not mutate the previous state's task objects", () => {
    const before = seeded();
    const beforeTask = before.snapshots["conv-1"]!.tasks[0]!;
    applyAssignmentUpdate(before, update(), NOW);
    expect(beforeTask.assignments).toHaveLength(0);
  });

  // ── the bug: deltas for state we don't have ──
  test("asks for a hydrate when the conversation has no snapshot", () => {
    const { state, hydrateNeeded } = applyAssignmentUpdate(emptyTaskSnapshotState(), update(), NOW);
    expect(hydrateNeeded).toBe(true);
    expect(state.snapshots).toEqual({});
  });

  test("asks for a hydrate when the task is not in the snapshot", () => {
    const { hydrateNeeded } = applyAssignmentUpdate(seeded(), update({ taskId: "missing" }), NOW);
    expect(hydrateNeeded).toBe(true);
  });

  test.each([
    ["no conversationId", { conversationId: "" }],
    ["no taskId", { taskId: "" }],
    ["assignment without an id", { assignment: makeAssignment({ id: "" }) }],
  ])("ignores a malformed payload (%s) and does not request a hydrate", (_label, patch) => {
    const before = seeded();
    const after = applyAssignmentUpdate(before, update(patch), NOW);
    expect(after.state).toBe(before);
    expect(after.hydrateNeeded).toBe(false);
  });

  test("tolerates a task whose assignments array is missing", () => {
    const task = makeTask();
    delete (task as Partial<TaskPanelTask>).assignments;
    const { state } = applyAssignmentUpdate(seeded(makeSnapshot({ tasks: [task] })), update(), NOW);
    expect(state.snapshots["conv-1"]?.tasks[0]?.assignments).toHaveLength(1);
  });

  describe("schema-failure flag", () => {
    test("flags schemaFailed when structuredResultError rides the event alone", () => {
      const { state } = applyAssignmentUpdate(
        seeded(),
        update({ structuredResultError: "not valid JSON" }),
        NOW,
      );
      expect(state.snapshots["conv-1"]?.tasks[0]?.assignments[0]?.schemaFailed).toBe(true);
    });

    test("does NOT flag a validated-but-oversized (overCap) result", () => {
      const { state } = applyAssignmentUpdate(
        seeded(),
        update({ structuredResultError: "too big", structuredResultOverCap: true }),
        NOW,
      );
      expect(state.snapshots["conv-1"]?.tasks[0]?.assignments[0]?.schemaFailed).toBe(false);
    });

    test("is false when no structured error is present", () => {
      const { state } = applyAssignmentUpdate(seeded(), update(), NOW);
      expect(state.snapshots["conv-1"]?.tasks[0]?.assignments[0]?.schemaFailed).toBe(false);
    });
  });

  describe("client-side task rollup", () => {
    test("flips the task to completed when its only assignment completes", () => {
      const base = seeded(
        makeSnapshot({ tasks: [makeTask({ status: "active" })], activeTaskId: "t1" }),
      );
      const { state } = applyAssignmentUpdate(
        base,
        update({ assignment: makeAssignment({ status: "completed" }) }),
        NOW,
      );
      const snap = state.snapshots["conv-1"]!;
      expect(snap.tasks[0]?.status).toBe("completed");
      expect(snap.tasks[0]?.completedAt).toBe(NOW);
      expect(snap.activeTaskId).toBeUndefined();
    });

    test("stays active while a sibling assignment is still running", () => {
      const base = seeded(
        makeSnapshot({
          tasks: [
            makeTask({
              status: "active",
              assignments: [
                makeAssignment({ id: "a1", status: "running" }),
                makeAssignment({ id: "a2", status: "running" }),
              ],
            }),
          ],
        }),
      );
      const { state } = applyAssignmentUpdate(
        base,
        update({ assignment: makeAssignment({ id: "a1", status: "completed" }) }),
        NOW,
      );
      expect(state.snapshots["conv-1"]?.tasks[0]?.status).toBe("active");
    });

    test("flips to failed when any terminal assignment failed", () => {
      const base = seeded(
        makeSnapshot({
          tasks: [
            makeTask({
              status: "active",
              assignments: [makeAssignment({ id: "a1", status: "completed" })],
            }),
          ],
        }),
      );
      const { state } = applyAssignmentUpdate(
        base,
        update({ assignment: makeAssignment({ id: "a2", status: "failed" }) }),
        NOW,
      );
      expect(state.snapshots["conv-1"]?.tasks[0]?.status).toBe("failed");
      expect(state.snapshots["conv-1"]?.tasks[0]?.failedAt).toBe(NOW);
    });

    test("keeps an existing terminal timestamp rather than overwriting it", () => {
      const base = seeded(
        makeSnapshot({
          tasks: [makeTask({ status: "active", completedAt: "2026-01-01T00:00:00.000Z" })],
        }),
      );
      const { state } = applyAssignmentUpdate(
        base,
        update({ assignment: makeAssignment({ status: "completed" }) }),
        NOW,
      );
      expect(state.snapshots["conv-1"]?.tasks[0]?.completedAt).toBe("2026-01-01T00:00:00.000Z");
    });

    test("keeps an existing failedAt rather than overwriting it", () => {
      const base = seeded(
        makeSnapshot({
          tasks: [makeTask({ status: "active", failedAt: "2026-01-01T00:00:00.000Z" })],
        }),
      );
      const { state } = applyAssignmentUpdate(
        base,
        update({ assignment: makeAssignment({ status: "failed" }) }),
        NOW,
      );
      expect(state.snapshots["conv-1"]?.tasks[0]?.failedAt).toBe("2026-01-01T00:00:00.000Z");
    });

    test("leaves an already-terminal task alone on a late update", () => {
      const base = seeded(
        makeSnapshot({
          tasks: [makeTask({ status: "completed", completedAt: "2026-01-01T00:00:00.000Z" })],
        }),
      );
      const { state } = applyAssignmentUpdate(
        base,
        update({ assignment: makeAssignment({ status: "failed" }) }),
        NOW,
      );
      expect(state.snapshots["conv-1"]?.tasks[0]?.status).toBe("completed");
    });

    test("does not roll up a task that still has zero assignments", () => {
      const base = seeded(makeSnapshot({ tasks: [makeTask({ status: "active" })] }));
      const { state } = applyAssignmentUpdate(
        base,
        update({ assignment: makeAssignment({ status: "running" }) }),
        NOW,
      );
      expect(state.snapshots["conv-1"]?.tasks[0]?.status).toBe("active");
    });

    test("leaves activeTaskId alone when a different task rolls up", () => {
      const base = seeded(
        makeSnapshot({
          tasks: [makeTask({ id: "t1", status: "active" }), makeTask({ id: "t2" })],
          activeTaskId: "t2",
        }),
      );
      const { state } = applyAssignmentUpdate(
        base,
        update({ taskId: "t1", assignment: makeAssignment({ status: "completed" }) }),
        NOW,
      );
      expect(state.snapshots["conv-1"]?.activeTaskId).toBe("t2");
    });
  });
});

describe("applyHydratedSnapshot", () => {
  test("fills an empty store from the persisted response", () => {
    const s = applyHydratedSnapshot(
      emptyTaskSnapshotState(),
      "conv-1",
      { tasks: [makeTask()], activeTaskId: "t1" },
      0,
    );
    expect(s.snapshots["conv-1"]?.tasks).toHaveLength(1);
    expect(s.snapshots["conv-1"]?.activeTaskId).toBe("t1");
  });

  test("does not count as a live event (seq is untouched)", () => {
    const before = seeded();
    const after = applyHydratedSnapshot(before, "conv-1", { tasks: [makeTask()] }, 1);
    expect(seqFor(after, "conv-1")).toBe(1);
  });

  // ── the ordering guard ──
  test("is dropped when a live event landed while the fetch was in flight", () => {
    const before = seeded(); // seq = 1, captured by the fetch as `0`
    const after = applyHydratedSnapshot(before, "conv-1", { tasks: [] }, 0);
    expect(after).toBe(before);
  });

  test("applies when no live event intervened", () => {
    const before = seeded();
    const after = applyHydratedSnapshot(
      before,
      "conv-1",
      { tasks: [makeTask({ id: "persisted" })] },
      1,
    );
    expect(after.snapshots["conv-1"]?.tasks[0]?.id).toBe("persisted");
  });

  test("an empty response for an unseen conversation is a no-op", () => {
    const before = emptyTaskSnapshotState();
    expect(applyHydratedSnapshot(before, "conv-1", { tasks: [] }, 0)).toBe(before);
  });

  test("an empty response CAN clear a conversation we already render", () => {
    const before = seeded();
    const after = applyHydratedSnapshot(before, "conv-1", { tasks: [] }, 1);
    expect(after.snapshots["conv-1"]?.tasks).toEqual([]);
  });

  test("omits activeTaskId when the response has none", () => {
    const s = applyHydratedSnapshot(emptyTaskSnapshotState(), "conv-1", { tasks: [makeTask()] }, 0);
    expect("activeTaskId" in (s.snapshots["conv-1"] as object)).toBe(false);
  });

  test("coerces a non-array tasks field", () => {
    const s = applyHydratedSnapshot(seeded(), "conv-1", { tasks: null }, 1);
    expect(s.snapshots["conv-1"]?.tasks).toEqual([]);
  });

  test.each([
    ["null payload", null],
    ["undefined payload", undefined],
  ])("ignores %s", (_label, payload) => {
    const before = seeded();
    expect(applyHydratedSnapshot(before, "conv-1", payload, 1)).toBe(before);
  });

  test("ignores an empty conversationId", () => {
    const before = seeded();
    expect(applyHydratedSnapshot(before, "", { tasks: [makeTask()] }, 0)).toBe(before);
  });

  test("does not disturb other conversations", () => {
    let s = seeded();
    s = applyLiveSnapshot(s, makeSnapshot({ conversationId: "conv-2" })).state;
    const after = applyHydratedSnapshot(s, "conv-1", { tasks: [] }, 1);
    expect(after.snapshots["conv-2"]?.tasks).toHaveLength(1);
  });
});
