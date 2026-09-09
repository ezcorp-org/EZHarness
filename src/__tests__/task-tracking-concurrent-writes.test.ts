/**
 * Regression tests for lost updates on the task-tracking snapshot row.
 *
 * The snapshot for a conversation is ONE `extension_storage` row, and every
 * writer does read-modify-write against it. Two writers exist:
 *
 *   1. the extension subprocess — its tool handlers and its
 *      `task:assignment_update` subscription. The SDK channel dispatches
 *      inbound frames fire-and-forget (`void handleIncoming(msg)`), so two
 *      frames arriving in the same tick run their critical sections
 *      interleaved.
 *   2. the host's five task-lifecycle HTTP handlers, which serve concurrent
 *      requests.
 *
 * Interleaved, the second `save` overwrites state the first one had just
 * written:
 *
 *     A: load(v0) ─► a1 completed ─► save(v0+a1)
 *     B:   load(v0) ──────► a2 completed ──────► save(v0+a2)   ← A lost
 *
 * That is the everyday case for orchestration (two sub-agents finishing
 * together; one LLM turn issuing several `task_assign` calls), and the lost
 * write is what left an assignment pinned to "running" while the agent had
 * long since finished — the "task tracker lags behind / is wrong" report.
 *
 * Both halves are now serialized. These tests drive the concurrency directly
 * and assert no write is lost.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  tools,
  _setStoreForTests,
  _setTaskEventsForTests,
  _setAgentConfigsForTests,
  _resetBindingsForTests,
  _internals,
  type PersistedSnapshot,
  type TaskAssignment,
  type TrackedTask,
} from "../../docs/extensions/examples/task-tracking/index";
import { withTaskSnapshotLock } from "../runtime/task-snapshot-lock";

// ── Fakes ───────────────────────────────────────────────────────────

/**
 * Storage whose `get`/`set` both yield to the microtask queue, the way a
 * real reverse-RPC round trip does. Without that suspension point an
 * interleaving can't happen at all and the test would pass vacuously.
 */
class SlowStorage {
  private rows = new Map<string, unknown>();
  /** Every completed `set`, in order — the write log we assert against. */
  readonly writes: PersistedSnapshot[] = [];

  async get<T>(key: string): Promise<{ value: T | null; exists: boolean }> {
    await Promise.resolve();
    if (!this.rows.has(key)) return { value: null, exists: false };
    return { value: structuredClone(this.rows.get(key)) as T, exists: true };
  }

  async set<T>(key: string, value: T): Promise<{ ok: true; sizeBytes: number }> {
    await Promise.resolve();
    await Promise.resolve();
    this.rows.set(key, structuredClone(value));
    this.writes.push(structuredClone(value) as PersistedSnapshot);
    return { ok: true, sizeBytes: 0 };
  }

  seed(snap: PersistedSnapshot): void {
    this.rows.set(_internals.STORAGE_KEY, structuredClone(snap));
  }

  peek(): PersistedSnapshot | undefined {
    return this.rows.get(_internals.STORAGE_KEY) as PersistedSnapshot | undefined;
  }
}

import { TaskEventStorageFixture as FakeTaskEvents } from "./helpers/task-event-storage";

class FakeAgentConfigs {
  async list(): Promise<unknown[]> {
    return [];
  }
  async get(): Promise<unknown> {
    return null;
  }
}

// ── Fixtures ────────────────────────────────────────────────────────

function assignment(id: string, status: TaskAssignment["status"] = "running"): TaskAssignment {
  return {
    id,
    agentConfigId: `cfg-${id}`,
    agentName: `agent-${id}`,
    isTeam: false,
    status,
    assignedAt: "2026-01-01T00:00:00.000Z",
  };
}

