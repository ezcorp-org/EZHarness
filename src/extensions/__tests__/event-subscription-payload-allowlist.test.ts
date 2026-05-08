/**
 * Phase 51.4 coverage — `EventSubscriptionDispatcher` payload
 * allowlist + sampled audit.
 *
 *   - tool:complete WITHOUT includeFullPayload strips `output`.
 *   - tool:complete WITH includeFullPayload retains `output`.
 *   - Sampled audit fires reproducibly (sampleN=1 → every event
 *     audited; default 100 → not every event).
 */
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { EventBus } from "../../runtime/events";
import type { AgentEvents } from "../../types";

const auditCalls: Array<{ action: string; target?: string; metadata?: Record<string, unknown> }> = [];
mock.module("../../db/queries/audit-log", () => ({
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

const { EventSubscriptionDispatcher } = await import("../event-subscription-dispatcher");

interface SendCall { method: string; params: Record<string, unknown> }

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

function wireLookup(map: Record<string, string[]>): (convId: string) => Promise<string[]> {
  return async (convId: string) => map[convId] ?? [];
}

beforeEach(() => { auditCalls.length = 0; });
afterEach(() => { auditCalls.length = 0; });

describe("payload allowlist", () => {
  test("tool:complete strips `output` by default", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const d = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-a", proc]])),
      wireLookup({ "c1": ["ext-a"] }),
    );
    d.registerExtension("ext-a", ["tool:complete"]);
    d.start();
    bus.emit("tool:complete", {
      conversationId: "c1",
      extensionId: "ext-a",
      toolName: "echo",
      input: { secret: "s" },
      output: { result: "huge-blob-here" },
      success: true,
      durationMs: 1,
    } as unknown as AgentEvents["tool:complete"]);
    // Allow async dispatch to complete.
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(proc.calls.length).toBe(1);
    expect(proc.calls[0]!.params.output).toBeUndefined();
    expect(proc.calls[0]!.params.input).toBeUndefined();
    expect(proc.calls[0]!.params.toolName).toBe("echo");
    expect(proc.calls[0]!.params.success).toBe(true);
    d.stop();
  });

  test("tool:complete WITH includeFullPayload retains `output`", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const d = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-b", proc]])),
      wireLookup({ "c1": ["ext-b"] }),
    );
    d.registerExtension("ext-b", ["tool:complete"]);
    d.setIncludeFullPayload("ext-b", true);
    d.start();
    bus.emit("tool:complete", {
      conversationId: "c1",
      extensionId: "ext-b",
      toolName: "echo",
      input: { x: 1 },
      output: { result: "kept" },
      success: true,
      durationMs: 1,
    } as unknown as AgentEvents["tool:complete"]);
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(proc.calls[0]!.params.output).toEqual({ result: "kept" });
    expect(proc.calls[0]!.params.input).toEqual({ x: 1 });
    d.stop();
  });

  test("non-heavy events (run:complete) pass through unchanged", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const d = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-c", proc]])),
      wireLookup({ "c1": ["ext-c"] }),
    );
    d.registerExtension("ext-c", ["run:complete"]);
    d.start();
    bus.emit("run:complete", {
      conversationId: "c1",
      runId: "r1",
      finalContent: "hello",
    } as unknown as AgentEvents["run:complete"]);
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(proc.calls[0]!.params.finalContent).toBe("hello");
    d.stop();
  });
});

describe("sampled audit", () => {
  test("sampleN=1 → every delivery audited (test-mode)", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const d = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-s", proc]])),
      wireLookup({ "c1": ["ext-s"] }),
    );
    d.registerExtension("ext-s", ["run:complete"]);
    d.setAuditSampleN(1);
    d.start();
    for (let i = 0; i < 3; i++) {
      bus.emit("run:complete", { conversationId: "c1", runId: `r${i}`, finalContent: "" } as any);
    }
    await new Promise<void>((r) => setTimeout(r, 30));
    const delivered = auditCalls.filter((c) => c.action === "ext:sdk-event-delivered");
    expect(delivered.length).toBe(3);
    expect(delivered[0]!.target).toBe("ext-s");
    d.stop();
  });

  test("sampleN=10000 → almost no delivery audited", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const d = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-x", proc]])),
      wireLookup({ "c1": ["ext-x"] }),
    );
    d.registerExtension("ext-x", ["run:complete"]);
    d.setAuditSampleN(10000);
    d.start();
    for (let i = 0; i < 5; i++) {
      bus.emit("run:complete", { conversationId: "c1", runId: `r${i}`, finalContent: "" } as any);
    }
    await new Promise<void>((r) => setTimeout(r, 30));
    const delivered = auditCalls.filter((c) => c.action === "ext:sdk-event-delivered");
    // Expected to be 0 with overwhelming probability — the 5 random
    // hashes mod 10_000 give a 99.95%+ chance of zero hits.
    expect(delivered.length).toBeLessThanOrEqual(1);
    d.stop();
  });
});
