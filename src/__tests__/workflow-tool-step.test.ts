/**
 * `kind: "tool"` workflow steps — dispatch, ref resolution, and the
 * security guard that stops a sensitive capability from hanging a run
 * forever on an approval prompt nobody can answer.
 */
import { test, expect, describe } from "bun:test";
import {
  WorkflowExecutor,
  WorkflowApprovalRequiredError,
  workflowScopeKey,
} from "../runtime/workflow-executor";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import {
  beginNonInteractiveScope,
  createExtensionPermissionGate,
} from "../runtime/tools/permissions";
import { toolCallsThisTurn } from "../extensions/tool-executor/limits";
import type { AgentDefinition, AgentEvents, WorkflowDefinition } from "../types";
import type { ToolCallResult } from "../extensions/types";
import type { WorkflowToolRunner } from "../runtime/workflow-tool-runner";

interface RecordedCall {
  toolName: string;
  input: Record<string, unknown>;
  conversationId: string;
  messageId: string | null;
}

/** Test double for `ToolExecutor` — records every dispatch and returns
 *  whatever the test's `handler` says. */
function makeRunner(
  handler: (call: RecordedCall) => ToolCallResult | Promise<ToolCallResult>,
) {
  const calls: RecordedCall[] = [];
  const users: string[] = [];
  const runner: WorkflowToolRunner = {
    setCurrentUserId(userId: string) {
      users.push(userId);
    },
    async executeToolCall(toolName, input, conversationId, messageId) {
      const call = { toolName, input, conversationId, messageId };
      calls.push(call);
      return handler(call);
    },
  };
  return { runner, calls, users };
}

function ok(text: string): ToolCallResult {
  return { content: [{ type: "text", text }], isError: false };
}

function setup(
  handler: (call: RecordedCall) => ToolCallResult | Promise<ToolCallResult>,
  agents: AgentDefinition[] = [],
) {
  const bus = new EventBus<AgentEvents>();
  const executor = new AgentExecutor(loadAgentsStatic(agents), bus);
  const { runner, calls, users } = makeRunner(handler);
  const workflow = new WorkflowExecutor(executor, bus, {
    toolRunnerFactory: () => runner,
  });
  return { bus, workflow, calls, users };
}

describe("workflow kind:'tool' — dispatch", () => {
  test("runs the named tool and exposes its text as the step result", async () => {
    const { workflow, calls } = setup(() => ok("hello from the tool"));
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [{ name: "call", kind: "tool", tool: "demo__greet" }],
    };

    const run = await workflow.runWorkflow(def, {});

    expect(run.status).toBe("success");
    expect(run.result).toEqual({ success: true, output: "hello from the tool" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("demo__greet");
    expect(calls[0]?.messageId).toBeNull();
  });

  test("resolves `input` with the SHARED ref language, not a second grammar", async () => {
    const { workflow, calls } = setup(() => ok("done"));
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [
        { name: "seed", kind: "transform", output: { slug: "$input.name" } },
        {
          name: "call",
          kind: "tool",
          tool: "demo__write",
          input: {
            fromInput: "$input.name",
            fromPrev: "$prev.output.slug",
            fromStep: "$steps.seed.output.slug",
            literal: "just-a-string",
          },
        },
      ],
    };

    const run = await workflow.runWorkflow(def, { name: "widget" });

    expect(run.status).toBe("success");
    expect(calls[0]?.input).toEqual({
      fromInput: "widget",
      fromPrev: "widget",
      fromStep: "widget",
      literal: "just-a-string",
    });
  });

  test("a tool result feeds $prev / $steps for later steps unchanged", async () => {
    const { workflow } = setup(() => ok("payload-42"));
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [
        { name: "call", kind: "tool", tool: "demo__read" },
        {
          name: "reshape",
          kind: "transform",
          output: { viaPrev: "$prev.output", viaSteps: "$steps.call.output" },
        },
      ],
    };

    const run = await workflow.runWorkflow(def, {});

    expect(run.status).toBe("success");
    expect(run.result?.output).toEqual({
      viaPrev: "payload-42",
      viaSteps: "payload-42",
    });
  });

  test("a strict-ref failure fails the step before the tool is ever dispatched", async () => {
    const { workflow, calls } = setup(() => ok("never"));
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [{ name: "call", kind: "tool", tool: "demo__x", input: { v: "$prev.output" } }],
    };

    const run = await workflow.runWorkflow(def, {});

    expect(run.status).toBe("error");
    expect(calls).toHaveLength(0);
    expect(String(run.result?.error)).toContain("no previous step has produced a result");
  });

  test("an isError result fails the run loudly with the tool's text", async () => {
    const { workflow } = setup(() => ({
      content: [{ type: "text" as const, text: "disk full" }],
      isError: true,
    }));
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [{ name: "call", kind: "tool", tool: "demo__write" }],
    };

    const run = await workflow.runWorkflow(def, {});

    expect(run.status).toBe("error");
    expect(run.result?.error).toBe('Step "call" failed: disk full');
    expect(run.steps[0]?.status).toBe("error");
  });

  test("a thrown dispatch error (not an approval refusal) fails the step as an error", async () => {
    const { workflow } = setup(() => {
      throw new Error("Unknown tool: demo__nope");
    });
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [{ name: "call", kind: "tool", tool: "demo__nope" }],
    };

    const run = await workflow.runWorkflow(def, {});

    expect(run.status).toBe("error");
    expect(run.result?.error).toBe('Step "call" failed: Unknown tool: demo__nope');
  });

  test("a non-Error throw is still reported with its stringified value", async () => {
    const { workflow } = setup(() => {
      // Deliberately not an Error — exercises the String(err) branch.
      throw { toString: () => "plain string" };
    });
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [{ name: "call", kind: "tool", tool: "demo__x" }],
    };

    const run = await workflow.runWorkflow(def, {});

    expect(run.result?.error).toBe('Step "call" failed: plain string');
  });

  test("multi-part tool content is joined with newlines", async () => {
    const { workflow } = setup(() => ({
      content: [
        { type: "text" as const, text: "line-1" },
        { type: "text" as const, text: "line-2" },
      ],
      isError: false,
    }));
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [{ name: "call", kind: "tool", tool: "demo__multi" }],
    };

    const run = await workflow.runWorkflow(def, {});
    expect(run.result?.output).toBe("line-1\nline-2");
  });
});

