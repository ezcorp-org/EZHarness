// Unit tests for src/extensions/event-subscription-dispatcher.ts (Phase 2c).
//
// What this file locks in:
//   - `start()` is a kill-switch no-op under EZCORP_DISABLE_CAPABILITY_TOOLS=1.
//   - `registerExtension` filters non-direct-carrier event names (defense-in-depth).
//   - Direct-carrier events with a valid `conversationId` flow to the
//     subscribed extension's `sendNotification` with method
//     `ezcorp/event/<eventType>`.
//   - Conversation-scope gate — an extension subscribed to `task:snapshot`
//     but NOT wired to the event's conversation receives nothing.
//   - Multiple extensions subscribed to the same event — only the wired
//     ones are notified.
//   - Payload with no `conversationId` → dropped silently (no audit).
//   - Subprocess not running (`getProcessIfRunning → null`) → no-op.
//   - Rate limit: 60 fast events → ~50 deliveries, ~10 drops, and
//     *exactly one* `EVENT_SUBSCRIPTION_DENIED` audit row within the
//     throttle window (proves per-extension audit amplification guard).
//   - `stop()` unwires all bus listeners.
//
// Mocks: EventBus is real. Registry, subprocess, and DB accessor are
// all tiny in-memory fakes so we can run the full dispatcher code path
// without PGlite. Audit writes are captured by mocking `insertAuditEntry`.

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";

// Capture audit writes without a real DB.
const auditCalls: Array<{ action: string; target?: string; metadata?: Record<string, unknown> }> = [];
mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (
    _userId: string | null,
    action: string,
    target?: string,
    metadata?: Record<string, unknown>,
  ) => {
    auditCalls.push({ action, ...(target !== undefined ? { target } : {}), ...(metadata !== undefined ? { metadata } : {}) });
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

const { EventSubscriptionDispatcher } = await import("../extensions/event-subscription-dispatcher");

// ── Fixtures ────────────────────────────────────────────────────────

interface SendCall { method: string; params: Record<string, unknown>; }

function mockProc() {
  const calls: SendCall[] = [];
  return {
    isRunning: true,
    calls,
    sendNotification(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params: params ?? {} });
    },
  };
}

function mockRegistry(procs: Map<string, ReturnType<typeof mockProc>>) {
  return {
    getProcessIfRunning(extensionId: string) {
      const p = procs.get(extensionId);
      return p?.isRunning ? p : null;
    },
  } as any;
}

/** Stub wiring lookup — `conversationId → string[]` of wired extensionIds. */
function wireLookup(map: Record<string, string[]>): (convId: string) => Promise<string[]> {
  return async (convId: string) => map[convId] ?? [];
}

function snapshotPayload(conversationId: string | null, tasks: unknown[] = []): unknown {
  return conversationId === null
    ? { tasks, activeTaskId: undefined }
    : { conversationId, tasks, activeTaskId: undefined };
}

// ── Kill-switch ─────────────────────────────────────────────────────

describe("EventSubscriptionDispatcher — kill-switch", () => {
  let prevEnv: string | undefined;
  beforeEach(() => {
    prevEnv = process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
    auditCalls.length = 0;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
    else process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = prevEnv;
  });

  test("start() is a no-op when EZCORP_DISABLE_CAPABILITY_TOOLS=1", () => {
    process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = "1";
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-a", proc]])),
      wireLookup({ "c1": ["ext-a"] }),
    );
    dispatcher.registerExtension("ext-a", ["task:snapshot"]);
    dispatcher.start();

    bus.emit("task:snapshot", snapshotPayload("c1") as AgentEvents["task:snapshot"]);

    // Give any in-flight promises a tick.
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(proc.calls).toHaveLength(0);
      resolve();
    }, 10));
  });
});

// ── Registration filtering ──────────────────────────────────────────

describe("EventSubscriptionDispatcher — registerExtension filtering", () => {
  beforeEach(() => { auditCalls.length = 0; });

  test("non-direct-carrier event names are silently dropped at register time", () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-a", proc]])),
      wireLookup({ "c1": ["ext-a"] }),
    );
    // run:usage and agent:spawn are bus events but NOT direct-carriers —
    // the dispatcher must not wire them.
    dispatcher.registerExtension("ext-a", ["run:usage", "agent:spawn"]);
    dispatcher.start();

    bus.emit("run:usage" as never, { conversationId: "c1" } as never);
    bus.emit("agent:spawn" as never, { conversationId: "c1" } as never);

    return new Promise<void>((resolve) => setTimeout(() => {
      expect(proc.calls).toHaveLength(0);
      resolve();
    }, 10));
  });
});

