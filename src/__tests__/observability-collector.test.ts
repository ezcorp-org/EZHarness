import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Mock insertObservabilityEvent before any imports that use it ──────

const insertedEvents: Array<{
  conversationId: string;
  messageId?: string;
  eventType: string;
  data: Record<string, unknown>;
  durationMs?: number;
}> = [];

mock.module("../db/queries/observability", () => ({
  insertObservabilityEvent: async (data: {
    conversationId: string;
    messageId?: string;
    eventType: string;
    data: Record<string, unknown>;
    durationMs?: number;
  }) => {
    insertedEvents.push({ ...data });
    return { id: crypto.randomUUID(), ...data, createdAt: new Date() };
  },
}));

// Also stub logger to avoid DB side-effects from error persistence. Mirrors the
// real module shape (logger + extensionLogger) so a shared run can't freeze
// `../logger` to a partial shape and break a sibling importing extensionLogger.
mock.module("../logger", () => {
  const child = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => ({}),
  };
  return {
    logger: {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      child: () => child,
    },
    extensionLogger: () => child,
  };
});

import { ObservabilityCollector, startCollector } from "../observability/collector";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";

afterAll(() => {
  restoreModuleMocks();
});

// ── Helpers ──────────────────────────────────────────────────────────

function makeBus() {
  return new EventBus<AgentEvents>();
}

function clearEvents() {
  insertedEvents.length = 0;
}

const CONV_ID = "conv-test-123";
const EXT_ID = "ext-test-456";
const MSG_ID = "msg-test-789";

// ── Constructor / initialization ──────────────────────────────────────

describe("ObservabilityCollector — initialization", () => {
  beforeEach(clearEvents);

  test("can be instantiated with an EventBus", () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    expect(collector).toBeInstanceOf(ObservabilityCollector);
  });

  test("start() returns void", () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    const result = collector.start();
    expect(result).toBeUndefined();
    collector.stop();
  });

  test("stop() returns void", () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();
    const result = collector.stop();
    expect(result).toBeUndefined();
  });

  test("stop() before start() does not throw", () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    expect(() => collector.stop()).not.toThrow();
  });
});

// ── tool:complete event ───────────────────────────────────────────────

describe("ObservabilityCollector — tool:complete", () => {
  beforeEach(clearEvents);

  test("persists tool_call event on tool:complete", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("tool:complete", {
      conversationId: CONV_ID,
      extensionId: EXT_ID,
      toolName: "search",
      output: { results: [] },
      duration: 150,
      success: true,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0]!.conversationId).toBe(CONV_ID);
    expect(insertedEvents[0]!.eventType).toBe("tool_call");
    collector.stop();
  });

  test("maps toolName into persisted data", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("tool:complete", {
      conversationId: CONV_ID,
      extensionId: EXT_ID,
      toolName: "web_search",
      output: {},
      duration: 200,
      success: true,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents[0]!.data.toolName).toBe("web_search");
    collector.stop();
  });

  test("maps extensionId into persisted data", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("tool:complete", {
      conversationId: CONV_ID,
      extensionId: "my-ext",
      toolName: "run",
      output: {},
      duration: 50,
      success: false,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents[0]!.data.extensionId).toBe("my-ext");
    collector.stop();
  });

  test("maps duration into persisted data and durationMs", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("tool:complete", {
      conversationId: CONV_ID,
      extensionId: EXT_ID,
      toolName: "fetch",
      output: {},
      duration: 333,
      success: true,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents[0]!.data.duration).toBe(333);
    expect(insertedEvents[0]!.durationMs).toBe(333);
    collector.stop();
  });

  test("maps success flag into persisted data", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("tool:complete", {
      conversationId: CONV_ID,
      extensionId: EXT_ID,
      toolName: "noop",
      output: {},
      duration: 10,
      success: false,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents[0]!.data.success).toBe(false);
    collector.stop();
  });
});

// ── tool:error event ──────────────────────────────────────────────────

describe("ObservabilityCollector — tool:error", () => {
  beforeEach(clearEvents);

  test("persists tool_error event on tool:error", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("tool:error", {
      conversationId: CONV_ID,
      extensionId: EXT_ID,
      toolName: "broken",
      error: "Connection refused",
      duration: 75,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0]!.eventType).toBe("tool_error");
    collector.stop();
  });

  test("maps error message into persisted data", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("tool:error", {
      conversationId: CONV_ID,
      extensionId: EXT_ID,
      toolName: "broken",
      error: "Timeout after 5000ms",
      duration: 5000,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents[0]!.data.error).toBe("Timeout after 5000ms");
    collector.stop();
  });

  test("maps toolName and extensionId into persisted data", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("tool:error", {
      conversationId: CONV_ID,
      extensionId: "ext-xyz",
      toolName: "special_tool",
      error: "Boom",
      duration: 1,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents[0]!.data.toolName).toBe("special_tool");
    expect(insertedEvents[0]!.data.extensionId).toBe("ext-xyz");
    collector.stop();
  });

  test("maps duration into persisted data and durationMs", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("tool:error", {
      conversationId: CONV_ID,
      extensionId: EXT_ID,
      toolName: "broken",
      error: "err",
      duration: 999,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents[0]!.data.duration).toBe(999);
    expect(insertedEvents[0]!.durationMs).toBe(999);
    collector.stop();
  });
});

