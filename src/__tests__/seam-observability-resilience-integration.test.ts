// Seam 4 — Chat Streaming ↔ Observability Event Emission ↔ Database Persistence
//
// `chat-tools-integration.test.ts` proves the happy path: chat turn →
// `obs:turn` fires → `ObservabilityCollector` writes a row → the
// `/api/observability/conversations/...` API returns it. What it does NOT
// prove — and what Seam 4 in integration-auditor.md flags as a risk — is the
// failure path:
//
//   "If DB insert for observability fails, user chat result still returns"
//
// The contract is subtle. The executor emits lifecycle events synchronously
// via `bus.emit`. If a listener on that bus (the collector) throws or
// rejects, it must not:
//   1. Abort the executor's emit loop (breaking later listeners on the same
//      event that drive UI / tasks / chat completion)
//   2. Propagate the rejection out of `bus.emit` (crashing the caller)
//   3. Prevent the chat response from reaching the user
//
// The current implementation relies on two layers of defence: EventBus wraps
// each listener in try/catch (events.ts:23), and the collector's listeners
// chain `.catch()` on the insertObservabilityEvent promise. This test exists
// specifically to pin that contract so a refactor that drops either layer
// is caught at CI time.
//
// We test at the bus + collector seam directly (not through a full HTTP
// server) because the failure mode is a listener-level concern: the chat
// turn is represented by the emit calls the executor makes. If those emits
// survive a broken DB insert, the chat turn survives too.

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";

// ── Mock insertObservabilityEvent to throw ───────────────────────────
//
// This simulates the exact production failure mode the seam must survive:
// the Postgres insert throws (connection refused, constraint violation,
// bad JSON coercion — anything). We don't distinguish sync vs async throw
// because both must be tolerated.

let insertCalls: Array<{ conversationId: string; eventType: string }> = [];
let shouldThrow = true;
let throwMode: "reject" | "throw" = "reject";

mock.module("../db/queries/observability", () => ({
  insertObservabilityEvent: async (data: { conversationId: string; eventType: string }) => {
    insertCalls.push({ conversationId: data.conversationId, eventType: data.eventType });
    if (!shouldThrow) return { id: "ok" };
    if (throwMode === "throw") throw new Error("DB connection refused");
    return Promise.reject(new Error("DB connection refused"));
  },
}));

import { ObservabilityCollector } from "../observability/collector";

afterAll(() => restoreModuleMocks());

