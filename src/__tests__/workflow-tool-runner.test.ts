/**
 * The production `WorkflowToolRunner` factory: the cold-start wiring a
 * workflow tool step uses when no fake is injected.
 */
import { test, expect, describe, spyOn } from "bun:test";
import { EventBus } from "../runtime/events";
import { createWorkflowToolRunner } from "../runtime/workflow-tool-runner";
import { _resetPermissionEngineForTests } from "../extensions/permission-engine";
import { ToolExecutor } from "../extensions/tool-executor";
import type { AgentEvents } from "../types";

describe("createWorkflowToolRunner", () => {
  test("builds a runner satisfying the WorkflowToolRunner surface", () => {
    _resetPermissionEngineForTests();
    const runner = createWorkflowToolRunner(new EventBus<AgentEvents>());
    expect(typeof runner.setCurrentUserId).toBe("function");
    expect(typeof runner.executeToolCall).toBe("function");
  });

  test("initialises the PDP singleton itself (cold start — no chat turn yet)", () => {
    // `getPermissionEngine()` with no deps throws when the singleton is
    // unset; the factory must pass deps so a workflow fired before any
    // chat turn still gets an engine rather than a boot-order crash.
    _resetPermissionEngineForTests();
    expect(() => createWorkflowToolRunner(new EventBus<AgentEvents>())).not.toThrow();
  });

  test("dispatches through the real ToolExecutor — an unknown tool is an error result", async () => {
    _resetPermissionEngineForTests();
    const runner = createWorkflowToolRunner(new EventBus<AgentEvents>());
    runner.setCurrentUserId("user-1");
    const result = await runner.executeToolCall(
      "no-such-extension__no_such_tool",
      {},
      "workflow-run:test",
      null,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown tool");
  });
});

describe("createWorkflowToolRunner — pending-permission gate", () => {
  test("wires a supplied gate into the ToolExecutor", () => {
    // Only an INTERACTIVE run supplies one. It is what makes a parked
    // consent card visible to the run watchdog: `deferralReason` reads
    // `host.pendingPermissions` and nothing else, so an unregistered gate
    // is mis-read as a hung in-flight tool and the run is killed at the
    // callTimeoutMs ceiling — tearing the prompt down before the user can
    // answer it (the "stuck chat" defect).
    _resetPermissionEngineForTests();
    const spy = spyOn(ToolExecutor.prototype, "setPendingPermissionGate");
    try {
      const gate = { register: () => {}, deregister: () => {} };
      createWorkflowToolRunner(new EventBus<AgentEvents>(), gate);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual([gate.register, gate.deregister]);
    } finally {
      spy.mockRestore();
    }
  });

  test("omitting the gate leaves the executor's no-op default in place", () => {
    // A non-interactive run never parks a gate, so there is no wait to
    // explain to the watchdog and nothing to register.
    _resetPermissionEngineForTests();
    const spy = spyOn(ToolExecutor.prototype, "setPendingPermissionGate");
    try {
      createWorkflowToolRunner(new EventBus<AgentEvents>());
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