function task(overrides: Partial<TrackedTask> & { id: string }): TrackedTask {
  return {
    title: `Task ${overrides.id}`,
    description: "",
    status: "active",
    assignments: [],
    subtasks: [],
    priority: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("task-tracking extension — concurrent snapshot writes", () => {
  let storage: SlowStorage;
  let events: FakeTaskEvents;

  beforeEach(() => {
    storage = new SlowStorage();
    events = new FakeTaskEvents(storage);
    _setStoreForTests(storage as never);
    _setTaskEventsForTests(events as never);
    _setAgentConfigsForTests(new FakeAgentConfigs() as never);
  });

  afterEach(() => {
    _resetBindingsForTests();
  });

  test("two simultaneous assignment completions both survive", async () => {
    storage.seed({
      schemaVersion: 1,
      activeTaskId: "t1",
      tasks: [task({ id: "t1", assignments: [assignment("a1"), assignment("a2")] })],
    });

    // Both frames arrive before either finishes — exactly what
    // `void handleIncoming(msg)` produces on the real channel.
    await Promise.all([
      _internals.handleAssignmentUpdate({
        conversationId: "conv-1",
        taskId: "t1",
        assignment: assignment("a1", "completed"),
      }),
      _internals.handleAssignmentUpdate({
        conversationId: "conv-1",
        taskId: "t1",
        assignment: assignment("a2", "completed"),
      }),
    ]);

    const persisted = storage.peek()!;
    const statuses = persisted.tasks[0]!.assignments.map((a) => a.status).sort();
    expect(statuses).toEqual(["completed", "completed"]);
    // Both terminal ⇒ the task rolls up. Before serialization the second
    // write reinstated a "running" sibling and the task stayed active.
    expect(persisted.tasks[0]!.status).toBe("completed");
    expect(persisted.activeTaskId).toBeUndefined();
  });

  test("the unlocked body loses one of the two writes (proves the fix is load-bearing)", async () => {
    storage.seed({
      schemaVersion: 1,
      activeTaskId: "t1",
      tasks: [task({ id: "t1", assignments: [assignment("a1"), assignment("a2")] })],
    });

    await Promise.all([
      _internals.applyAssignmentUpdate({
        conversationId: "conv-1",
        taskId: "t1",
        assignment: assignment("a1", "completed"),
      }),
      _internals.applyAssignmentUpdate({
        conversationId: "conv-1",
        taskId: "t1",
        assignment: assignment("a2", "completed"),
      }),
    ]);

    const persisted = storage.peek()!;
    const completed = persisted.tasks[0]!.assignments.filter((a) => a.status === "completed");
    expect(completed).toHaveLength(1); // one update was clobbered
    expect(persisted.tasks[0]!.status).toBe("active");
  });

  test("concurrent tool calls on the same conversation don't drop tasks", async () => {
    storage.seed({ schemaVersion: 1, tasks: [] });

    await Promise.all([
      tools.task_add!({ title: "First" }),
      tools.task_add!({ title: "Second" }),
      tools.task_add!({ title: "Third" }),
    ]);

    const titles = (storage.peek()?.tasks ?? []).map((t) => t.title).sort();
    expect(titles).toEqual(["First", "Second", "Third"]);
  });

  test("a rejecting handler does not wedge the queue behind it", async () => {
    storage.seed({ schemaVersion: 1, tasks: [] });

    // `task_start` on a nonexistent task returns a tool error rather than
    // throwing, so force a real rejection through the same lock instead.
    const boom = Promise.resolve(tools.task_add!(null as never)).catch(() => "rejected");
    const after = Promise.resolve(tools.task_add!({ title: "Still runs" }));

    await Promise.all([boom, after]);
    expect((storage.peek()?.tasks ?? []).map((t) => t.title)).toContain("Still runs");
  });
});

describe("withTaskSnapshotLock (host side)", () => {
  test("serializes critical sections for the same conversation", async () => {
    const order: string[] = [];
    const section = (label: string) => async () => {
      order.push(`${label}:enter`);
      await Promise.resolve();
      await Promise.resolve();
      order.push(`${label}:exit`);
    };

    await Promise.all([
      withTaskSnapshotLock("conv-1", section("A")),
      withTaskSnapshotLock("conv-1", section("B")),
    ]);

    expect(order).toEqual(["A:enter", "A:exit", "B:enter", "B:exit"]);
  });

  test("does not serialize across different conversations", async () => {
    const order: string[] = [];
    const section = (label: string) => async () => {
      order.push(`${label}:enter`);
      await Promise.resolve();
      order.push(`${label}:exit`);
    };

    await Promise.all([
      withTaskSnapshotLock("conv-1", section("A")),
      withTaskSnapshotLock("conv-2", section("B")),
    ]);

    // Interleaved, not sequential — independent conversations must not
    // queue behind each other.
    expect(order).toEqual(["A:enter", "B:enter", "A:exit", "B:exit"]);
  });

  test("a rejection propagates to its own caller and releases the next waiter", async () => {
    const ran: string[] = [];

    const failing = withTaskSnapshotLock("conv-1", async () => {
      ran.push("first");
      throw new Error("boom");
    });
    const next = withTaskSnapshotLock("conv-1", async () => {
      ran.push("second");
      return "ok";
    });

    let caught: unknown;
    await failing.catch((err) => {
      caught = err;
    });
    expect((caught as Error).message).toBe("boom");
    expect(await next).toBe("ok");
    expect(ran).toEqual(["first", "second"]);
  });

  test("returns the critical section's value", async () => {
    expect(await withTaskSnapshotLock("conv-x", async () => 42)).toBe(42);
  });

  test("a later call after the queue drains still runs", async () => {
    await withTaskSnapshotLock("conv-drain", async () => "one");
    // Exercises the map-cleanup path: the key was deleted, so this call
    // starts a fresh chain.
    expect(await withTaskSnapshotLock("conv-drain", async () => "two")).toBe("two");
  });
});
