#!/usr/bin/env bun
// Minimal test extension — exercises the Phase 2d `spawnAssignment`
// SDK wrapper and the `task:assignment_update` event-subscription
// round-trip. Used only by
// src/__tests__/spawn-assignment.integration.test.ts. Not bundled.

import {
  createToolDispatcher,
  getChannel,
  JsonRpcError,
  registerEventHandler,
  spawnAssignment,
  toolError,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

// Buffer every `task:assignment_update` the host pushes down. The
// integration test drains this via `drain_updates` to prove Phase 2c
// delivery for a Phase 2d-initiated spawn.
const updates: unknown[] = [];

registerEventHandler("task:assignment_update", (payload) => {
  updates.push(payload);
});

const spawn: ToolHandler = async (args) => {
  const a = args as {
    agentConfigId?: unknown;
    agentName?: unknown;
    task?: unknown;
    title?: unknown;
  };
  if (typeof a.task !== "string") {
    return toolError("spawn_one requires string 'task'");
  }
  try {
    const handle = await spawnAssignment({
      task: a.task,
      ...(typeof a.agentConfigId === "string" ? { agentConfigId: a.agentConfigId } : {}),
      ...(typeof a.agentName === "string" ? { agentName: a.agentName } : {}),
      ...(typeof a.title === "string" ? { title: a.title } : {}),
    });
    return toolResult(JSON.stringify(handle));
  } catch (err) {
    // The SDK channel now preserves host JSON-RPC errors as
    // JsonRpcError (code + data round-trip intact). Serialize the
    // structured shape so the integration test can branch on
    // `code` / `data.reason` without string-matching. Fall back to
    // the plain message for non-JsonRpcError failures (e.g. the
    // wrapper's synchronous validation errors).
    if (err instanceof JsonRpcError) {
      return toolError(JSON.stringify({
        code: err.code,
        message: err.message,
        data: err.data,
      }));
    }
    return toolError((err as Error).message);
  }
};

const drain: ToolHandler = async () => {
  const copy = updates.slice();
  updates.length = 0;
  return toolResult(JSON.stringify(copy));
};

export const tools: Record<string, ToolHandler> = {
  spawn_one: spawn,
  drain_updates: drain,
};

if (import.meta.main) {
  const ch = getChannel();
  createToolDispatcher(tools);
  ch.start();
}
