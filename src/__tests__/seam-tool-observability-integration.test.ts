// Seam 8 — Tool Execution ↔ Bus Events ↔ Observability DB Persistence
//
// The integration-auditor's Seam 8 flags a concrete risk: the collector
// subscribes to `tool:complete` / `tool:error` and writes them as
// `tool_call` / `tool_error` observability rows, but nothing in the
// repository proves the full roundtrip *with a real database*. The
// existing `observability-collector.test.ts` mocks the insert; the
// existing `chat-tools-integration.test.ts` only asserts `obs:turn`.
// That leaves the exact seam Seam 8 names — "tool-specific observability
// events fire during tool execution AND persist with correct
// conversationId + tool-specific data" — untested end-to-end.
//
// This test pins the roundtrip. We wire up a real pglite DB via the same
// helpers every other integration test uses (`mockDbConnection` +
// `setupTestDb`), construct a real `ObservabilityCollector` on a real
// `EventBus`, and emit the exact event shapes the executor emits from
// `src/runtime/executor.ts:1044-1054`. Then we query the DB back through
// `getConversationObservability` / `getConversationStats` and assert:
//   1. tool:complete → a `tool_call` row with toolName, extensionId,
//      duration, success
//   2. tool:error   → a `tool_error` row with error + duration
//   3. Per-tool rows are distinct — two different tools produce two rows
//      with the correct toolName
//   4. tool:start is *not* persisted — the collector doesn't subscribe to
//      it because the signal is a transient UI hint; asserting this pins
//      the current contract so a future refactor that adds it (and
//      doubles the DB load) gets caught.
//   5. The aggregate `getConversationStats().totalToolCalls` reflects the
//      `tool_call` rows for a conversation — this is the column the
//      global stats page reads.
//
// Why not go through the HTTP / executor? The executor path is already
// covered by `chat-tools-integration.test.ts` for the *happy text* case.
// The missing coverage is tool-specific persistence. Driving the bus
// directly mirrors what the executor does at the seam and keeps the test
// focused on the collector↔DB boundary that the audit flagged.