// ── Happy path ──────────────────────────────────────────────────────

describe("EventSubscriptionDispatcher — delivery", () => {
  beforeEach(() => { auditCalls.length = 0; });

  test("direct-carrier event with matching conversationId → sendNotification", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-a", proc]])),
      wireLookup({ "c1": ["ext-a"] }),
    );
    dispatcher.registerExtension("ext-a", ["task:snapshot"]);
    dispatcher.start();

    bus.emit("task:snapshot", snapshotPayload("c1", [{ id: "t-1" }]) as AgentEvents["task:snapshot"]);
    await new Promise((r) => setTimeout(r, 20));

    expect(proc.calls).toHaveLength(1);
    expect(proc.calls[0]!.method).toBe("ezcorp/event/task:snapshot");
    expect((proc.calls[0]!.params as { conversationId: string }).conversationId).toBe("c1");
  });

  test("extension NOT wired to the event's conversation receives nothing", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-a", proc]])),
      // Wire ext-a to c1 only.
      wireLookup({ "c1": ["ext-a"], "c2": [] }),
    );
    dispatcher.registerExtension("ext-a", ["task:snapshot"]);
    dispatcher.start();

    // Event for c2 — ext-a is NOT wired there.
    bus.emit("task:snapshot", snapshotPayload("c2") as AgentEvents["task:snapshot"]);
    await new Promise((r) => setTimeout(r, 20));

    expect(proc.calls).toHaveLength(0);
    // Defense-in-depth drop — no audit (routing match, not rate-limit).
    expect(auditCalls).toHaveLength(0);
  });

  test("multiple extensions subscribed — only wired ones receive", async () => {
    const bus = new EventBus<AgentEvents>();
    const procA = mockProc();
    const procB = mockProc();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-a", procA], ["ext-b", procB]])),
      wireLookup({ "c1": ["ext-a"] }), // only ext-a is wired
    );
    dispatcher.registerExtension("ext-a", ["task:snapshot"]);
    dispatcher.registerExtension("ext-b", ["task:snapshot"]);
    dispatcher.start();

    bus.emit("task:snapshot", snapshotPayload("c1") as AgentEvents["task:snapshot"]);
    await new Promise((r) => setTimeout(r, 20));

    expect(procA.calls).toHaveLength(1);
    expect(procB.calls).toHaveLength(0);
  });

  test("payload without conversationId is dropped silently", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-a", proc]])),
      wireLookup({ "c1": ["ext-a"] }),
    );
    dispatcher.registerExtension("ext-a", ["task:snapshot"]);
    dispatcher.start();

    // Cast through `as never` — the live `AgentEvents["task:snapshot"]`
    // type requires conversationId; we're testing runtime tolerance to
    // a malformed payload.
    bus.emit("task:snapshot" as never, { tasks: [] } as never);
    await new Promise((r) => setTimeout(r, 20));

    expect(proc.calls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  test("subprocess not running → no-op, no audit", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    proc.isRunning = false;
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-a", proc]])),
      wireLookup({ "c1": ["ext-a"] }),
    );
    dispatcher.registerExtension("ext-a", ["task:snapshot"]);
    dispatcher.start();

    bus.emit("task:snapshot", snapshotPayload("c1") as AgentEvents["task:snapshot"]);
    await new Promise((r) => setTimeout(r, 20));

    expect(proc.calls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  test("event type with no subscribers is a no-op even if emitted on the bus", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-a", proc]])),
      wireLookup({ "c1": ["ext-a"] }),
    );
    // Subscribed to task:snapshot — NOT task:assignment_update.
    dispatcher.registerExtension("ext-a", ["task:snapshot"]);
    dispatcher.start();

    bus.emit("task:assignment_update", {
      conversationId: "c1", taskId: "t-1",
      assignment: {
        id: "a", agentConfigId: "ac", agentName: "n", isTeam: false,
        status: "assigned", assignedAt: new Date().toISOString(),
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(proc.calls).toHaveLength(0);
  });
});

// ── Rate limiting + audit throttle ──────────────────────────────────

describe("EventSubscriptionDispatcher — rate limit + audit throttle", () => {
  beforeEach(() => { auditCalls.length = 0; });

  test("60-event burst → 50 deliveries, 10 drops, exactly one audit row", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-a", proc]])),
      wireLookup({ "c1": ["ext-a"] }),
      // 1-second audit window (the default) — within that window, only
      // one EVENT_SUBSCRIPTION_DENIED row should land per extension.
      { maxOpsPerSecond: 50, overflowAuditMs: 1000 },
    );
    dispatcher.registerExtension("ext-a", ["task:snapshot"]);
    dispatcher.start();

    for (let i = 0; i < 60; i++) {
      bus.emit("task:snapshot", snapshotPayload("c1", [{ id: `t-${i}` }]) as AgentEvents["task:snapshot"]);
    }
    await new Promise((r) => setTimeout(r, 50));

    // Bucket drains; 50±1 should deliver. Over-rate drops the rest.
    expect(proc.calls.length).toBeGreaterThanOrEqual(45);
    expect(proc.calls.length).toBeLessThanOrEqual(51);
    const denials = auditCalls.filter((c) => c.action === "ext:event-subscription-denied");
    expect(denials).toHaveLength(1);
    expect(denials[0]!.metadata?.reason).toBe("rate-limited");
    expect(denials[0]!.target).toBe("ext-a");
  });

  test("audit throttle — 2 bursts across the window writes 2 audit rows", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-a", proc]])),
      wireLookup({ "c1": ["ext-a"] }),
      // Tiny audit window so the second burst lands in a fresh one.
      { maxOpsPerSecond: 50, overflowAuditMs: 30 },
    );
    dispatcher.registerExtension("ext-a", ["task:snapshot"]);
    dispatcher.start();

    // Burst 1.
    for (let i = 0; i < 60; i++) {
      bus.emit("task:snapshot", snapshotPayload("c1") as AgentEvents["task:snapshot"]);
    }
    await new Promise((r) => setTimeout(r, 60));

    // Burst 2 — fresh window; another audit row allowed.
    for (let i = 0; i < 60; i++) {
      bus.emit("task:snapshot", snapshotPayload("c1") as AgentEvents["task:snapshot"]);
    }
    await new Promise((r) => setTimeout(r, 50));

    const denials = auditCalls.filter((c) => c.action === "ext:event-subscription-denied");
    expect(denials.length).toBeGreaterThanOrEqual(2);
  });
});

