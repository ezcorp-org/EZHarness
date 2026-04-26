/**
 * Helper-level unit tests for `loadSnapshotAndFindTask` extracted into
 * `web/src/lib/server/task-helpers.ts`.
 *
 * Five task-lifecycle handlers (assign POST, assign DELETE, retry,
 * /assignments/[id]/start, /assignments/[id]/stop) all open with the
 * same three-step preamble: ensureTaskTrackingWired →
 * getTaskSnapshotForConversation (with empty fallback) → tasks.find.
 * The handler tests cover the 404 path indirectly via HTTP response,
 * but they don't pin:
 *   - the EXACT empty-snapshot fallback shape when the host returns
 *     undefined
 *   - that ensureTaskTrackingWired runs BEFORE the read (ordering)
 *   - that the helper still returns a usable snapshot when the task
 *     id misses (caller owns the 404 response)
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TaskSnapshot, TrackedTask } from "$server/runtime/task-tracking-host";

const ensureTaskTrackingWired = vi.fn<(...args: unknown[]) => Promise<void>>();
const getTaskSnapshotForConversation =
  vi.fn<(...args: unknown[]) => Promise<TaskSnapshot | undefined>>();
const callOrder: string[] = [];

vi.mock("$server/runtime/task-tracking-host", () => ({
  ensureTaskTrackingWired: (...args: unknown[]) => {
    callOrder.push("ensure");
    return ensureTaskTrackingWired(...args);
  },
  getTaskSnapshotForConversation: (...args: unknown[]) => {
    callOrder.push("get");
    return getTaskSnapshotForConversation(...args);
  },
  // Unused by this helper but other helpers in the same module pull it.
  writeTaskSnapshotForConversation: vi.fn(),
}));

vi.mock("$lib/server/context", () => ({
  getBus: () => ({ emit: vi.fn() }),
}));

const { loadSnapshotAndFindTask } = await import("$lib/server/task-helpers");

beforeEach(() => {
  ensureTaskTrackingWired.mockReset();
  ensureTaskTrackingWired.mockResolvedValue(undefined);
  getTaskSnapshotForConversation.mockReset();
  callOrder.length = 0;
});

function makeTask(id: string, overrides: Partial<TrackedTask> = {}): TrackedTask {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "pending",
    assignments: [],
    subtasks: [],
    priority: 0,
    createdAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("loadSnapshotAndFindTask — empty / missing snapshot", () => {
  test("snapshot undefined → returns empty fallback {conversationId, tasks: []} + task undefined", async () => {
    getTaskSnapshotForConversation.mockResolvedValueOnce(undefined);

    const result = await loadSnapshotAndFindTask("c1", "t-missing");

    expect(result.snapshot).toEqual({ conversationId: "c1", tasks: [] });
    expect(result.task).toBeUndefined();
  });

  test("task id absent in non-empty snapshot → snapshot returned, task undefined", async () => {
    const snap: TaskSnapshot = {
      conversationId: "c1",
      tasks: [makeTask("t-other")],
      activeTaskId: "t-other",
    };
    getTaskSnapshotForConversation.mockResolvedValueOnce(snap);

    const result = await loadSnapshotAndFindTask("c1", "t-missing");

    expect(result.snapshot).toBe(snap);
    expect(result.task).toBeUndefined();
  });
});

describe("loadSnapshotAndFindTask — happy path", () => {
  test("returns the matching task by id when present", async () => {
    const target = makeTask("t-target");
    const snap: TaskSnapshot = {
      conversationId: "c1",
      tasks: [makeTask("t-other"), target, makeTask("t-third")],
    };
    getTaskSnapshotForConversation.mockResolvedValueOnce(snap);

    const result = await loadSnapshotAndFindTask("c1", "t-target");

    expect(result.task).toBe(target);
    expect(result.snapshot).toBe(snap);
  });

  test("multi-task snapshot — returns the first match (Array.find ordering pinned)", async () => {
    // Should never happen (task ids are unique), but pin the iteration
    // order so a future refactor doesn't silently flip it.
    const first = makeTask("dup", { title: "first" });
    const second = makeTask("dup", { title: "second" });
    const snap: TaskSnapshot = {
      conversationId: "c1",
      tasks: [first, second],
    };
    getTaskSnapshotForConversation.mockResolvedValueOnce(snap);

    const result = await loadSnapshotAndFindTask("c1", "dup");

    expect(result.task).toBe(first);
  });

  test("subtasks present on the matched task — returned untouched (helper does not flatten)", async () => {
    // The helper finds at top-level ONLY. Callers that need subtask
    // search use `findAssignment` separately. Pin that contract.
    const target = makeTask("t-target", {
      subtasks: [
        { id: "sub-1", title: "Sub 1", completed: false, position: 0 },
        { id: "sub-2", title: "Sub 2", completed: true, position: 1 },
      ],
    });
    const snap: TaskSnapshot = {
      conversationId: "c1",
      tasks: [target],
    };
    getTaskSnapshotForConversation.mockResolvedValueOnce(snap);

    const result = await loadSnapshotAndFindTask("c1", "t-target");

    expect(result.task).toBe(target);
    expect(result.task?.subtasks).toHaveLength(2);
  });
});

describe("loadSnapshotAndFindTask — call ordering and wiring", () => {
  test("ensureTaskTrackingWired runs BEFORE the snapshot read", async () => {
    getTaskSnapshotForConversation.mockResolvedValueOnce(undefined);

    await loadSnapshotAndFindTask("c1", "t1");

    expect(callOrder).toEqual(["ensure", "get"]);
    expect(ensureTaskTrackingWired).toHaveBeenCalledWith("c1");
    expect(getTaskSnapshotForConversation).toHaveBeenCalledWith("c1");
  });

  test("propagates an error from ensureTaskTrackingWired (caller's 500 path)", async () => {
    ensureTaskTrackingWired.mockRejectedValueOnce(new Error("wire failed"));

    await expect(loadSnapshotAndFindTask("c1", "t1")).rejects.toThrow("wire failed");
    // Critical: a wiring failure must short-circuit BEFORE the snapshot read.
    expect(getTaskSnapshotForConversation).not.toHaveBeenCalled();
  });
});