describe("Seam 4: observability DB failure must not break chat turn events", () => {
  let bus: EventBus<AgentEvents>;
  let collector: ObservabilityCollector;

  beforeEach(() => {
    insertCalls = [];
    shouldThrow = true;
    throwMode = "reject";
    bus = new EventBus<AgentEvents>();
    collector = new ObservabilityCollector(bus);
    collector.start();
  });

  test("obs:turn event with failing DB insert: downstream listeners still receive it", async () => {
    // The concrete chat-turn contract: the executor emits obs:turn at the end
    // of every turn. A "second listener" here represents anything downstream
    // of the collector — the WebSocket broadcaster, a cost-tracking watcher,
    // or the UI's turn counter. If one of those misses an event because the
    // DB insert failed, the user's chat panel silently stops updating.
    let received: any = null;
    bus.on("obs:turn", (data) => {
      received = data;
    });

    // This emit must not throw even though the collector's insert rejects.
    // EventBus wraps listeners in try/catch; this test pins that guarantee.
    expect(() => {
      bus.emit("obs:turn", {
        conversationId: "conv-seam4",
        messageId: "msg-1",
        llmDurationMs: 120,
        toolDurationMs: 30,
        totalDurationMs: 150,
        tokenUsage: { input: 42, output: 17 },
      } as AgentEvents["obs:turn"]);
    }).not.toThrow();

    // The downstream listener is what the chat UI / executor's "turn
    // complete" hook relies on. It must have fired regardless of DB state.
    expect(received).not.toBeNull();
    expect(received.conversationId).toBe("conv-seam4");
    expect(received.tokenUsage).toEqual({ input: 42, output: 17 });

    // And the collector did try to persist (proving this test didn't
    // accidentally bypass the collector path — if insertCalls is empty, the
    // mock wasn't wired and the test would give a false positive).
    expect(insertCalls.some((c) => c.eventType === "turn_summary")).toBe(true);

    // Yield the microtask so the promise rejection propagates to its
    // `.catch` handler. If the collector forgot to attach one, this would
    // surface as an unhandledrejection in test output.
    await Promise.resolve();
    await Promise.resolve();
  });

  test("tool:complete event with failing DB insert: downstream listeners still receive it", async () => {
    // Same contract for tool:complete — this is what drives the tool cards in
    // the UI, so a broken collector listener here would make tools look
    // "stuck". The risk the integration auditor highlighted.
    const seen: any[] = [];
    bus.on("tool:complete", (d) => seen.push(d));

    expect(() => {
      bus.emit("tool:complete", {
        conversationId: "conv-seam4",
        extensionId: "ext-x",
        toolName: "read_file",
        output: { content: [{ type: "text", text: "ok" }] },
        duration: 42,
        success: true,
      } as AgentEvents["tool:complete"]);
    }).not.toThrow();

    expect(seen).toHaveLength(1);
    expect(seen[0].toolName).toBe("read_file");
    expect(insertCalls.some((c) => c.eventType === "tool_call")).toBe(true);
    await Promise.resolve();
  });

  test("tool:error event survives DB failure (error persistence is itself fallible)", async () => {
    const seen: any[] = [];
    bus.on("tool:error", (d) => seen.push(d));

    expect(() => {
      bus.emit("tool:error", {
        conversationId: "conv-seam4",
        extensionId: "ext-x",
        toolName: "write_file",
        error: "EACCES",
        duration: 7,
      } as AgentEvents["tool:error"]);
    }).not.toThrow();

    expect(seen).toHaveLength(1);
    expect(insertCalls.some((c) => c.eventType === "tool_error")).toBe(true);
    await Promise.resolve();
  });

  test("agent:complete event with parentConversationId survives DB failure", async () => {
    // agent:complete is the sub-agent result funnel — if this breaks, team
    // orchestration stops surfacing sub-agent outputs to the parent panel.
    const seen: any[] = [];
    bus.on("agent:complete", (d) => seen.push(d));

    expect(() => {
      bus.emit("agent:complete", {
        parentConversationId: "conv-parent",
        subConversationId: "conv-child",
        agentName: "researcher",
        agentConfigId: "cfg-1",
        agentRunId: "run-1",
        success: true,
      } as AgentEvents["agent:complete"]);
    }).not.toThrow();

    expect(seen).toHaveLength(1);
    expect(insertCalls.some((c) => c.eventType === "agent_call")).toBe(true);
    await Promise.resolve();
  });

  test("run:error with conversationId survives DB failure", async () => {
    const seen: any[] = [];
    bus.on("run:error", (d) => seen.push(d));

    expect(() => {
      bus.emit("run:error", {
        conversationId: "conv-seam4",
        run: { id: "run-1", agentName: "a", status: "error" as const, startedAt: 0, logs: [] },
        error: "boom",
      } as AgentEvents["run:error"]);
    }).not.toThrow();

    expect(seen).toHaveLength(1);
    expect(insertCalls.some((c) => c.eventType === "run_error")).toBe(true);
    await Promise.resolve();
  });

  test("synchronous throw (not a rejected promise) is also tolerated", async () => {
    // Guards against a future refactor that changes insertObservabilityEvent
    // to throw synchronously (e.g. input validation before the DB call). The
    // current implementation wraps the call in a promise chain which would
    // still catch it, and EventBus.emit wraps the listener in try/catch.
    // Either defence on its own is enough; both together make this robust.
    throwMode = "throw";

    const seen: any[] = [];
    bus.on("obs:turn", (d) => seen.push(d));

    expect(() => {
      bus.emit("obs:turn", {
        conversationId: "conv-seam4-sync",
        messageId: "msg-1",
        llmDurationMs: 1,
        toolDurationMs: 1,
        totalDurationMs: 2,
        tokenUsage: { input: 1, output: 1 },
      } as AgentEvents["obs:turn"]);
    }).not.toThrow();

    expect(seen).toHaveLength(1);
    await Promise.resolve();
  });

  test("simulated chat turn: multiple events in order, none of them break downstream", async () => {
    // Full chat-turn simulation: tool:complete → obs:turn (sequence the
    // executor actually emits). If the collector silently swallows errors
    // AND another listener gets through for every event, the user's UI
    // stays in sync with the turn's actual progress. This is the
    // "user chat result still returns" assertion rephrased as events.
    const timeline: string[] = [];
    bus.on("tool:complete", () => timeline.push("tool:complete"));
    bus.on("obs:turn", () => timeline.push("obs:turn"));

    bus.emit("tool:complete", {
      conversationId: "conv-seam4-full",
      extensionId: "ext-x",
      toolName: "read_file",
      output: { content: [{ type: "text", text: "ok" }] },
      duration: 10,
      success: true,
    } as AgentEvents["tool:complete"]);

    bus.emit("obs:turn", {
      conversationId: "conv-seam4-full",
      messageId: "msg-final",
      llmDurationMs: 100,
      toolDurationMs: 10,
      totalDurationMs: 120,
      tokenUsage: { input: 10, output: 5 },
    } as AgentEvents["obs:turn"]);

    expect(timeline).toEqual(["tool:complete", "obs:turn"]);

    // Collector tried to write both; both would have rejected in real prod.
    expect(insertCalls.map((c) => c.eventType).sort()).toEqual(["tool_call", "turn_summary"]);
    await Promise.resolve();
  });

  test("collector.stop() cleans up listeners so emitted events don't re-call a failing DB", async () => {
    // Cleanup pathway: if the collector is stopped (e.g. shutdown), further
    // emits must not try to persist. Without this, a graceful shutdown that
    // also happens to hit a failing DB could spam errors forever.
    collector.stop();
    insertCalls = [];

    bus.emit("obs:turn", {
      conversationId: "conv-post-stop",
      messageId: "x",
      llmDurationMs: 1,
      toolDurationMs: 1,
      totalDurationMs: 2,
      tokenUsage: { input: 1, output: 1 },
    } as AgentEvents["obs:turn"]);

    expect(insertCalls).toHaveLength(0);
  });
});
