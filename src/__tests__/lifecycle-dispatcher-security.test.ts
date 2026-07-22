import { test, expect, describe, beforeEach } from "bun:test";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import {
  LifecycleHookDispatcher,
} from "../extensions/lifecycle-dispatcher";

// ── Helpers ─────────────────────────────────────────────────────────

/** Index into an array, throwing if the slot is absent — avoids `!` under noUncheckedIndexedAccess. */
function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

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

function mockRegistry(procs: Map<string, ReturnType<typeof mockProc>>) {
  return {
    getProcessIfRunning(extensionId: string) {
      const p = procs.get(extensionId);
      return p?.isRunning ? p : null;
    },
  } as any;
}

// ── Security Tests ──────────────────────────────────────────────────

describe("LifecycleHookDispatcher — Security", () => {
  let bus: EventBus<AgentEvents>;
  let proc: ReturnType<typeof mockProc>;
  let dispatcher: LifecycleHookDispatcher;

  beforeEach(() => {
    bus = new EventBus<AgentEvents>();
    proc = mockProc();
    const registry = mockRegistry(new Map([["ext-a", proc]]));
    dispatcher = new LifecycleHookDispatcher(bus, registry);
  });

  test("agent:spawn payload has NO subConversationId (sensitive)", () => {
    dispatcher.registerExtension("ext-a", ["agent:spawn"]);
    dispatcher.start();

    bus.emit("agent:spawn", {
      runId: "r1",
      agentRunId: "ar1",
      subConversationId: "sc-sensitive-123",
      agentName: "coder",
      agentConfigId: "cfg1",
      task: "build something",
      parentConversationId: "pc1",
    });

    const payload = at(proc.calls, 0, "proc.calls").params;
    expect(payload).not.toHaveProperty("subConversationId");
  });

  test("agent:spawn payload has NO parentConversationId (sensitive)", () => {
    dispatcher.registerExtension("ext-a", ["agent:spawn"]);
    dispatcher.start();

    bus.emit("agent:spawn", {
      runId: "r1",
      agentRunId: "ar1",
      subConversationId: "sc1",
      agentName: "coder",
      agentConfigId: "cfg1",
      task: "build something",
      parentConversationId: "pc-sensitive-456",
    });

    const payload = at(proc.calls, 0, "proc.calls").params;
    expect(payload).not.toHaveProperty("parentConversationId");
  });

  test("agent:spawn payload has NO task content", () => {
    dispatcher.registerExtension("ext-a", ["agent:spawn"]);
    dispatcher.start();

    bus.emit("agent:spawn", {
      runId: "r1",
      agentRunId: "ar1",
      subConversationId: "sc1",
      agentName: "coder",
      agentConfigId: "cfg1",
      task: "This is secret user task content with PII",
      parentConversationId: "pc1",
    });

    const payload = at(proc.calls, 0, "proc.calls").params;
    expect(payload).not.toHaveProperty("task");
    // Also verify no value contains the task text
    for (const val of Object.values(payload)) {
      if (typeof val === "string") {
        expect(val).not.toContain("secret user task");
      }
    }
  });

  test("agent:complete payload has NO resultPreview (may contain user data)", () => {
    dispatcher.registerExtension("ext-a", ["agent:complete"]);
    dispatcher.start();

    bus.emit("agent:complete", {
      runId: "r1",
      agentRunId: "ar1",
      subConversationId: "sc1",
      agentName: "coder",
      agentConfigId: "cfg1",
      success: true,
      resultPreview: "SSN: 123-45-6789, CC: 4111-xxxx",
      parentConversationId: "pc1",
    });

    const payload = at(proc.calls, 0, "proc.calls").params;
    expect(payload).not.toHaveProperty("resultPreview");
    for (const val of Object.values(payload)) {
      if (typeof val === "string") {
        expect(val).not.toContain("SSN");
        expect(val).not.toContain("4111");
      }
    }
  });

  test("run:complete payload has NO result.output (may contain secrets)", () => {
    dispatcher.registerExtension("ext-a", ["run:complete"]);
    dispatcher.start();

    bus.emit("run:complete", {
      run: {
        id: "r1",
        agentName: "builder",
        status: "success",
        result: { output: "API_KEY=sk-secret-12345", success: true },
      },
      conversationId: "conv-123",
    } as any);

    const payload = at(proc.calls, 0, "proc.calls").params;
    expect(payload).not.toHaveProperty("result");
    expect(payload).not.toHaveProperty("output");
    expect(payload).not.toHaveProperty("conversationId");
    for (const val of Object.values(payload)) {
      if (typeof val === "string") {
        expect(val).not.toContain("sk-secret");
        expect(val).not.toContain("API_KEY");
      }
    }
  });

  test("all string fields are coerced via String() (no object pass-through)", () => {
    dispatcher.registerExtension("ext-a", ["agent:spawn"]);
    dispatcher.start();

    // Pass objects where strings are expected
    bus.emit("agent:spawn", {
      runId: { nested: "object" } as any,
      agentRunId: "ar1",
      subConversationId: "sc1",
      agentName: 42 as any,
      agentConfigId: null as any,
      task: "x",
      parentConversationId: "pc1",
    });

    const payload = at(proc.calls, 0, "proc.calls").params;
    // All values should be strings or numbers (timestamp)
    expect(typeof payload.runId).toBe("string");
    expect(typeof payload.agentName).toBe("string");
    expect(typeof payload.agentConfigId).toBe("string");
    expect(typeof payload.timestamp).toBe("number");
    // Object should be stringified, not pass through
    expect(payload.runId).toBe("[object Object]");
    expect(payload.agentName).toBe("42");
    // null is caught by ?? "" fallback, then String("") = ""
    expect(payload.agentConfigId).toBe("");
  });

  test("registering hooks NOT in ALLOWED_LIFECYCLE_HOOKS is silently ignored", () => {
    dispatcher.registerExtension("ext-a", [
      "run:error" as any,
      "workflow:start" as any,
      "tool:start" as any,
      "run:token" as any,
    ]);
    dispatcher.start();

    // None of these should cause subscriptions
    bus.emit("run:start", { run: { id: "r1", agentName: "x" } } as any);

    expect(proc.calls).toHaveLength(0);
  });

  test("sanitizers cannot be overridden from outside the module", () => {
    // The sanitizers object is module-private (not exported).
    // Verify ALLOWED_LIFECYCLE_HOOKS is frozen (readonly tuple in TS,
    // but at runtime we can verify the export is an array and the module
    // does not expose a way to mutate sanitizers).
    const moduleExports = require("../extensions/lifecycle-dispatcher");

    // Only these should be exported:
    expect(moduleExports.ALLOWED_LIFECYCLE_HOOKS).toBeDefined();
    expect(moduleExports.LifecycleHookDispatcher).toBeDefined();

    // Sanitizers should NOT be exported
    expect(moduleExports.sanitizers).toBeUndefined();

    // ALLOWED_LIFECYCLE_HOOKS is a const array — verify contents
    expect([...moduleExports.ALLOWED_LIFECYCLE_HOOKS]).toEqual([
      "agent:spawn",
      "agent:complete",
      "run:start",
      "run:complete",
    ]);
  });

  test("agent:complete boolean success is properly coerced", () => {
    dispatcher.registerExtension("ext-a", ["agent:complete"]);
    dispatcher.start();

    // Pass truthy non-boolean
    bus.emit("agent:complete", {
      runId: "r1",
      agentRunId: "ar1",
      subConversationId: "sc1",
      agentName: "coder",
      agentConfigId: "cfg1",
      success: "truthy string" as any,
      resultPreview: "preview",
      parentConversationId: "pc1",
    });

    const payload = at(proc.calls, 0, "proc.calls").params;
    expect(payload.success).toBe(true);
    expect(typeof payload.success).toBe("boolean");
  });

  test("agent:complete with success=0 coerces to false", () => {
    dispatcher.registerExtension("ext-a", ["agent:complete"]);
    dispatcher.start();

    bus.emit("agent:complete", {
      runId: "r1",
      agentRunId: "ar1",
      subConversationId: "sc1",
      agentName: "coder",
      agentConfigId: "cfg1",
      success: 0 as any,
      resultPreview: "preview",
      parentConversationId: "pc1",
    });

    const payload = at(proc.calls, 0, "proc.calls").params;
    expect(payload.success).toBe(false);
  });

  test("run:start payload only has runId, agentName, timestamp", () => {
    dispatcher.registerExtension("ext-a", ["run:start"]);
    dispatcher.start();

    bus.emit("run:start", {
      run: {
        id: "r1",
        agentName: "builder",
        projectId: "proj-secret",
        provider: "openai",
        status: "running",
        startedAt: 12345,
        logs: [{ message: "secret log" }],
      },
    } as any);

    const payload = at(proc.calls, 0, "proc.calls").params;
    // Sanitized DATA fields are exactly the allowlist; `_meta` is host-added
    // ownerless provenance (a UUID), not sanitizer output — excluded here.
    expect(Object.keys(payload).filter((k) => k !== "_meta").sort())
      .toEqual(["agentName", "runId", "timestamp"]);
    expect(typeof (payload._meta as { ezCallId?: string } | undefined)?.ezCallId).toBe("string");
    expect(payload).not.toHaveProperty("projectId");
    expect(payload).not.toHaveProperty("provider");
    expect(payload).not.toHaveProperty("logs");
  });
});