import { test, expect, describe, beforeEach, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";

mockDbConnection();
mockRealSettings();

import { EventBus } from "../runtime/events";
import { ObservabilityCollector } from "../observability/collector";
import { createProject } from "../db/queries/projects";
import { createConversation } from "../db/queries/conversations";
import {
  getConversationObservability,
  getConversationStats,
} from "../db/queries/observability";
import type { AgentEvents } from "../types";

let projectId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({
    name: "Seam 8 Tool Obs",
    path: "/tmp/seam8-tool-obs",
  });
  projectId = project.id;
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────

async function freshConversation(title: string): Promise<string> {
  const conv = await createConversation(projectId, { title });
  return conv.id;
}

function makeCollector(bus: EventBus<AgentEvents>) {
  const collector = new ObservabilityCollector(bus);
  collector.start();
  return collector;
}

/**
 * Observability rows are inserted asynchronously — the collector's
 * listeners call insertObservabilityEvent() without awaiting it, relying
 * on a `.catch` tail. So the test has to poll rather than just yield a
 * microtask. This mirrors how the UI observes the feed in production
 * (eventual consistency, bounded latency).
 */
async function waitForEventCount(
  conversationId: string,
  expected: number,
  timeoutMs = 500,
): Promise<ReturnType<typeof getConversationObservability>> {
  const deadline = Date.now() + timeoutMs;
  let rows: Awaited<ReturnType<typeof getConversationObservability>> = [];
  while (Date.now() < deadline) {
    rows = await getConversationObservability(conversationId);
    if (rows.length >= expected) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
  return rows;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("Seam 8: tool events roundtrip through collector → observability DB", () => {
  let bus: EventBus<AgentEvents>;
  let collector: ObservabilityCollector;

  beforeEach(() => {
    bus = new EventBus<AgentEvents>();
    collector = makeCollector(bus);
  });

  test("tool:complete persists as a tool_call row with correct conversationId + tool-specific data", async () => {
    const conversationId = await freshConversation("tool:complete roundtrip");

    // Emit the exact shape executor.ts:1050 uses for a built-in tool success.
    bus.emit("tool:complete", {
      conversationId,
      extensionId: "",
      toolName: "read_file",
      output: { content: [{ type: "text", text: "file contents" }] },
      duration: 42,
      success: true,
    } as AgentEvents["tool:complete"]);

    const rows = await waitForEventCount(conversationId, 1);
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.eventType).toBe("tool_call");
    expect(row.conversationId).toBe(conversationId);
    expect(row.durationMs).toBe(42);
    // The collector projects tool-specific fields into row.data — the UI
    // reads these directly for the tool timeline / extension breakdown.
    expect((row.data as any).toolName).toBe("read_file");
    expect((row.data as any).extensionId).toBe("");
    expect((row.data as any).success).toBe(true);
    expect((row.data as any).duration).toBe(42);
    collector.stop();
  });

  test("tool:error persists as a tool_error row with error string + duration", async () => {
    const conversationId = await freshConversation("tool:error roundtrip");

    bus.emit("tool:error", {
      conversationId,
      extensionId: "",
      toolName: "edit_file",
      error: "EACCES: permission denied",
      duration: 7,
    } as AgentEvents["tool:error"]);

    const rows = await waitForEventCount(conversationId, 1);
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.eventType).toBe("tool_error");
    expect(row.conversationId).toBe(conversationId);
    expect(row.durationMs).toBe(7);
    expect((row.data as any).toolName).toBe("edit_file");
    expect((row.data as any).error).toBe("EACCES: permission denied");
    collector.stop();
  });

  test("multiple tool events in a turn produce one row per tool, preserving toolName distinction", async () => {
    // This is the "tool-specific" half of Seam 8: if the collector ever
    // regressed to bucketing tool calls under a single row or losing
    // toolName, the extension breakdown on the observability page would
    // silently collapse. Three distinct tools → three distinct rows.
    const conversationId = await freshConversation("multi-tool turn");

    bus.emit("tool:complete", {
      conversationId,
      extensionId: "",
      toolName: "read_file",
      output: { content: [] },
      duration: 11,
      success: true,
    } as AgentEvents["tool:complete"]);

    bus.emit("tool:complete", {
      conversationId,
      extensionId: "",
      toolName: "grep",
      output: { content: [] },
      duration: 22,
      success: true,
    } as AgentEvents["tool:complete"]);

    bus.emit("tool:complete", {
      conversationId,
      extensionId: "",
      toolName: "shell",
      output: { content: [] },
      duration: 33,
      success: true,
    } as AgentEvents["tool:complete"]);

    const rows = await waitForEventCount(conversationId, 3);
    expect(rows).toHaveLength(3);

    const byTool = new Map(
      rows.map((r) => [(r.data as any).toolName, r]),
    );
    expect(byTool.get("read_file")?.durationMs).toBe(11);
    expect(byTool.get("grep")?.durationMs).toBe(22);
    expect(byTool.get("shell")?.durationMs).toBe(33);

    // All three landed under the single turn's conversationId — if the
    // collector's closure accidentally shared state across handlers this
    // assertion would catch cross-conversation leaks.
    for (const r of rows) {
      expect(r.conversationId).toBe(conversationId);
      expect(r.eventType).toBe("tool_call");
    }
    collector.stop();
  });

  test("tool:complete + tool:error for the same conversation co-exist as distinct rows", async () => {
    // A mixed-outcome turn is the realistic shape: the agent runs a
    // read_file (success) then a write that fails. Both must persist, with
    // their respective eventTypes, so the observability UI can render a
    // red error card alongside the successful calls.
    const conversationId = await freshConversation("mixed outcome turn");

    bus.emit("tool:complete", {
      conversationId,
      extensionId: "",
      toolName: "read_file",
      output: { content: [] },
      duration: 5,
      success: true,
    } as AgentEvents["tool:complete"]);

    bus.emit("tool:error", {
      conversationId,
      extensionId: "",
      toolName: "write_file",
      error: "disk full",
      duration: 2,
    } as AgentEvents["tool:error"]);

    const rows = await waitForEventCount(conversationId, 2);
    expect(rows).toHaveLength(2);

    const types = rows.map((r) => r.eventType).sort();
    expect(types).toEqual(["tool_call", "tool_error"]);

    const errorRow = rows.find((r) => r.eventType === "tool_error")!;
    expect((errorRow.data as any).toolName).toBe("write_file");
    expect((errorRow.data as any).error).toBe("disk full");
    collector.stop();
  });

  test("tool:start is NOT persisted — only tool:complete / tool:error round-trip to the DB", async () => {
    // Pins the current contract: tool:start is a UI-facing "now running
    // this" signal, not a durable event. If a future refactor adds a
    // tool:start subscriber to the collector it would double the DB write
    // volume on every tool call. This test would catch that at CI time
    // so the decision is at least intentional.
    const conversationId = await freshConversation("tool:start not persisted");

    bus.emit("tool:start", {
      conversationId,
      extensionId: "",
      toolName: "read_file",
      input: { file_path: "/tmp/x.ts" },
      timestamp: Date.now(),
    } as AgentEvents["tool:start"]);

    // Give the bus a chance to write if there was a hidden subscriber.
    await new Promise((r) => setTimeout(r, 50));
    const rows = await getConversationObservability(conversationId);
    expect(rows).toHaveLength(0);
    collector.stop();
  });

  test("getConversationStats().totalToolCalls counts only tool_call rows for the conversation", async () => {
    // The `/observability/global` and per-conversation stats pages both
    // read `totalToolCalls` from this aggregate. It sums `tool_call`
    // rows (not `tool_error`) per
    // src/db/queries/observability.ts:62-66. This test pins that
    // definition so the "total tool calls" metric stays stable.
    const conversationId = await freshConversation("tool call stats");

    for (let i = 0; i < 3; i++) {
      bus.emit("tool:complete", {
        conversationId,
        extensionId: "",
        toolName: "read_file",
        output: { content: [] },
        duration: 1,
        success: true,
      } as AgentEvents["tool:complete"]);
    }
    // One error — the aggregate should NOT count this in totalToolCalls
    // (the per-conversation stats only look at eventType='tool_call').
    bus.emit("tool:error", {
      conversationId,
      extensionId: "",
      toolName: "grep",
      error: "timeout",
      duration: 1,
    } as AgentEvents["tool:error"]);

    await waitForEventCount(conversationId, 4);
    const stats = await getConversationStats(conversationId);
    expect(stats.totalToolCalls).toBe(3);
    collector.stop();
  });

  test("collector.stop() breaks the subscription — subsequent tool events are not persisted", async () => {
    // Shutdown pathway: if the collector is torn down but the bus keeps
    // emitting (e.g. a lingering executor finishing a cancelled run),
    // those events must not continue writing to the DB. Without this
    // guarantee a crash-and-restart loop could silently double-write
    // every tool call.
    const conversationId = await freshConversation("stopped collector");

    collector.stop();

    bus.emit("tool:complete", {
      conversationId,
      extensionId: "",
      toolName: "read_file",
      output: { content: [] },
      duration: 1,
      success: true,
    } as AgentEvents["tool:complete"]);

    await new Promise((r) => setTimeout(r, 50));
    const rows = await getConversationObservability(conversationId);
    expect(rows).toHaveLength(0);
  });
});
