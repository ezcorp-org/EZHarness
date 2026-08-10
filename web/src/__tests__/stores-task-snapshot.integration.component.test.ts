/**
 * INTEGRATION test for the task-panel snapshot glue in the REAL
 * `stores.svelte.ts` — the `task:snapshot` / `task:assignment_update` switch
 * cases plus the hydration helpers the chat page's effect calls.
 *
 * The reducer itself is unit-tested in
 * `web/src/lib/chat/__tests__/task-snapshot-store.test.ts`. What that suite
 * CANNOT prove is the wiring: that the store actually routes bus events into
 * the reducer, writes the result back to the rune state, and raises a
 * hydration request when a delta arrives for a conversation it has no
 * snapshot for. A future edit that reverted the store to its own inline copy
 * of the reducer would keep the unit suite green and fail here.
 *
 * Harness mirrors `stores-ask-user-dedup.integration.component.test.ts`:
 * mock the WS client, capture its subscriber, dispatch events at it.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";

let capturedSubscriber: ((evt: { type: string; data: unknown }) => void) | null = null;

vi.mock("$lib/ws", () => ({
  createWSClient: () => ({
    subscribe: (fn: (evt: { type: string; data: unknown }) => void) => {
      capturedSubscriber = fn;
      return () => {};
    },
    close: () => {},
    manualRetry: () => {},
  }),
}));

vi.mock("$lib/api", () => ({
  fetchAgents: () => Promise.resolve([]),
  fetchRuns: () => Promise.resolve([]),
  fetchProjects: () => Promise.resolve([]),
  fetchSettings: () => Promise.resolve({}),
  fetchAgentConfigs: () => Promise.resolve([]),
  fetchWorkflows: () => Promise.resolve([]),
}));

import {
  getTaskSeq,
  getTaskSnapshot,
  hydrateTaskSnapshotInto,
  initStores,
  setTaskSnapshot,
  store,
  taskHydrationRequests,
} from "$lib/stores.svelte";

function emit(type: string, data: unknown) {
  if (!capturedSubscriber) throw new Error("subscriber not captured — initStores not called?");
  capturedSubscriber({ type, data });
}

function task(overrides: Record<string, unknown> = {}) {
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

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    agentConfigId: "cfg-1",
    agentName: "researcher",
    isTeam: false,
    status: "running",
    assignedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const CONV = "conv-task-int";

describe("stores.svelte.ts — task snapshot wiring (real handlers)", () => {
  beforeEach(() => {
    capturedSubscriber = null;
    initStores();
    store.taskSnapshots = {};
    store.taskSeq = {};
    store.taskHydrationRequests = 0;
  });

  test("task:snapshot lands in the store and bumps the live-event counter", () => {
    expect(getTaskSeq(CONV)).toBe(0);

    emit("task:snapshot", { conversationId: CONV, tasks: [task()], activeTaskId: "t1" });

    expect(getTaskSnapshot(CONV)?.tasks).toHaveLength(1);
    expect(getTaskSnapshot(CONV)?.activeTaskId).toBe("t1");
    expect(getTaskSeq(CONV)).toBe(1);
  });

  test("a malformed task:snapshot is ignored without disturbing the store", () => {
    emit("task:snapshot", { conversationId: CONV, tasks: [task()] });
    emit("task:snapshot", { tasks: [] });

    expect(getTaskSnapshot(CONV)?.tasks).toHaveLength(1);
    expect(getTaskSeq(CONV)).toBe(1);
  });

  test("task:assignment_update folds into the snapshot and rolls the task up", () => {
    emit("task:snapshot", {
      conversationId: CONV,
      tasks: [task({ status: "active", assignments: [assignment()] })],
      activeTaskId: "t1",
    });

    emit("task:assignment_update", {
      conversationId: CONV,
      taskId: "t1",
      assignment: assignment({ status: "completed" }),
    });

    const snap = getTaskSnapshot(CONV);
    expect(snap?.tasks[0]?.assignments[0]?.status).toBe("completed");
    // Last assignment terminal ⇒ the task flips without waiting for the
    // extension's slower snapshot round-trip.
    expect(snap?.tasks[0]?.status).toBe("completed");
    expect(snap?.activeTaskId).toBeUndefined();
    expect(getTaskSeq(CONV)).toBe(2);
  });

  test("the schema-failure flag rides through from the top-level event field", () => {
    emit("task:snapshot", { conversationId: CONV, tasks: [task()] });
    emit("task:assignment_update", {
      conversationId: CONV,
      taskId: "t1",
      assignment: assignment({ status: "completed" }),
      structuredResultError: "not valid JSON",
    });

    expect(getTaskSnapshot(CONV)?.tasks[0]?.assignments[0]?.schemaFailed).toBe(true);
  });

  // ── the bug: a delta we can't apply must not vanish ──
  test("an assignment update for an unknown conversation raises a hydration request", () => {
    expect(taskHydrationRequests()).toBe(0);

    emit("task:assignment_update", {
      conversationId: "never-seen",
      taskId: "t1",
      assignment: assignment({ status: "completed" }),
    });

    // Before this, the delta was silently dropped and the panel stayed
    // stale until some later full snapshot happened to arrive.
    expect(taskHydrationRequests()).toBe(1);
    expect(getTaskSnapshot("never-seen")).toBeUndefined();
  });

  test("an assignment update for an unknown task also asks for a resync", () => {
    emit("task:snapshot", { conversationId: CONV, tasks: [task()] });

    emit("task:assignment_update", {
      conversationId: CONV,
      taskId: "no-such-task",
      assignment: assignment(),
    });

    expect(taskHydrationRequests()).toBe(1);
  });

  test("setTaskSnapshot writes through the same reducer", () => {
    setTaskSnapshot({ conversationId: CONV, tasks: [task({ id: "manual" })] } as never);

    expect(getTaskSnapshot(CONV)?.tasks[0]?.id).toBe("manual");
    expect(getTaskSeq(CONV)).toBe(1);
  });

  // ── cold-start hydration ──
  test("hydrateTaskSnapshotInto fills an empty store", () => {
    hydrateTaskSnapshotInto(CONV, { tasks: [task()], activeTaskId: "t1" }, 0);

    expect(getTaskSnapshot(CONV)?.tasks).toHaveLength(1);
    // A hydrate is not a live event, so the counter stays put.
    expect(getTaskSeq(CONV)).toBe(0);
  });

  test("a hydrate response overtaken by a live event is discarded", () => {
    // The effect captured seq=0 before its fetch…
    emit("task:snapshot", { conversationId: CONV, tasks: [task({ id: "live" })] });
    // …and the response lands after the live event bumped it to 1.
    hydrateTaskSnapshotInto(CONV, { tasks: [task({ id: "stale" })] }, 0);

    expect(getTaskSnapshot(CONV)?.tasks[0]?.id).toBe("live");
  });

  test("a hydrate response that was NOT overtaken is applied", () => {
    emit("task:snapshot", { conversationId: CONV, tasks: [task({ id: "live" })] });
    hydrateTaskSnapshotInto(CONV, { tasks: [task({ id: "persisted" })] }, getTaskSeq(CONV));

    expect(getTaskSnapshot(CONV)?.tasks[0]?.id).toBe("persisted");
  });
});