// ── obs:turn event ────────────────────────────────────────────────────

describe("ObservabilityCollector — obs:turn", () => {
  beforeEach(clearEvents);

  test("persists turn_summary event on obs:turn", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("obs:turn", {
      conversationId: CONV_ID,
      messageId: MSG_ID,
      llmDurationMs: 300,
      toolDurationMs: 100,
      totalDurationMs: 400,
      tokenUsage: { input: 500, output: 250 },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0]!.eventType).toBe("turn_summary");
    collector.stop();
  });

  test("maps messageId into persisted event", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("obs:turn", {
      conversationId: CONV_ID,
      messageId: MSG_ID,
      llmDurationMs: 100,
      toolDurationMs: 50,
      totalDurationMs: 150,
      tokenUsage: { input: 10, output: 20 },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents[0]!.messageId).toBe(MSG_ID);
    collector.stop();
  });

  test("maps all timing fields into persisted data", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("obs:turn", {
      conversationId: CONV_ID,
      llmDurationMs: 200,
      toolDurationMs: 80,
      totalDurationMs: 280,
      tokenUsage: { input: 100, output: 50 },
    });

    await new Promise((r) => setTimeout(r, 20));

    const d = insertedEvents[0]!.data;
    expect(d.llmDurationMs).toBe(200);
    expect(d.toolDurationMs).toBe(80);
    expect(d.totalDurationMs).toBe(280);
    collector.stop();
  });

  test("maps tokenUsage into persisted data", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("obs:turn", {
      conversationId: CONV_ID,
      llmDurationMs: 100,
      toolDurationMs: 0,
      totalDurationMs: 100,
      tokenUsage: { input: 1234, output: 567 },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect((insertedEvents[0]!.data.tokenUsage as any).input).toBe(1234);
    expect((insertedEvents[0]!.data.tokenUsage as any).output).toBe(567);
    collector.stop();
  });

  test("uses totalDurationMs as durationMs", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("obs:turn", {
      conversationId: CONV_ID,
      llmDurationMs: 100,
      toolDurationMs: 50,
      totalDurationMs: 150,
      tokenUsage: { input: 0, output: 0 },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents[0]!.durationMs).toBe(150);
    collector.stop();
  });

  test("works without messageId (optional field)", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("obs:turn", {
      conversationId: CONV_ID,
      llmDurationMs: 50,
      toolDurationMs: 10,
      totalDurationMs: 60,
      tokenUsage: { input: 5, output: 3 },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0]!.messageId).toBeUndefined();
    collector.stop();
  });
});

// ── stop() unsubscription ─────────────────────────────────────────────

describe("ObservabilityCollector — stop() cleanup", () => {
  beforeEach(clearEvents);

  test("stop() prevents further events from being persisted", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();
    collector.stop();

    bus.emit("tool:complete", {
      conversationId: CONV_ID,
      extensionId: EXT_ID,
      toolName: "noop",
      output: {},
      duration: 10,
      success: true,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents).toHaveLength(0);
  });

  test("stop() can be called multiple times without error", () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();
    expect(() => {
      collector.stop();
      collector.stop();
      collector.stop();
    }).not.toThrow();
  });

  test("after stop(), internal unsubscribers list is empty", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();
    collector.stop();

    // Emit all three event types — none should be persisted
    bus.emit("tool:complete", {
      conversationId: CONV_ID, extensionId: EXT_ID, toolName: "a",
      output: {}, duration: 1, success: true,
    });
    bus.emit("tool:error", {
      conversationId: CONV_ID, extensionId: EXT_ID, toolName: "b",
      error: "e", duration: 1,
    });
    bus.emit("obs:turn", {
      conversationId: CONV_ID, llmDurationMs: 1, toolDurationMs: 0,
      totalDurationMs: 1, tokenUsage: { input: 0, output: 0 },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents).toHaveLength(0);
  });
});

// ── startCollector convenience function ───────────────────────────────

