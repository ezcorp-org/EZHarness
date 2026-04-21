#!/usr/bin/env bun
// Minimal test extension — emits a task:snapshot via the Phase 2b
// TaskEvents SDK wrapper. Used only by the emit-task-event integration
// test (src/__tests__/emit-task-event.integration.test.ts). Not bundled.

import {
  createToolDispatcher,
  getChannel,
  TaskEvents,
  toolError,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

const events = new TaskEvents();

const emit: ToolHandler = async (args) => {
  const a = args as { taskId?: unknown; conversationId?: unknown };
  if (typeof a.taskId !== "string") {
    return toolError("emit_snapshot requires string 'taskId'");
  }
  // Intentionally pass a bogus conversationId through the SDK does NOT
  // support — we forge it on a raw channel request below to prove the
  // host ignores it.
  await getChannel().request("ezcorp/emit-task-event", {
    v: 1,
    type: "snapshot",
    payload: {
      tasks: [
        {
          id: a.taskId,
          title: "integration test task",
          description: "",
          status: "pending",
          assignments: [],
          subtasks: [],
          priority: 1,
          createdAt: new Date().toISOString(),
        },
      ],
      activeTaskId: a.taskId,
    },
    // Forged field — host must ignore and stamp its own.
    ...(typeof a.conversationId === "string"
      ? { conversationId: a.conversationId }
      : {}),
  });
  // Reference `events` so the import isn't dropped during minification.
  void events;
  return toolResult(`emitted snapshot for task ${a.taskId}`);
};

export const tools: Record<string, ToolHandler> = {
  emit_snapshot: emit,
};

if (import.meta.main) {
  const ch = getChannel();
  createToolDispatcher(tools);
  ch.start();
}
