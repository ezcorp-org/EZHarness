/**
 * The production `WorkflowToolRunner` factory: the cold-start wiring a
 * workflow tool step uses when no fake is injected.
 */
import { test, expect, describe } from "bun:test";
import { EventBus } from "../runtime/events";
import { createWorkflowToolRunner } from "../runtime/workflow-tool-runner";
import { _resetPermissionEngineForTests } from "../extensions/permission-engine";
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