describe("startCollector", () => {
  beforeEach(clearEvents);

  test("returns a function", () => {
    const bus = makeBus();
    const stop = startCollector(bus);
    expect(typeof stop).toBe("function");
    stop();
  });

  test("returned stop function unsubscribes all listeners", async () => {
    const bus = makeBus();
    const stop = startCollector(bus);
    stop();

    bus.emit("tool:complete", {
      conversationId: CONV_ID,
      extensionId: EXT_ID,
      toolName: "post_stop",
      output: {},
      duration: 5,
      success: true,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents).toHaveLength(0);
  });

  test("collects events before stop is called", async () => {
    const bus = makeBus();
    const stop = startCollector(bus);

    bus.emit("tool:complete", {
      conversationId: CONV_ID,
      extensionId: EXT_ID,
      toolName: "active_tool",
      output: {},
      duration: 42,
      success: true,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0]!.data.toolName).toBe("active_tool");
    stop();
  });

  test("multiple collectors on the same bus each receive events independently", async () => {
    const bus = makeBus();
    const stop1 = startCollector(bus);
    const stop2 = startCollector(bus);

    bus.emit("tool:complete", {
      conversationId: CONV_ID,
      extensionId: EXT_ID,
      toolName: "shared",
      output: {},
      duration: 10,
      success: true,
    });

    await new Promise((r) => setTimeout(r, 20));

    // Both collectors persist the event
    expect(insertedEvents).toHaveLength(2);
    stop1();
    stop2();
  });
});

// ── agent:complete event ─────────────────────────────────────────────

describe("ObservabilityCollector — agent:complete", () => {
  beforeEach(clearEvents);

  test("persists agent_call event on successful sub-agent completion", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("agent:complete", {
      runId: "parent-run-1",
      agentRunId: "child-run-1",
      subConversationId: "sub-1",
      agentName: "Code Reviewer",
      agentConfigId: "cfg-1",
      success: true,
      resultPreview: "Review complete — 3 suggestions",
      parentConversationId: CONV_ID,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents).toHaveLength(1);
    const ev = insertedEvents[0]!;
    expect(ev.conversationId).toBe(CONV_ID);
    expect(ev.eventType).toBe("agent_call");
    expect(ev.data.agentName).toBe("Code Reviewer");
    expect(ev.data.subConversationId).toBe("sub-1");
    expect(ev.data.resultPreview).toBe("Review complete — 3 suggestions");
    expect(ev.data.success).toBe(true);
    collector.stop();
  });

  test("persists agent_error event on failed sub-agent completion", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("agent:complete", {
      runId: "parent-run-2",
      agentRunId: "child-run-2",
      subConversationId: "sub-2",
      agentName: "Unit Test Writer",
      agentConfigId: "cfg-2",
      success: false,
      resultPreview: 'Agent "Unit Test Writer" timed out after 60s',
      parentConversationId: CONV_ID,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents).toHaveLength(1);
    const ev = insertedEvents[0]!;
    expect(ev.eventType).toBe("agent_error");
    expect(ev.data.agentName).toBe("Unit Test Writer");
    expect(ev.data.resultPreview).toContain("timed out");
    expect(ev.data.success).toBe(false);
    collector.stop();
  });

  test("skips persistence when parentConversationId is missing", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("agent:complete", {
      runId: "parent-run-3",
      agentRunId: "child-run-3",
      subConversationId: "sub-3",
      agentName: "Orphan",
      agentConfigId: "cfg-3",
      success: true,
      resultPreview: "",
      parentConversationId: "",
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents).toHaveLength(0);
    collector.stop();
  });
});

// ── run:error event ──────────────────────────────────────────────────

describe("ObservabilityCollector — run:error", () => {
  beforeEach(clearEvents);

  test("persists run_error event when conversationId is present", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    bus.emit("run:error", {
      run: {
        id: "run-err-1",
        agentName: "chat",
        status: "error",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        logs: [],
        result: { success: false, output: null, error: "Watchdog: no activity for 92s" },
      },
      error: "Watchdog: no activity for 92s",
      conversationId: CONV_ID,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents).toHaveLength(1);
    const ev = insertedEvents[0]!;
    expect(ev.conversationId).toBe(CONV_ID);
    expect(ev.eventType).toBe("run_error");
    expect(ev.data.runId).toBe("run-err-1");
    expect(ev.data.error).toContain("Watchdog");
    collector.stop();
  });

  test("skips persistence when conversationId is missing from payload", async () => {
    const bus = makeBus();
    const collector = new ObservabilityCollector(bus);
    collector.start();

    // Legacy code path: run:error without conversationId (e.g. from runAgent for code-based agents)
    bus.emit("run:error", {
      run: {
        id: "run-err-2",
        agentName: "chat",
        status: "error",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        logs: [],
        result: { success: false, output: null, error: "Legacy" },
      },
      error: "Legacy",
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(insertedEvents).toHaveLength(0);
    collector.stop();
  });
});
