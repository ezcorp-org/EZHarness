/**
 * Phase 51.4 coverage — `EventSubscriptionDispatcher` payload
 * allowlist + sampled audit.
 *
 *   - tool:complete WITHOUT includeFullPayload strips `output`.
 *   - tool:complete WITH includeFullPayload retains `output`.
 *   - Sampled audit fires reproducibly (sampleN=1 → every event
 *     audited; default 100 → not every event).
 */
import { test, expect, describe, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
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

afterAll(() => {
  // Restore the real `audit-log` module so subsequent test files
  // (e.g. schedule-daemon.test.ts) see actual DB writes, not the
  // in-memory `auditCalls` capture above. Without this, Bun's
  // mock.module pollutes across files.
  restoreModuleMocks();
});

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

  test("tool:start strips `input` by default (symmetric with tool:complete)", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const d = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-ts", proc]])),
      wireLookup({ "c1": ["ext-ts"] }),
    );
    d.registerExtension("ext-ts", ["tool:start"]);
    d.start();
    bus.emit("tool:start", {
      conversationId: "c1",
      extensionId: "ext-ts",
      toolName: "do-thing",
      input: { secret: "shh" },
    } as unknown as AgentEvents["tool:start"]);
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(proc.calls.length).toBe(1);
    expect(proc.calls[0]!.params.input).toBeUndefined();
    expect(proc.calls[0]!.params.toolName).toBe("do-thing");
    d.stop();
  });

  test("tool:start WITH includeFullPayload retains `input`", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const d = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-ts2", proc]])),
      wireLookup({ "c1": ["ext-ts2"] }),
    );
    d.registerExtension("ext-ts2", ["tool:start"]);
    d.setIncludeFullPayload("ext-ts2", true);
    d.start();
    bus.emit("tool:start", {
      conversationId: "c1",
      extensionId: "ext-ts2",
      toolName: "do-thing",
      input: { kept: true },
    } as unknown as AgentEvents["tool:start"]);
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(proc.calls[0]!.params.input).toEqual({ kept: true });
    d.stop();
  });

  test("tool:permission_request strips `input` by default", async () => {
    // The gate card's `input` is the LLM's raw arguments for a call that has
    // NOT RUN YET — the shell command, the file write, or (for a caller tool)
    // the arguments for something about to execute on the user's own machine.
    // `caller:tool-call` and `ez:client-tool` were moved out of the
    // extension-subscribable set for exactly that payload; this event carries
    // the same arguments a moment earlier and IS subscribable, so the strip is
    // what stops the front door handing over what the side door denies.
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const d = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-pr", proc]])),
      wireLookup({ "c1": ["ext-pr"] }),
    );
    d.registerExtension("ext-pr", ["tool:permission_request"]);
    d.start();
    bus.emit("tool:permission_request", {
      conversationId: "c1",
      toolCallId: "tc-1",
      toolName: "_caller__open_app",
      input: { app: "Keychain Access", path: "/Users/me/.ssh/id_ed25519" },
      category: "caller",
    } as unknown as AgentEvents["tool:permission_request"]);
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(proc.calls.length).toBe(1);
    expect(proc.calls[0]!.params.input).toBeUndefined();
    // Everything an extension legitimately needs to render or correlate the
    // card survives — only the arguments go.
    expect(proc.calls[0]!.params.toolName).toBe("_caller__open_app");
    expect(proc.calls[0]!.params.toolCallId).toBe("tc-1");
    expect(proc.calls[0]!.params.category).toBe("caller");
    d.stop();
  });

  test("tool:permission_request WITH includeFullPayload retains `input`", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const d = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-pr2", proc]])),
      wireLookup({ "c1": ["ext-pr2"] }),
    );
    d.registerExtension("ext-pr2", ["tool:permission_request"]);
    d.setIncludeFullPayload("ext-pr2", true);
    d.start();
    bus.emit("tool:permission_request", {
      conversationId: "c1",
      toolCallId: "tc-2",
      toolName: "shell",
      input: { cmd: "ls" },
    } as unknown as AgentEvents["tool:permission_request"]);
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(proc.calls[0]!.params.input).toEqual({ cmd: "ls" });
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