// ── stop() ──────────────────────────────────────────────────────────

describe("EventSubscriptionDispatcher — lifecycle", () => {
  beforeEach(() => { auditCalls.length = 0; });

  test("stop() unwires bus listeners — post-stop events are not delivered", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-a", proc]])),
      wireLookup({ "c1": ["ext-a"] }),
    );
    dispatcher.registerExtension("ext-a", ["task:snapshot"]);
    dispatcher.start();

    bus.emit("task:snapshot", snapshotPayload("c1") as AgentEvents["task:snapshot"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(proc.calls).toHaveLength(1);

    dispatcher.stop();

    bus.emit("task:snapshot", snapshotPayload("c1") as AgentEvents["task:snapshot"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(proc.calls).toHaveLength(1); // unchanged
  });

  test("start() is idempotent — double-start does not double-wire", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-a", proc]])),
      wireLookup({ "c1": ["ext-a"] }),
    );
    dispatcher.registerExtension("ext-a", ["task:snapshot"]);
    dispatcher.start();
    dispatcher.start();

    bus.emit("task:snapshot", snapshotPayload("c1") as AgentEvents["task:snapshot"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(proc.calls).toHaveLength(1); // not 2
  });

  test("getWiredExtensions DB error → drop silently", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-a", proc]])),
      async () => { throw new Error("db is down"); },
    );
    dispatcher.registerExtension("ext-a", ["task:snapshot"]);
    dispatcher.start();

    bus.emit("task:snapshot", snapshotPayload("c1") as AgentEvents["task:snapshot"]);
    await new Promise((r) => setTimeout(r, 20));

    expect(proc.calls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });
});
