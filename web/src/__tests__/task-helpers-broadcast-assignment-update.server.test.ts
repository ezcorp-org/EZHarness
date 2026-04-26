/**
 * Helper-level unit tests for `broadcastAssignmentUpdate` extracted into
 * `web/src/lib/server/task-helpers.ts`.
 *
 * The handler tests for the assign POST, retry, and stop routes already
 * verify that a `task:assignment_update` event makes it onto the bus,
 * but they don't pin the EXACT payload shape (the `{ conversationId,
 * taskId, assignment }` literal). That literal lived inline in three
 * places before the refactor; pinning the shape here means a future
 * change to the helper that drops a field, renames the event, or
 * reorders the payload surfaces in a unit test rather than via SSE
 * regression.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TaskAssignment } from "$server/runtime/task-tracking-host";

const emit = vi.fn<(...args: unknown[]) => void>();

vi.mock("$lib/server/context", () => ({
  getBus: () => ({ emit: (...args: unknown[]) => emit(...args) }),
}));

const { broadcastAssignmentUpdate } = await import("$lib/server/task-helpers");

beforeEach(() => {
  emit.mockReset();
});

function makeAssignment(overrides: Partial<TaskAssignment> = {}): TaskAssignment {
  return {
    id: "as1",
    agentConfigId: "cfg-1",
    agentName: "agent-1",
    isTeam: false,
    status: "assigned",
    assignedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("broadcastAssignmentUpdate — event name and payload shape", () => {
  test("emits 'task:assignment_update' with the canonical 3-field payload", () => {
    const assignment = makeAssignment();
    broadcastAssignmentUpdate("c1", "t1", assignment);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("task:assignment_update", {
      conversationId: "c1",
      taskId: "t1",
      assignment,
    });
  });

  test("preserves assignment object identity (no clone) so callers can chain mutations", () => {
    // The helper passes the assignment reference through verbatim — pin
    // it so a future "defensive clone" change is an explicit decision,
    // not an accidental break of the retry handler's reset-loop pattern.
    const assignment = makeAssignment({ id: "as-ref" });
    broadcastAssignmentUpdate("c1", "t1", assignment);

    const payload = emit.mock.calls[0]?.[1] as { assignment: TaskAssignment } | undefined;
    expect(payload?.assignment).toBe(assignment);
  });

  test("preserves all assignment fields including optional ones (subConversationId, agentRunId, resultPreview)", () => {
    // Assign POST adds an `assignedAt` timestamp; retry resets to "assigned"
    // and strips startedAt/completedAt; stop sets `failedAt`. The helper
    // must not filter — every consumer downstream relies on the full shape.
    const rich: TaskAssignment = {
      id: "as-rich",
      agentConfigId: "cfg-rich",
      agentName: "agent-rich",
      isTeam: true,
      status: "running",
      assignedAt: "2025-01-01T00:00:00Z",
      startedAt: "2025-01-01T00:00:01Z",
      subConversationId: "sub-conv-1",
      agentRunId: "run-1",
      resultPreview: "preview",
    };
    broadcastAssignmentUpdate("c1", "t1", rich);

    expect(emit).toHaveBeenCalledWith("task:assignment_update", {
      conversationId: "c1",
      taskId: "t1",
      assignment: rich,
    });
  });
});

describe("broadcastAssignmentUpdate — fan-out usage", () => {
  test("emits once per call (retry's reset-loop fans out N times)", () => {
    // Retry calls this once per failed assignment it resets — ensure
    // the helper itself doesn't deduplicate or batch.
    const a1 = makeAssignment({ id: "as-1" });
    const a2 = makeAssignment({ id: "as-2" });
    const a3 = makeAssignment({ id: "as-3" });

    broadcastAssignmentUpdate("c1", "t1", a1);
    broadcastAssignmentUpdate("c1", "t1", a2);
    broadcastAssignmentUpdate("c1", "t1", a3);

    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenNthCalledWith(1, "task:assignment_update", {
      conversationId: "c1",
      taskId: "t1",
      assignment: a1,
    });
    expect(emit).toHaveBeenNthCalledWith(2, "task:assignment_update", {
      conversationId: "c1",
      taskId: "t1",
      assignment: a2,
    });
    expect(emit).toHaveBeenNthCalledWith(3, "task:assignment_update", {
      conversationId: "c1",
      taskId: "t1",
      assignment: a3,
    });
  });
});
