/**
 * Integration: the host autonomous self-continuation loop
 * (`start-assignment.ts`) wired to the real `orchestration` extension's
 * `task:assignment_update` two-hop bridge.
 *
 * Proves the cross-module contract that a single unit test can't:
 *   - start-assignment re-prompts itself across cycles, emitting a
 *     NON-terminal `task:assignment_update` (status "running") each
 *     cycle and a terminal one ("completed") only when the sub-agent
 *     emits the <<TASK_DONE>> sentinel;
 *   - the orchestration extension's real `handleAssignmentUpdate`
 *     ignores the non-terminal cycle events and resolves the waiting
 *     `invoke_agent` promise ONLY on the terminal event — i.e. the
 *     parent is NOT prematurely released mid-loop.
 *
 * DB queries are mocked (no PGlite needed); the executor is faked to
 * script a run:complete sequence.
 */

import { test, expect, describe, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

mock.module("../db/queries/conversations", () => ({
  getSubConversations: async () => [],
  createSubConversation: async () => ({ id: "sub-int" }),
}));

// Master kill-switch absent ⇒ feature enabled (the behavior under test).
mock.module("../db/queries/settings", () => ({
  getSetting: async () => undefined,
}));

const { startAssignment } = await import("../runtime/start-assignment");
const { EventBus } = await import("../runtime/events");
const { _internals, _resetBindingsForTests } = await import(
  "../../docs/extensions/examples/orchestration/index"
);

import type { AgentExecutor } from "../runtime/executor";
import type { EventBus as EventBusType } from "../runtime/events";
import type { AgentEvents } from "../types";
import type {
  TaskAssignment,
  TrackedTask,
  TaskSnapshot,
} from "../runtime/task-tracking-host";

describe("autonomous continuation ↔ orchestration wait (integration)", () => {
  test("loops across cycles; parent invoke_agent resolves only on the terminal sentinel cycle", async () => {
    _internals.pendingInvocations.clear();

    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const conversationId = "conv-int";

    // Scripted sub-agent outputs: two working turns, then the sentinel.
    const outputs = [
      "made some progress",
      "more progress",
      "everything is done <<TASK_DONE>>",
    ];
    let callIdx = 0;
    const streamChatCalls: string[] = [];
    const streamChat = mock(
      async (
        _subConvId: string,
        userMessage: string,
        options: Record<string, unknown>,
      ) => {
        const idx = callIdx++;
        streamChatCalls.push(userMessage);
        const runId = options.runId as string;
        setTimeout(() => {
          bus.emit("run:complete", {
            run: {
              id: runId, agentName: "worker", status: "success",
              startedAt: Date.now(), logs: [],
              result: { success: true, output: outputs[idx] ?? "(overflow)" },
            },
            conversationId,
          } as AgentEvents["run:complete"]);
        }, 0);
        return { id: runId, agentName: "worker", status: "success", startedAt: Date.now(), logs: [] };
      },
    );
    const executor = { streamChat } as unknown as AgentExecutor;

    const assignment: TaskAssignment = {
      id: "asn-int",
      agentConfigId: "cfg-int",
      agentName: "worker",
      isTeam: false,
      status: "assigned",
      assignedAt: new Date().toISOString(),
    };
    const task: TrackedTask = {
      id: "task-int",
      title: "Do open-ended work",
      description: "until complete",
      status: "active",
      assignments: [assignment],
      subtasks: [],
      priority: 0,
      createdAt: new Date().toISOString(),
    };
    const snapshot: TaskSnapshot = {
      conversationId, tasks: [task], activeTaskId: task.id,
    };

    // Wire the REAL orchestration two-hop bridge onto the bus and
    // register a pending invocation keyed on the assignment id (what
    // spawnAssignment's handle would carry in production).
    let resolvedValue: { result: string; success: boolean } | undefined;
    let resolvedAtCall: number | undefined;
    _internals.pendingInvocations.set("asn-int", {
      resolve: (v: { result: string; success: boolean }) => {
        resolvedValue = v;
        resolvedAtCall = streamChatCalls.length;
      },
      reject: (e: Error) => { throw e; },
      timeoutHandle: setTimeout(() => {}, 0),
      agentName: "worker",
      agentConfigId: "cfg-int",
      subConversationId: "sub-int",
    });
    bus.on("task:assignment_update", (payload) => {
      void _internals.handleAssignmentUpdate(
        payload as unknown as {
          conversationId: string;
          taskId: string;
          assignment: { id: string; status: string; resultPreview?: string };
          resultFull?: string;
        },
      );
    });

    await startAssignment({
      executor,
      bus,
      conversationId,
      taskId: task.id,
      assignment,
      task,
      snapshot,
      projectId: "proj-int",
      agentConfig: { id: "cfg-int", name: "worker", prompt: "you are a worker" },
      autonomousContinuation: { maxCycles: 5 },
    });

    // Drive the scripted run:complete chain to completion.
    for (let i = 0; i < 100 && resolvedValue === undefined; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Looped exactly to the sentinel: initial + 2 continuations = 3 runs.
    expect(streamChatCalls).toHaveLength(3);
    expect(streamChatCalls[1]).toMatch(/Continue working toward the Pinned Objective/);
    expect(streamChatCalls[2]).toMatch(/Continue working toward the Pinned Objective/);

    // Parent released ONLY on the terminal (3rd) cycle — never mid-loop.
    expect(resolvedAtCall).toBe(3);
    // Wave 1: the orchestrator receives the FULL result (from the
    // event's resultFull), not the 200-char preview.
    expect(resolvedValue).toEqual({
      result: "everything is done",
      success: true,
    });
    expect(assignment.status).toBe("completed");
    expect(assignment.resultPreview).toBe("everything is done");

    _internals.pendingInvocations.clear();
    _resetBindingsForTests();
  });
});
