import { test, expect, describe, beforeEach } from "bun:test";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import {
  LifecycleHookDispatcher,
} from "../extensions/lifecycle-dispatcher";

// ── Helpers ─────────────────────────────────────────────────────────

/** Guard helper: narrow `T | undefined` from array-index access to `T`.
 *  Throws (rather than non-null asserting) so that an unexpected empty
 *  `proc.calls` surfaces as a descriptive failure. */
function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

/** Minimal mock ExtensionProcess — only sendNotification matters */
function mockProc() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    isRunning: true,
    calls,
    sendNotification(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params: params ?? {} });
    },
  };
}

/** Minimal mock ExtensionRegistry with getProcessIfRunning */
function mockRegistry(procs: Map<string, ReturnType<typeof mockProc>>) {
  return {
    getProcessIfRunning(extensionId: string) {
      const p = procs.get(extensionId);
      return p?.isRunning ? p : null;
    },
  } as any;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("LifecycleHookDispatcher", () => {
  let bus: EventBus<AgentEvents>;

  beforeEach(() => {
    bus = new EventBus<AgentEvents>();
  });

  test("dispatches sanitized payload when subscribed hook fires", () => {
    const proc = mockProc();
    const registry = mockRegistry(new Map([["ext-a", proc]]));
    const dispatcher = new LifecycleHookDispatcher(bus, registry);

    dispatcher.registerExtension("ext-a", ["agent:spawn"]);
    dispatcher.start();

    bus.emit("agent:spawn", {
      runId: "r1",
      agentRunId: "ar1",
      subConversationId: "sc1",
      agentName: "coder",
      agentConfigId: "cfg1",
      task: "build a thing",
      parentConversationId: "pc1",
    });

    expect(proc.calls).toHaveLength(1);
    const call0 = at(proc.calls, 0, "proc.calls");
    expect(call0.method).toBe("lifecycle/agent:spawn");
    expect(call0.params).toHaveProperty("agentName", "coder");
    expect(call0.params).toHaveProperty("agentConfigId", "cfg1");
    expect(call0.params).toHaveProperty("runId", "r1");
    expect(call0.params).toHaveProperty("timestamp");
  });

  test("multiple extensions subscribed to same hook all receive notification", () => {
    const procA = mockProc();
    const procB = mockProc();
    const registry = mockRegistry(new Map([["ext-a", procA], ["ext-b", procB]]));
    const dispatcher = new LifecycleHookDispatcher(bus, registry);

    dispatcher.registerExtension("ext-a", ["run:start"]);
    dispatcher.registerExtension("ext-b", ["run:start"]);
    dispatcher.start();

    bus.emit("run:start", { run: { id: "r1", agentName: "test" } } as any);

    expect(procA.calls).toHaveLength(1);
    expect(procB.calls).toHaveLength(1);
    expect(at(procA.calls, 0, "procA.calls").method).toBe("lifecycle/run:start");
    expect(at(procB.calls, 0, "procB.calls").method).toBe("lifecycle/run:start");
  });

  test("extension NOT subscribed to a hook doesn't receive it", () => {
    const proc = mockProc();
    const registry = mockRegistry(new Map([["ext-a", proc]]));
    const dispatcher = new LifecycleHookDispatcher(bus, registry);

    dispatcher.registerExtension("ext-a", ["agent:spawn"]);
    dispatcher.start();

    bus.emit("run:complete", { run: { id: "r1", agentName: "x", status: "success" } } as any);

    expect(proc.calls).toHaveLength(0);
  });

  test("unknown hook names in registerExtension are ignored", () => {
    const proc = mockProc();
    const registry = mockRegistry(new Map([["ext-a", proc]]));
    const dispatcher = new LifecycleHookDispatcher(bus, registry);

    // "tool:start" is not in ALLOWED_LIFECYCLE_HOOKS
    dispatcher.registerExtension("ext-a", ["tool:start" as any, "agent:spawn"]);
    dispatcher.start();

    bus.emit("agent:spawn", {
      runId: "r1",
      agentRunId: "ar1",
      subConversationId: "sc1",
      agentName: "coder",
      agentConfigId: "cfg1",
      task: "x",
      parentConversationId: "pc1",
    });

    // Should still receive agent:spawn
    expect(proc.calls).toHaveLength(1);
  });

  test("sanitized payload only contains allowlisted fields (no extras)", () => {
    const proc = mockProc();
    const registry = mockRegistry(new Map([["ext-a", proc]]));
    const dispatcher = new LifecycleHookDispatcher(bus, registry);

    dispatcher.registerExtension("ext-a", ["agent:spawn"]);
    dispatcher.start();

    bus.emit("agent:spawn", {
      runId: "r1",
      agentRunId: "ar1",
      subConversationId: "sc1",
      agentName: "coder",
      agentConfigId: "cfg1",
      task: "secret task content",
      parentConversationId: "pc1",
    });

    const payload = at(proc.calls, 0, "proc.calls").params;
    // Sanitized DATA fields are exactly the allowlist. `_meta` is host-added
    // provenance (an opaque ownerless ezCallId), not sanitizer output — assert
    // it separately so the no-secret-leak guarantee on data fields stays exact.
    const keys = Object.keys(payload).filter((k) => k !== "_meta");
    expect(keys.sort()).toEqual(["agentConfigId", "agentName", "runId", "timestamp"]);
    expect(typeof (payload._meta as { ezCallId?: string } | undefined)?.ezCallId).toBe("string");
  });

  test("stamping ezCallId MERGES into a pre-existing _meta rather than clobbering it", () => {
    const proc = mockProc();
    const registry = mockRegistry(new Map([["ext-a", proc]]));
    const dispatcher = new LifecycleHookDispatcher(bus, registry);
    // Drive the private notification path with params that ALREADY carry `_meta`
    // (a future sanitizer / caller may). The stamp must ADD ezCallId, not drop
    // the prior fields — defensive merge (#nit).
    (dispatcher as unknown as {
      sendNotification(id: string, hook: string, params: Record<string, unknown>): void;
    }).sendNotification("ext-a", "agent:spawn", { runId: "r1", _meta: { correlationId: "keep-me" } });

    const meta = at(proc.calls, 0, "proc.calls").params._meta as { ezCallId?: string; correlationId?: string };
    expect(meta.correlationId).toBe("keep-me"); // prior field preserved
    expect(typeof meta.ezCallId).toBe("string"); // ezCallId added
  });

  test("does not start sleeping processes (uses getProcessIfRunning)", () => {
    let getProcessCalled = false;
    const registry = {
      getProcessIfRunning(_extId: string) {
        getProcessCalled = true;
        return null; // process not running
      },
      // getProcess should NEVER be called
      getProcess() {
        throw new Error("getProcess should NOT be called by dispatcher");
      },
    } as any;

    const dispatcher = new LifecycleHookDispatcher(bus, registry);
    dispatcher.registerExtension("ext-a", ["agent:spawn"]);
    dispatcher.start();

    bus.emit("agent:spawn", {
      runId: "r1",
      agentRunId: "ar1",
      subConversationId: "sc1",
      agentName: "coder",
      agentConfigId: "cfg1",
      task: "x",
      parentConversationId: "pc1",
    });

    expect(getProcessCalled).toBe(true);
  });

  test("fire-and-forget: bus.emit returns immediately, no blocking", () => {
    const proc = mockProc();
    const registry = mockRegistry(new Map([["ext-a", proc]]));
    const dispatcher = new LifecycleHookDispatcher(bus, registry);

    dispatcher.registerExtension("ext-a", ["run:start"]);
    dispatcher.start();

    // emit is synchronous — should return immediately
    const before = Date.now();
    bus.emit("run:start", { run: { id: "r1", agentName: "x" } } as any);
    const elapsed = Date.now() - before;

    expect(elapsed).toBeLessThan(50);
    expect(proc.calls).toHaveLength(1);
  });

  test("stop() unsubscribes from all bus events", () => {
    const proc = mockProc();
    const registry = mockRegistry(new Map([["ext-a", proc]]));
    const dispatcher = new LifecycleHookDispatcher(bus, registry);

    dispatcher.registerExtension("ext-a", ["agent:spawn", "run:start"]);
    dispatcher.start();

    // Emit once before stop
    bus.emit("agent:spawn", {
      runId: "r1",
      agentRunId: "ar1",
      subConversationId: "sc1",
      agentName: "coder",
      agentConfigId: "cfg1",
      task: "x",
      parentConversationId: "pc1",
    });
    expect(proc.calls).toHaveLength(1);

    dispatcher.stop();

    // Emit after stop — should NOT arrive
    bus.emit("agent:spawn", {
      runId: "r2",
      agentRunId: "ar2",
      subConversationId: "sc2",
      agentName: "coder2",
      agentConfigId: "cfg2",
      task: "y",
      parentConversationId: "pc2",
    });
    bus.emit("run:start", { run: { id: "r3", agentName: "z" } } as any);

    expect(proc.calls).toHaveLength(1); // no new calls
  });

  test("handles missing/crashed processes gracefully (no throw)", () => {
    const registry = {
      getProcessIfRunning() { return null; },
    } as any;

    const dispatcher = new LifecycleHookDispatcher(bus, registry);
    dispatcher.registerExtension("ext-a", ["agent:spawn"]);
    dispatcher.start();

    expect(() => {
      bus.emit("agent:spawn", {
        runId: "r1",
        agentRunId: "ar1",
        subConversationId: "sc1",
        agentName: "coder",
        agentConfigId: "cfg1",
        task: "x",
        parentConversationId: "pc1",
      });
    }).not.toThrow();
  });

  test("handles process that throws on sendNotification gracefully", () => {
    const registry = {
      getProcessIfRunning() {
        return {
          isRunning: true,
          sendNotification() { throw new Error("process crashed"); },
        };
      },
    } as any;

    const dispatcher = new LifecycleHookDispatcher(bus, registry);
    dispatcher.registerExtension("ext-a", ["agent:spawn"]);
    dispatcher.start();

    expect(() => {
      bus.emit("agent:spawn", {
        runId: "r1",
        agentRunId: "ar1",
        subConversationId: "sc1",
        agentName: "coder",
        agentConfigId: "cfg1",
        task: "x",
        parentConversationId: "pc1",
      });
    }).not.toThrow();
  });

  test("run:complete sanitizer extracts correct fields", () => {
    const proc = mockProc();
    const registry = mockRegistry(new Map([["ext-a", proc]]));
    const dispatcher = new LifecycleHookDispatcher(bus, registry);

    dispatcher.registerExtension("ext-a", ["run:complete"]);
    dispatcher.start();

    bus.emit("run:complete", {
      run: { id: "r1", agentName: "builder", status: "success", result: { output: "SECRET" } },
      conversationId: "conv-secret",
    } as any);

    const payload = at(proc.calls, 0, "proc.calls").params;
    expect(payload).toHaveProperty("runId", "r1");
    expect(payload).toHaveProperty("agentName", "builder");
    expect(payload).toHaveProperty("status", "success");
    expect(payload).toHaveProperty("timestamp");
    expect(Object.keys(payload).filter((k) => k !== "_meta").sort())
      .toEqual(["agentName", "runId", "status", "timestamp"]);
    expect(typeof (payload._meta as { ezCallId?: string } | undefined)?.ezCallId).toBe("string");
  });

  test("agent:complete sanitizer extracts correct fields", () => {
    const proc = mockProc();
    const registry = mockRegistry(new Map([["ext-a", proc]]));
    const dispatcher = new LifecycleHookDispatcher(bus, registry);

    dispatcher.registerExtension("ext-a", ["agent:complete"]);
    dispatcher.start();

    bus.emit("agent:complete", {
      runId: "r1",
      agentRunId: "ar1",
      subConversationId: "sc1",
      agentName: "coder",
      agentConfigId: "cfg1",
      success: true,
      resultPreview: "user secrets here",
      parentConversationId: "pc1",
    });

    const payload = at(proc.calls, 0, "proc.calls").params;
    expect(payload).toHaveProperty("agentName", "coder");
    expect(payload).toHaveProperty("agentConfigId", "cfg1");
    expect(payload).toHaveProperty("runId", "r1");
    expect(payload).toHaveProperty("success", true);
    expect(payload).toHaveProperty("timestamp");
    expect(Object.keys(payload).filter((k) => k !== "_meta").sort())
      .toEqual(["agentConfigId", "agentName", "runId", "success", "timestamp"]);
    expect(typeof (payload._meta as { ezCallId?: string } | undefined)?.ezCallId).toBe("string");
  });

  test("run:start sanitizer extracts correct fields", () => {
    const proc = mockProc();
    const registry = mockRegistry(new Map([["ext-a", proc]]));
    const dispatcher = new LifecycleHookDispatcher(bus, registry);

    dispatcher.registerExtension("ext-a", ["run:start"]);
    dispatcher.start();

    bus.emit("run:start", {
      run: { id: "r1", agentName: "builder", projectId: "secret-project" },
      conversationId: "conv-secret",
    } as any);

    const payload = at(proc.calls, 0, "proc.calls").params;
    expect(payload).toHaveProperty("runId", "r1");
    expect(payload).toHaveProperty("agentName", "builder");
    expect(payload).toHaveProperty("timestamp");
    expect(Object.keys(payload).filter((k) => k !== "_meta").sort())
      .toEqual(["agentName", "runId", "timestamp"]);
    expect(typeof (payload._meta as { ezCallId?: string } | undefined)?.ezCallId).toBe("string");
  });

  test("stop() then start() re-subscribes to bus events", () => {
    const proc = mockProc();
    const registry = mockRegistry(new Map([["ext-a", proc]]));
    const dispatcher = new LifecycleHookDispatcher(bus, registry);

    dispatcher.registerExtension("ext-a", ["agent:spawn"]);
    dispatcher.start();

    bus.emit("agent:spawn", {
      runId: "r1",
      agentRunId: "ar1",
      subConversationId: "sc1",
      agentName: "coder",
      agentConfigId: "cfg1",
      task: "x",
      parentConversationId: "pc1",
    });
    expect(proc.calls).toHaveLength(1);

    dispatcher.stop();

    // After stop, events should not arrive
    bus.emit("agent:spawn", {
      runId: "r2",
      agentRunId: "ar2",
      subConversationId: "sc2",
      agentName: "coder2",
      agentConfigId: "cfg2",
      task: "y",
      parentConversationId: "pc2",
    });
    expect(proc.calls).toHaveLength(1);

    // Re-start should work
    dispatcher.start();

    bus.emit("agent:spawn", {
      runId: "r3",
      agentRunId: "ar3",
      subConversationId: "sc3",
      agentName: "coder3",
      agentConfigId: "cfg3",
      task: "z",
      parentConversationId: "pc3",
    });
    expect(proc.calls).toHaveLength(2);
  });

  test("stop() called twice does not throw", () => {
    const proc = mockProc();
    const registry = mockRegistry(new Map([["ext-a", proc]]));
    const dispatcher = new LifecycleHookDispatcher(bus, registry);

    dispatcher.registerExtension("ext-a", ["agent:spawn"]);
    dispatcher.start();

    expect(() => {
      dispatcher.stop();
      dispatcher.stop();
    }).not.toThrow();
  });

  test("registerExtension called multiple times for same extension accumulates hooks", () => {
    const proc = mockProc();
    const registry = mockRegistry(new Map([["ext-a", proc]]));
    const dispatcher = new LifecycleHookDispatcher(bus, registry);

    dispatcher.registerExtension("ext-a", ["agent:spawn"]);
    dispatcher.registerExtension("ext-a", ["run:complete"]);
    dispatcher.start();

    bus.emit("agent:spawn", {
      runId: "r1",
      agentRunId: "ar1",
      subConversationId: "sc1",
      agentName: "coder",
      agentConfigId: "cfg1",
      task: "x",
      parentConversationId: "pc1",
    });
    bus.emit("run:complete", {
      run: { id: "r1", agentName: "builder", status: "success" },
    } as any);

    expect(proc.calls).toHaveLength(2);
    expect(at(proc.calls, 0, "proc.calls").method).toBe("lifecycle/agent:spawn");
    expect(at(proc.calls, 1, "proc.calls").method).toBe("lifecycle/run:complete");
  });
});
