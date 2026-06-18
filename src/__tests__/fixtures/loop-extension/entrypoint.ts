#!/usr/bin/env bun
// Fixture extension for the Loop primitive real-subprocess integration
// test. Uses the REAL `@ezcorp/sdk/runtime` `defineLoop` so the test
// exercises the actual facade + Storage-backed run store through the
// JSON-RPC channel under the production sandbox-preload — not an
// in-process mock (in-process mocks lie for fs/RPC/trigger paths; project
// lesson).
//
// Three loops + one read tool:
//   - capture (event:run:complete)      → terminal "done"
//   - dispatch (event:tool:complete)    → deferred via spawn
//   - manualCapture (manual tool)       → terminal "done"
// The `list_runs` tool reads the persisted runs back so the host test can
// assert state WITHOUT racing the fire-and-forget event handler.

import {
  Storage,
  createToolDispatcher,
  defineLoop,
  getChannel,
  getLoopTools,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

const CAPTURE_STATES = { states: ["done"], terminal: ["done"] } as const;
const DEFERRED = {
  states: ["dispatched", "running", "completed", "failed", "cancelled"],
  terminal: ["completed", "failed", "cancelled"],
} as const;

// capture loop — terminal, fires on run:complete.
defineLoop({
  id: "capture",
  trigger: { kind: "event", event: "run:complete" },
  contract: { ...CAPTURE_STATES, scope: "global" },
  act: async (ctx) => {
    const cid = (ctx.input as { conversationId?: string }).conversationId ?? "none";
    return { kind: "terminal", status: "done", outcome: { cid } };
  },
});

// dispatch loop — deferred, fires on tool:complete; spawns a sub-agent.
defineLoop({
  id: "dispatch",
  trigger: { kind: "event", event: "tool:complete" },
  contract: { ...DEFERRED, scope: "global" },
  act: async (ctx) => {
    const h = await ctx.spawn({ agentName: "coder", task: "do work" });
    return {
      kind: "deferred",
      runId: h.agentRunId,
      status: "dispatched",
      awaitEvent: "task:assignment_update",
      assignmentId: h.assignmentId,
      taskId: h.taskId,
      subConversationId: h.subConversationId,
    };
  },
});

// manualCapture loop — terminal, fires from the `run_capture` tool.
defineLoop({
  id: "manualCapture",
  trigger: { kind: "manual", tool: "run_capture" },
  contract: { ...CAPTURE_STATES, scope: "global" },
  act: async (ctx) => {
    const tag = (ctx.input as { tag?: string }).tag ?? "x";
    return { kind: "terminal", status: "done", outcome: { tag } };
  },
});

// Read tool — surfaces the persisted run records for a loop so the host
// test can assert state synchronously after an async event fire.
const listRuns: ToolHandler = async (args) => {
  const loopId = (args as { loopId?: string }).loopId ?? "capture";
  const storage = new Storage("global");
  const index = await storage.get<string[]>(`loop:${loopId}:index`);
  const ids = Array.isArray(index.value) ? index.value : [];
  const runs: unknown[] = [];
  for (const id of ids) {
    const r = await storage.get(`loop:${loopId}:run:${id}`);
    if (r.exists) runs.push(r.value);
  }
  return toolResult(JSON.stringify({ loopId, runs }));
};

// Merge the loops' manual-trigger tools (run_capture) with this
// extension's own hand-written tool (list_runs) in ONE dispatcher — the
// SDK dispatcher is last-call-wins, so a single merged registration keeps
// both live.
createToolDispatcher({ ...getLoopTools(), list_runs: listRuns });
getChannel().start();
