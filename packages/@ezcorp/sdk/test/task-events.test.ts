// task-events.test.ts — coverage for runtime/task-events.ts (Phase 2b).
//
// Spy getChannel().request to assert the wire shape matches the host's
// contract (`ezcorp/emit-task-event` with { v:1, type, payload }) and
// verify error propagation for -32001 / -32029 / -32602.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { TaskEvents, type TrackedTask, type TaskAssignment } from "../src/runtime/task-events";
import {
  __resetChannelForTests,
  getChannel,
  JsonRpcError,
  type HostChannel,
} from "../src/runtime/channel";

afterEach(() => {
  __resetChannelForTests();
});

interface RequestCall { method: string; params: unknown; }

function stubRequest(
  impl: (call: RequestCall) => Promise<unknown>,
): { calls: RequestCall[] } {
  const ch: HostChannel = getChannel();
  const calls: RequestCall[] = [];
  const spy = spyOn(ch, "request");
  spy.mockImplementation(
    (async (method: string, params: unknown) => {
      const call: RequestCall = { method, params };
      calls.push(call);
      return impl(call);
    }) as HostChannel["request"],
  );
  return { calls };
}

function paramsOf(call: RequestCall | undefined): Record<string, unknown> {
  return (call?.params ?? {}) as Record<string, unknown>;
}

function sampleTask(id = "t-1"): TrackedTask {
  return {
    id,
    title: "hello",
    description: "",
    status: "pending",
    assignments: [],
    subtasks: [],
    priority: 1,
    createdAt: new Date().toISOString(),
  };
}

function sampleAssignment(id = "a-1"): TaskAssignment {
  return {
    id,
    agentConfigId: "ac-1",
    agentName: "helper",
    isTeam: false,
    status: "assigned",
    assignedAt: new Date().toISOString(),
  };
}

// ── Wire format ─────────────────────────────────────────────────

describe("TaskEvents — wire format", () => {
  test("emitSnapshot sends { v:1, type:'snapshot', payload:{tasks} } to ezcorp/emit-task-event", async () => {
    const { calls } = stubRequest(async () => ({ ok: true }));
    await new TaskEvents().emitSnapshot([sampleTask()]);
    expect(calls[0]?.method).toBe("ezcorp/emit-task-event");
    const p = paramsOf(calls[0]);
    expect(p.v).toBe(1);
    expect(p.type).toBe("snapshot");
    const payload = p.payload as { tasks: unknown[]; activeTaskId?: string };
    expect(Array.isArray(payload.tasks)).toBe(true);
    expect(payload.tasks).toHaveLength(1);
    expect("activeTaskId" in payload).toBe(false);
  });

  test("emitSnapshot with activeTaskId attaches it to payload", async () => {
    const { calls } = stubRequest(async () => ({ ok: true }));
    await new TaskEvents().emitSnapshot([sampleTask()], "t-1");
    const payload = paramsOf(calls[0]).payload as { activeTaskId: string };
    expect(payload.activeTaskId).toBe("t-1");
  });

  test("emitAssignmentUpdate sends { v:1, type:'assignment_update', payload:{taskId, assignment} }", async () => {
    const { calls } = stubRequest(async () => ({ ok: true }));
    const a = sampleAssignment();
    await new TaskEvents().emitAssignmentUpdate("t-1", a);
    const p = paramsOf(calls[0]);
    expect(p.type).toBe("assignment_update");
    expect(p.payload).toEqual({ taskId: "t-1", assignment: a });
  });

  test("emitSnapshot never sends a `conversationId` field (host forces it)", async () => {
    const { calls } = stubRequest(async () => ({ ok: true }));
    await new TaskEvents().emitSnapshot([]);
    const p = paramsOf(calls[0]);
    expect("conversationId" in p).toBe(false);
    const payload = p.payload as Record<string, unknown>;
    expect("conversationId" in payload).toBe(false);
  });
});

// ── Error propagation ───────────────────────────────────────────

describe("TaskEvents — error propagation", () => {
  test("-32001 (permission / wiring) propagates as rejection", async () => {
    stubRequest(async () => {
      throw new JsonRpcError(-32001, "taskEvents permission not granted");
    });
    await expect(new TaskEvents().emitSnapshot([])).rejects.toThrow(
      /taskEvents permission/,
    );
  });

  test("-32029 (rate limited) propagates — no client retry", async () => {
    let attempts = 0;
    stubRequest(async () => {
      attempts += 1;
      throw new JsonRpcError(-32029, "Rate limited");
    });
    await expect(new TaskEvents().emitSnapshot([])).rejects.toThrow(
      /Rate limited/,
    );
    expect(attempts).toBe(1);
  });

  test("-32602 (bad payload) propagates", async () => {
    stubRequest(async () => {
      throw new JsonRpcError(-32602, "Invalid snapshot payload: payload.tasks: missing");
    });
    await expect(
      new TaskEvents().emitSnapshot([]),
    ).rejects.toThrow(/snapshot payload/);
  });
});
