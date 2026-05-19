/**
 * Helper-level unit tests for `findAssignment` extracted into
 * `web/src/lib/server/task-helpers.ts`.
 *
 * The handler tests
 *   api-conversations-id-tasks-assignments-start.server.test.ts
 *   api-conversations-id-tasks-assignments-stop.server.test.ts
 * cover the 404 path indirectly via the HTTP boundary, but never assert
 * the helper's behaviour for subtask-nested assignments or empty
 * subtask `.assignments` arrays. Those edges live here.
 *
 * Every test builds plain TrackedTask literals — no DB mocks, no
 * runtime imports. The helper is pure and side-effect free.
 */

import { describe, expect, test } from "vitest";
import { findAssignment } from "$lib/server/task-helpers";
import type { TaskAssignment, TrackedTask } from "$server/runtime/task-tracking-host";

function makeAssignment(id: string): TaskAssignment {
  return {
    id,
    agentConfigId: `cfg-${id}`,
    agentName: `agent-${id}`,
    isTeam: false,
    status: "assigned",
    assignedAt: "2025-01-01T00:00:00Z",
  };
}

function makeTask(opts: {
  assignments?: TaskAssignment[];
  subtaskAssignments?: (TaskAssignment[] | undefined)[];
} = {}): TrackedTask {
  return {
    id: "t1",
    title: "Task",
    description: "",
    status: "pending",
    assignments: opts.assignments ?? [],
    subtasks: (opts.subtaskAssignments ?? []).map((sa, i) => ({
      id: `sub-${i}`,
      title: `Sub ${i}`,
      completed: false,
      position: i,
      ...(sa !== undefined ? { assignments: sa } : {}),
    })),
    priority: 0,
    createdAt: "2025-01-01T00:00:00Z",
  };
}

describe("findAssignment — happy paths", () => {
  test("returns top-level assignment when id matches", () => {
    const a = makeAssignment("as1");
    const task = makeTask({ assignments: [a, makeAssignment("as2")] });
    expect(findAssignment(task, "as1")).toBe(a);
  });

  test("returns subtask assignment when id only lives nested", () => {
    const nested = makeAssignment("nested-1");
    const task = makeTask({
      assignments: [makeAssignment("top-1")],
      subtaskAssignments: [[makeAssignment("other")], [nested]],
    });
    expect(findAssignment(task, "nested-1")).toBe(nested);
  });

  test("top-level match wins over a same-id subtask match (caller-defined precedence)", () => {
    // Should never happen in practice, but the helper iterates top-level
    // FIRST — pin the ordering so a future refactor can't silently flip
    // it.
    const top = makeAssignment("dup");
    const nested = { ...makeAssignment("dup"), agentName: "agent-nested" };
    const task = makeTask({
      assignments: [top],
      subtaskAssignments: [[nested]],
    });
    expect(findAssignment(task, "dup")).toBe(top);
  });
});

describe("findAssignment — null / empty / missing branches", () => {
  test("returns undefined when id is not present anywhere", () => {
    const task = makeTask({
      assignments: [makeAssignment("as1")],
      subtaskAssignments: [[makeAssignment("as2")]],
    });
    expect(findAssignment(task, "as-missing")).toBeUndefined();
  });

  test("returns undefined when both top-level and all subtasks are empty", () => {
    const task = makeTask({});
    expect(findAssignment(task, "any")).toBeUndefined();
  });

  test("subtasks without an `assignments` array (undefined) do not crash", () => {
    // TrackedSubtask.assignments is optional — the helper uses optional
    // chaining `subtask.assignments?.find(...)` so this MUST be safe.
    const task = makeTask({
      assignments: [],
      subtaskAssignments: [undefined, [makeAssignment("found")]],
    });
    expect(findAssignment(task, "found")?.id).toBe("found");
    expect(findAssignment(task, "missing")).toBeUndefined();
  });
});