describe("workflow kind:'tool' — acting user + scope key", () => {
  test("threads userId into the runner so the call is not ownerless", async () => {
    const { workflow, users } = setup(() => ok("x"));
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [{ name: "call", kind: "tool", tool: "demo__x" }],
    };

    await workflow.runWorkflow(def, {}, undefined, "user-77");

    expect(users).toEqual(["user-77"]);
  });

  test("no userId (CLI run) leaves the runner unbound rather than inventing one", async () => {
    const { workflow, users } = setup(() => ok("x"));
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [{ name: "call", kind: "tool", tool: "demo__x" }],
    };

    await workflow.runWorkflow(def, {});

    expect(users).toEqual([]);
  });

  test("passes a synthetic, never-empty conversationId derived from the run id", async () => {
    const { workflow, calls } = setup(() => ok("x"));
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [{ name: "call", kind: "tool", tool: "demo__x" }],
    };

    const run = await workflow.runWorkflow(def, {});

    // Empty string would make the SSE filter broadcast to every
    // subscriber and would null out the sec-H2 ownership check.
    expect(calls[0]?.conversationId).not.toBe("");
    expect(calls[0]?.conversationId).toBe(workflowScopeKey(run.id));
    expect(calls[0]?.conversationId).toContain(run.id);
  });

  test("the runner is built once per run and shared across steps", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(loadAgentsStatic([]), bus);
    const { runner, calls } = makeRunner(() => ok("x"));
    let built = 0;
    const workflow = new WorkflowExecutor(executor, bus, {
      toolRunnerFactory: () => {
        built += 1;
        return runner;
      },
    });
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [
        { name: "a", kind: "tool", tool: "demo__x" },
        { name: "b", kind: "tool", tool: "demo__y" },
      ],
    };

    await workflow.runWorkflow(def, {});

    expect(built).toBe(1);
    expect(calls).toHaveLength(2);
  });

  test("a workflow with no tool steps never builds a runner", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(loadAgentsStatic([]), bus);
    let built = 0;
    const workflow = new WorkflowExecutor(executor, bus, {
      toolRunnerFactory: () => {
        built += 1;
        return makeRunner(() => ok("x")).runner;
      },
    });
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [{ name: "t", kind: "transform", output: { a: "literal" } }],
    };

    await workflow.runWorkflow(def, {});

    expect(built).toBe(0);
  });

  test("releases its per-turn tool-call counter entry when the run ends", async () => {
    const { workflow } = setup(() => ok("x"));
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [{ name: "call", kind: "tool", tool: "demo__x" }],
    };

    const run = await workflow.runWorkflow(def, {});

    // The counter is keyed by whatever we pass as conversationId, and its
    // bus-driven reset only fires for real chat runs — so the executor
    // must clear its own key or the Map grows by one entry per run.
    expect(toolCallsThisTurn.has(workflowScopeKey(run.id))).toBe(false);
  });
});

describe("workflow kind:'tool' — sensitive-capability fail-fast", () => {
  /** Simulates the real dispatch: `executeToolCall` opens an extension
   *  permission gate on a PDP `prompt`. In a workflow scope the gate
   *  refuses synchronously; the executor must turn that into
   *  `awaiting_approval`, never a hang. */
  function promptingRunner(conversationIdSeen: { value?: string } = {}) {
    return makeRunner(async (call) => {
      conversationIdSeen.value = call.conversationId;
      await createExtensionPermissionGate({
        promptId: `p-${crypto.randomUUID()}`,
        conversationId: call.conversationId,
        userId: "user-1",
        extensionId: "extension-author",
        toolName: "create_extension",
        capabilityKind: "fs.write",
      });
      return ok("should never get here");
    });
  }

  test("does NOT hang: a prompt-requiring tool step settles the run promptly", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(loadAgentsStatic([]), bus);
    const { runner } = promptingRunner();
    const workflow = new WorkflowExecutor(executor, bus, {
      toolRunnerFactory: () => runner,
    });
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [
        { name: "install", kind: "tool", tool: "extension-author__create_extension" },
      ],
    };

    const run = await Promise.race([
      workflow.runWorkflow(def, {}, undefined, "user-1"),
      new Promise((_r, rej) => setTimeout(() => rej(new Error("runWorkflow hung")), 2000)),
    ]);

    expect((run as { status: string }).status).toBe("awaiting_approval");
  });

  test("terminalizes awaiting_approval with the named error, never success", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(loadAgentsStatic([]), bus);
    const { runner } = promptingRunner();
    const workflow = new WorkflowExecutor(executor, bus, {
      toolRunnerFactory: () => runner,
    });
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [{ name: "install", kind: "tool", tool: "extension-author__create_extension" }],
    };

    const run = await workflow.runWorkflow(def, {}, undefined, "user-1");

    expect(run.status).toBe("awaiting_approval");
    expect(run.status).not.toBe("success");
    expect(run.result?.success).toBe(false);
    expect(run.result?.error).toEqual({
      code: "awaiting_approval",
      message:
        'Step "install" requires interactive approval for capability fs.write and cannot run in a workflow',
    });
    expect(run.steps[0]?.status).toBe("awaiting_approval");
    expect(run.finishedAt).toBeGreaterThan(0);
  });

  test("earlier automatable steps still run and their results are kept", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(loadAgentsStatic([]), bus);
    const { runner } = promptingRunner();
    const workflow = new WorkflowExecutor(executor, bus, {
      toolRunnerFactory: () => runner,
    });
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [
        { name: "prep", kind: "transform", output: { ready: "yes" } },
        { name: "install", kind: "tool", tool: "extension-author__create_extension" },
      ],
    };

    const run = await workflow.runWorkflow(def, {}, undefined, "user-1");

    expect(run.status).toBe("awaiting_approval");
    expect(run.steps.map((s) => [s.stepName, s.status])).toEqual([
      ["prep", "success"],
      ["install", "awaiting_approval"],
    ]);
  });

  test("emits workflow:error (not workflow:complete) for an awaiting_approval run", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(loadAgentsStatic([]), bus);
    const { runner } = promptingRunner();
    const workflow = new WorkflowExecutor(executor, bus, {
      toolRunnerFactory: () => runner,
    });
    const seen: string[] = [];
    bus.on("workflow:complete", () => seen.push("complete"));
    bus.on("workflow:error", () => seen.push("error"));

    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [{ name: "install", kind: "tool", tool: "extension-author__create_extension" }],
    };
    await workflow.runWorkflow(def, {}, undefined, "user-1");

    expect(seen).toEqual(["error"]);
  });

  test("the run's non-interactive scope is deregistered when it finishes", async () => {
    const { workflow } = setup(() => ok("x"));
    const def: WorkflowDefinition = {
      name: "wf",
      description: "",
      steps: [{ name: "call", kind: "tool", tool: "demo__x" }],
    };
    const run = await workflow.runWorkflow(def, {});

    // With the scope gone, a gate on the same key parks normally again
    // (proving `end()` ran, not that the map merely still had the entry).
    const promptId = `after-${crypto.randomUUID()}`;
    const gate = createExtensionPermissionGate({
      promptId,
      conversationId: workflowScopeKey(run.id),
      userId: "user-1",
      extensionId: "ext",
      toolName: "t",
      capabilityKind: "shell",
      timeoutMs: 5,
    });
    await expect(gate).rejects.toThrow(/timed out/);
  });

  test("a denial from an OUTER scope is not misattributed to a tool step", async () => {
    // A pre-existing scope on an unrelated key must not leak its
    // `takeDenial()` state into this run's steps.
    const outer = beginNonInteractiveScope("some-other-scope");
    try {
      const { workflow } = setup(() => ok("fine"));
      const def: WorkflowDefinition = {
        name: "wf",
        description: "",
        steps: [{ name: "call", kind: "tool", tool: "demo__x" }],
      };
      const run = await workflow.runWorkflow(def, {});
      expect(run.status).toBe("success");
    } finally {
      outer.end();
    }
  });
});

describe("WorkflowApprovalRequiredError", () => {
  test("carries the step name and capability kind for callers that branch on it", () => {
    const err = new WorkflowApprovalRequiredError("deploy", "shell");
    expect(err.name).toBe("WorkflowApprovalRequiredError");
    expect(err.stepName).toBe("deploy");
    expect(err.capabilityKind).toBe("shell");
    expect(err.message).toBe(
      'Step "deploy" requires interactive approval for capability shell and cannot run in a workflow',
    );
  });
});
