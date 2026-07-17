import { test, expect, describe } from "bun:test";
import { WorkflowExecutor } from "../runtime/workflow-executor";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import type { AgentDefinition, AgentEvents, WorkflowDefinition } from "../types";

function makeAgent(name: string, fn: AgentDefinition["execute"]): AgentDefinition {
  return { name, description: `${name} agent`, capabilities: ["llm"], execute: fn };
}

function setup(agents: AgentDefinition[]) {
  const bus = new EventBus<AgentEvents>();
  const agentMap = loadAgentsStatic(agents);
  const executor = new AgentExecutor(agentMap, bus);
  const workflow = new WorkflowExecutor(executor, bus);
  return { bus, executor, workflow };
}

describe("WorkflowExecutor", () => {
  test("runs steps sequentially when no dependsOn", async () => {
    const order: string[] = [];
    const { workflow } = setup([
      makeAgent("a", async () => {
        order.push("a");
        return { success: true, output: "result-a" };
      }),
      makeAgent("b", async () => {
        order.push("b");
        return { success: true, output: "result-b" };
      }),
    ]);

    const def: WorkflowDefinition = {
      name: "test-workflow",
      description: "test",
      steps: [
        { name: "step-1", agent: "a" },
        { name: "step-2", agent: "b" },
      ],
    };

    const run = await workflow.runWorkflow(def, {});

    expect(run.status).toBe("success");
    expect(run.workflowName).toBe("test-workflow");
    expect(order).toEqual(["a", "b"]);
    expect(run.steps).toHaveLength(2);
  });

  test("runs parallel steps with dependsOn", async () => {
    const startTimes: Record<string, number> = {};
    const { workflow } = setup([
      makeAgent("slow-a", async () => {
        startTimes["a"] = Date.now();
        await new Promise((r) => setTimeout(r, 50));
        return { success: true, output: "a" };
      }),
      makeAgent("slow-b", async () => {
        startTimes["b"] = Date.now();
        await new Promise((r) => setTimeout(r, 50));
        return { success: true, output: "b" };
      }),
      makeAgent("combiner", async () => {
        startTimes["c"] = Date.now();
        return { success: true, output: "combined" };
      }),
    ]);

    const def: WorkflowDefinition = {
      name: "parallel-workflow",
      description: "test",
      steps: [
        { name: "step-a", agent: "slow-a", dependsOn: [] },
        { name: "step-b", agent: "slow-b", dependsOn: [] },
        { name: "step-c", agent: "combiner", dependsOn: ["step-a", "step-b"] },
      ],
    };

    const run = await workflow.runWorkflow(def, {});

    expect(run.status).toBe("success");
    expect(run.steps).toHaveLength(3);
    // step-c should start after both a and b
    expect(startTimes["c"]).toBeGreaterThanOrEqual(Math.max(startTimes["a"]!, startTimes["b"]!));
  });

  test("halts workflow on step failure", async () => {
    const { workflow } = setup([
      makeAgent("fail-agent", async () => {
        return { success: false, output: null, error: "step failed" };
      }),
      makeAgent("never-run", async () => {
        throw new Error("should not run");
      }),
    ]);

    const def: WorkflowDefinition = {
      name: "failing-workflow",
      description: "test",
      steps: [
        { name: "step-1", agent: "fail-agent" },
        { name: "step-2", agent: "never-run" },
      ],
    };

    const run = await workflow.runWorkflow(def, {});

    expect(run.status).toBe("error");
    expect(run.result?.error).toContain("step failed");
  });

  test("surfaces a structured (object) agent error message", async () => {
    const { workflow } = setup([
      makeAgent("obj-fail", async () => ({
        success: false,
        output: null,
        error: { code: "boom", message: "structured failure" },
      })),
    ]);
    const def: WorkflowDefinition = {
      name: "obj-err",
      description: "t",
      steps: [{ name: "s1", agent: "obj-fail" }],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("error");
    expect(run.result?.error).toContain("structured failure");
  });

  test("surfaces 'unknown error' when a failed result carries no error field", async () => {
    const { workflow } = setup([
      makeAgent("bare-fail", async () => ({ success: false, output: null })),
    ]);
    const def: WorkflowDefinition = {
      name: "bare-err",
      description: "t",
      steps: [{ name: "s1", agent: "bare-fail" }],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("error");
    expect(run.result?.error).toContain("unknown error");
  });

  test("detects circular dependencies", () => {
    const { workflow } = setup([]);

    expect(() => {
      workflow.resolveExecutionOrder([
        { name: "a", agent: "x", dependsOn: ["b"] },
        { name: "b", agent: "x", dependsOn: ["a"] },
      ]);
    }).toThrow("Circular dependency");
  });

  test("resolves $input, $prev, $steps references", () => {
    const { workflow } = setup([]);

    const resolved = workflow.resolveStepInput(
      {
        text: "$input.query",
        prev: "$prev.output",
        specific: "$steps.step-1.output",
        literal: "hello",
      },
      { query: "test query" },
      new Map([["step-1", { success: true, output: "step-1-output" }]]),
      { success: true, output: "prev-output" },
    );

    expect(resolved.text).toBe("test query");
    expect(resolved.prev).toBe("prev-output");
    expect(resolved.specific).toBe("step-1-output");
    expect(resolved.literal).toBe("hello");
  });

  test("emits workflow events", async () => {
    const events: string[] = [];
    const { workflow, bus } = setup([
      makeAgent("ok", async () => ({ success: true, output: null })),
    ]);

    bus.on("workflow:start", () => events.push("start"));
    bus.on("workflow:step", () => events.push("step"));
    bus.on("workflow:complete", () => events.push("complete"));

    const def: WorkflowDefinition = {
      name: "event-test",
      description: "test",
      steps: [{ name: "step-1", agent: "ok" }],
    };

    await workflow.runWorkflow(def, {});

    expect(events).toContain("start");
    expect(events).toContain("step");
    expect(events).toContain("complete");
  });
});

// ── userId scoping: workflow events carry the initiating userId so the SSE
//    filter can scope delivery fail-closed. ──────────────────────────────

describe("WorkflowExecutor — workflow:* userId scoping", () => {
  test("success path stamps userId on start/step/complete events", async () => {
    const { bus, workflow } = setup([
      makeAgent("ok", async () => ({ success: true, output: "fine" })),
    ]);
    const seen: Array<{ type: string; userId?: string }> = [];
    bus.on("workflow:start", (d) => seen.push({ type: "start", userId: d.userId }));
    bus.on("workflow:step", (d) => seen.push({ type: "step", userId: d.userId }));
    bus.on("workflow:complete", (d) => seen.push({ type: "complete", userId: d.userId }));

    const def: WorkflowDefinition = {
      name: "scoped",
      description: "t",
      steps: [{ name: "s1", agent: "ok" }],
    };
    const run = await workflow.runWorkflow(def, {}, undefined, "user-42");

    expect(run.status).toBe("success");
    expect(seen.map((e) => e.type)).toEqual(["start", "step", "complete"]);
    for (const e of seen) expect(e.userId).toBe("user-42");
  });

  test("error path stamps userId on workflow:error; CLI runs (no user) emit undefined", async () => {
    const { bus, workflow } = setup([
      makeAgent("boom", async () => ({ success: false, output: null, error: "nope" })),
    ]);
    const errors: Array<string | undefined> = [];
    bus.on("workflow:error", (d) => errors.push(d.userId));

    const def: WorkflowDefinition = {
      name: "scoped-err",
      description: "t",
      steps: [{ name: "s1", agent: "boom" }],
    };

    const withUser = await workflow.runWorkflow(def, {}, undefined, "user-42");
    expect(withUser.status).toBe("error");
    const cli = await workflow.runWorkflow(def, {});
    expect(cli.status).toBe("error");

    expect(errors).toEqual(["user-42", undefined]);
  });
});

// ── Durability: abort propagation, sibling cancel on failure, per-step
//    retry, strict `$steps`/`$prev` refs. ────────────────────────────────

/** An agent that never resolves on its own — it only settles when its
 *  run's `ctx.signal` is aborted (via the executor's cancelRun). The
 *  `onAbort` flag lets a test observe that the run was actually cancelled. */
function blockingAgent(
  name: string,
  onAbort: (flip: () => void) => void,
): AgentDefinition {
  return makeAgent(name, async (ctx) => {
    await new Promise<void>((_resolve, reject) => {
      ctx.signal.addEventListener(
        "abort",
        () => {
          onAbort(() => {});
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
    return { success: true, output: "never" };
  });
}

describe("WorkflowExecutor — abort propagation", () => {
  test("aborting the workflow cancels the in-flight step run and marks it cancelled", async () => {
    let aborted = false;
    const { bus, workflow } = setup([
      blockingAgent("blocker", () => {
        aborted = true;
      }),
    ]);
    const def: WorkflowDefinition = {
      name: "abortable",
      description: "t",
      steps: [{ name: "s1", agent: "blocker" }],
    };

    // Abort only AFTER the step's run has actually started.
    const started = new Promise<void>((resolve) => {
      const off = bus.on("run:start", () => {
        off();
        resolve();
      });
    });
    const controller = new AbortController();
    const runPromise = workflow.runWorkflow(
      def,
      {},
      undefined,
      undefined,
      controller.signal,
    );
    await started;
    controller.abort();

    const run = await runPromise;
    expect(run.status).toBe("cancelled");
    expect(aborted).toBe(true);
    expect(run.result?.error).toMatchObject({ code: "cancelled" });
  });

  test("a signal already aborted before start cancels the workflow without running steps", async () => {
    let ran = false;
    const { workflow } = setup([
      makeAgent("never", async () => {
        ran = true;
        return { success: true, output: null };
      }),
    ]);
    const def: WorkflowDefinition = {
      name: "pre-aborted",
      description: "t",
      steps: [{ name: "s1", agent: "never" }],
    };
    const controller = new AbortController();
    controller.abort();
    const run = await workflow.runWorkflow(
      def,
      {},
      undefined,
      undefined,
      controller.signal,
    );
    expect(run.status).toBe("cancelled");
    expect(ran).toBe(false);
  });
});

describe("WorkflowExecutor — sibling cancel on failure", () => {
  test("a step failure cancels its still-running batch siblings and fails the workflow", async () => {
    let siblingAborted = false;
    const { workflow } = setup([
      makeAgent("failer", async () => ({
        success: false,
        output: null,
        error: "boom",
      })),
      blockingAgent("sibling", () => {
        siblingAborted = true;
      }),
      makeAgent("sink", async () => ({ success: true, output: "sink" })),
    ]);
    // A real dependsOn on the sink forces batch semantics so failer + sibling
    // run as parallel siblings in batch 1 (dependsOn:[] alone stays sequential).
    const def: WorkflowDefinition = {
      name: "sibling-cancel",
      description: "t",
      steps: [
        { name: "s-fail", agent: "failer", dependsOn: [] },
        { name: "s-block", agent: "sibling", dependsOn: [] },
        { name: "s-sink", agent: "sink", dependsOn: ["s-fail", "s-block"] },
      ],
    };

    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("error");
    expect(run.result?.error).toContain("boom");
    expect(siblingAborted).toBe(true);
    // The dependent batch-2 step never ran (only the two batch-1 siblings were pushed).
    expect(run.steps.map((s) => s.stepName).sort()).toEqual(["s-block", "s-fail"]);
  });
});

describe("WorkflowExecutor — per-step retry", () => {
  test("retries a failing step up to its budget, then succeeds", async () => {
    let attempts = 0;
    const { workflow } = setup([
      makeAgent("flaky", async () => {
        attempts++;
        return attempts < 3
          ? { success: false, output: null, error: "transient" }
          : { success: true, output: "ok" };
      }),
    ]);
    const def: WorkflowDefinition = {
      name: "retry-ok",
      description: "t",
      steps: [{ name: "s1", agent: "flaky", retries: 2 }],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("success");
    expect(attempts).toBe(3); // 1 initial + 2 retries
    expect(run.result?.output).toBe("ok");
  });

  test("fails the workflow once the retry budget is exhausted", async () => {
    let attempts = 0;
    const { workflow } = setup([
      makeAgent("always-fails", async () => {
        attempts++;
        return { success: false, output: null, error: "nope" };
      }),
    ]);
    const def: WorkflowDefinition = {
      name: "retry-exhausted",
      description: "t",
      steps: [{ name: "s1", agent: "always-fails", retries: 1 }],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("error");
    expect(attempts).toBe(2); // 1 initial + 1 retry
    expect(run.result?.error).toContain("nope");
  });

  test("clamps a retry budget above 2 down to 2 (max 3 attempts)", async () => {
    let attempts = 0;
    const { workflow } = setup([
      makeAgent("f", async () => {
        attempts++;
        return { success: false, output: null, error: "x" };
      }),
    ]);
    const def: WorkflowDefinition = {
      name: "retry-clamp-high",
      description: "t",
      steps: [{ name: "s1", agent: "f", retries: 5 }],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("error");
    expect(attempts).toBe(3);
  });

  test("treats a negative retry budget as zero (single attempt)", async () => {
    let attempts = 0;
    const { workflow } = setup([
      makeAgent("f", async () => {
        attempts++;
        return { success: false, output: null, error: "x" };
      }),
    ]);
    const def: WorkflowDefinition = {
      name: "retry-clamp-neg",
      description: "t",
      steps: [{ name: "s1", agent: "f", retries: -1 }],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("error");
    expect(attempts).toBe(1);
  });
});

describe("WorkflowExecutor — strict `$steps` / `$prev` references", () => {
  test("a missing `$steps` reference fails the workflow with a descriptive error", async () => {
    const { workflow } = setup([
      makeAgent("a", async () => ({ success: true, output: "a" })),
    ]);
    const def: WorkflowDefinition = {
      name: "bad-ref",
      description: "t",
      steps: [{ name: "s1", agent: "a", input: { x: "$steps.nope.output" } }],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("error");
    expect(run.result?.error).toContain('step "nope" has not produced a result');
  });

  test("`$steps.NAME` without a field returns the whole step result", () => {
    const { workflow } = setup([]);
    const resolved = workflow.resolveStepInput(
      { whole: "$steps.s1" },
      {},
      new Map([["s1", { success: true, output: "o" }]]),
      undefined,
    );
    expect(resolved.whole).toEqual({ success: true, output: "o" });
  });

  test("throws when `$prev` has no previous step result", () => {
    const { workflow } = setup([]);
    expect(() =>
      workflow.resolveStepInput({ x: "$prev.output" }, {}, new Map(), undefined),
    ).toThrow(/no previous step/);
  });

  test("throws when a `$prev` field is missing on the previous result", () => {
    const { workflow } = setup([]);
    expect(() =>
      workflow.resolveStepInput(
        { x: "$prev.nope" },
        {},
        new Map(),
        { success: true, output: "o" },
      ),
    ).toThrow(/field "nope" is missing/);
  });

  test("throws when a `$steps` field is missing on the step result", () => {
    const { workflow } = setup([]);
    expect(() =>
      workflow.resolveStepInput(
        { x: "$steps.s1.nope" },
        {},
        new Map([["s1", { success: true, output: "o" }]]),
        undefined,
      ),
    ).toThrow(/field "nope" is missing/);
  });
});

// ── Transform steps (pure, declarative, no LLM). ─────────────────────────

describe("WorkflowExecutor — transform steps", () => {
  test("resolves an output mapping and exposes it as $steps.<name>.output", async () => {
    const { workflow } = setup([
      makeAgent("gen", async () => ({ success: true, output: { title: "Hello" } })),
    ]);
    const def: WorkflowDefinition = {
      name: "transform-basic",
      description: "t",
      steps: [
        { name: "gen", agent: "gen" },
        {
          name: "shape",
          kind: "transform",
          output: {
            heading: "$steps.gen.output.title",
            slug: "static-slug",
          },
        },
      ],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("success");
    expect(run.result?.output).toEqual({ heading: "Hello", slug: "static-slug" });
  });

  test("template-interpolates {{…}} placeholders into a composed string", async () => {
    const { workflow } = setup([
      makeAgent("gen", async () => ({ success: true, output: { title: "World" } })),
    ]);
    const def: WorkflowDefinition = {
      name: "transform-template",
      description: "t",
      steps: [
        { name: "gen", agent: "gen" },
        {
          name: "compose",
          kind: "transform",
          output: {
            line: "{{$input.prefix}} — {{$steps.gen.output.title}}",
          },
        },
      ],
    };
    const run = await workflow.runWorkflow(def, { prefix: "Greeting" });
    expect(run.status).toBe("success");
    expect(run.result?.output).toEqual({ line: "Greeting — World" });
  });

  test("a transform is a pure function of its inputs (identical output across runs)", async () => {
    const { workflow } = setup([]);
    const def: WorkflowDefinition = {
      name: "transform-pure",
      description: "t",
      steps: [
        {
          name: "shape",
          kind: "transform",
          output: { greeting: "{{$input.name}}!" },
        },
      ],
    };
    const a = await workflow.runWorkflow(def, { name: "Ada" });
    const b = await workflow.runWorkflow(def, { name: "Ada" });
    expect(a.result?.output).toEqual(b.result?.output);
    // Transform steps mint no agent run.
    expect(a.steps[0]!.runId).toBe("");
  });
});

// ── Gate steps (declarative assertions). ─────────────────────────────────

describe("WorkflowExecutor — gate steps", () => {
  test("a satisfied gate passes and yields { passed: true }", async () => {
    const { workflow } = setup([]);
    const def: WorkflowDefinition = {
      name: "gate-pass",
      description: "t",
      steps: [
        { name: "shape", kind: "transform", output: { n: "42" } },
        {
          name: "assert",
          kind: "gate",
          condition: { ref: "$steps.shape.output.n", op: "eq", value: "42" },
        },
      ],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("success");
    expect(run.result?.output).toEqual({ passed: true });
  });

  test("a failed gate throws a descriptive error and fails the workflow", async () => {
    const { workflow } = setup([]);
    const def: WorkflowDefinition = {
      name: "gate-fail",
      description: "t",
      steps: [
        {
          name: "assert",
          kind: "gate",
          condition: { ref: "$input.value", op: "gt", value: 100 },
        },
      ],
    };
    const run = await workflow.runWorkflow(def, { value: 5 });
    expect(run.status).toBe("error");
    expect(run.result?.error).toContain('Gate "assert" failed');
    expect(run.result?.error).toContain("does not satisfy");
  });
});

// ── Loops (bounded per-step repetition). ─────────────────────────────────

describe("WorkflowExecutor — loops", () => {
  test("transform loop exits early when its until-condition is met", async () => {
    const { workflow } = setup([]);
    const def: WorkflowDefinition = {
      name: "loop-until",
      description: "t",
      steps: [
        {
          name: "count",
          kind: "transform",
          output: { n: "$loop.iteration" },
          loop: {
            maxIterations: 5,
            until: { ref: "$result.output.n", op: "gte", value: 3 },
          },
        },
      ],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("success");
    expect(run.steps[0]!.iterations).toBe(3);
    expect(run.result?.output).toEqual({ n: 3 });
  });

  test("$loop.last carries the previous iteration's result; iteration 1 omits it", async () => {
    const { workflow } = setup([]);
    const def: WorkflowDefinition = {
      name: "loop-accumulate",
      description: "t",
      steps: [
        {
          name: "acc",
          kind: "transform",
          output: {
            iteration: "$loop.iteration",
            prev: "$loop.last.output.iteration",
          },
          loop: {
            maxIterations: 3,
            until: { ref: "$iteration", op: "gte", value: 3 },
          },
        },
      ],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("success");
    // Final iteration (3) saw iteration 2's result as $loop.last.
    expect(run.result?.output).toEqual({ iteration: 3, prev: 2 });
  });

  test("a no-until loop runs a fixed count and always passes", async () => {
    const { workflow } = setup([]);
    const def: WorkflowDefinition = {
      name: "loop-fixed",
      description: "t",
      steps: [
        {
          name: "count",
          kind: "transform",
          output: { n: "$loop.iteration" },
          loop: { maxIterations: 4 },
        },
      ],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("success");
    expect(run.steps[0]!.iterations).toBe(4);
    expect(run.result?.output).toEqual({ n: 4 });
  });

  test("exhausting the budget with onExhausted:'fail' (default) throws loudly", async () => {
    const { workflow } = setup([]);
    const def: WorkflowDefinition = {
      name: "loop-exhaust-fail",
      description: "t",
      steps: [
        {
          name: "never",
          kind: "transform",
          output: { n: "$loop.iteration" },
          loop: {
            maxIterations: 3,
            until: { ref: "$result.output.n", op: "gte", value: 999 },
          },
        },
      ],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("error");
    expect(run.result?.error).toContain(
      'Step "never" exhausted 3 iterations without meeting its until-condition',
    );
  });

  test("exhausting the budget with onExhausted:'pass' succeeds with the last result", async () => {
    const { workflow } = setup([]);
    const def: WorkflowDefinition = {
      name: "loop-exhaust-pass",
      description: "t",
      steps: [
        {
          name: "best-effort",
          kind: "transform",
          output: { n: "$loop.iteration" },
          loop: {
            maxIterations: 3,
            until: { ref: "$result.output.n", op: "gte", value: 999 },
            onExhausted: "pass",
          },
        },
      ],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("success");
    expect(run.steps[0]!.iterations).toBe(3);
    expect(run.result?.output).toEqual({ n: 3 });
  });

  test("an agent loop feeds $loop.last into the next iteration's input", async () => {
    const seen: Array<unknown> = [];
    const { workflow } = setup([
      makeAgent("stepper", async (ctx) => {
        seen.push((ctx.input as Record<string, unknown>).previous);
        const iteration = (ctx.input as Record<string, unknown>).iteration as number;
        return { success: true, output: { count: iteration } };
      }),
    ]);
    const def: WorkflowDefinition = {
      name: "loop-agent",
      description: "t",
      steps: [
        {
          name: "run",
          agent: "stepper",
          input: {
            iteration: "$loop.iteration",
            previous: "$loop.last.output.count",
          },
          loop: {
            maxIterations: 3,
            until: { ref: "$result.output.count", op: "gte", value: 3 },
          },
        },
      ],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("success");
    expect(run.steps[0]!.iterations).toBe(3);
    // Iteration 1 had `previous` omitted; iterations 2 and 3 saw the prior count.
    expect(seen).toEqual([undefined, 1, 2]);
  });

  test("an agent failure inside a loop fails the workflow with a descriptive error", async () => {
    const { workflow } = setup([
      makeAgent("loop-fail", async () => ({
        success: false,
        output: null,
        error: "iteration blew up",
      })),
    ]);
    const def: WorkflowDefinition = {
      name: "loop-agent-fail",
      description: "t",
      steps: [
        {
          name: "run",
          agent: "loop-fail",
          input: { iteration: "$loop.iteration" },
          loop: { maxIterations: 3 },
        },
      ],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("error");
    expect(run.result?.error).toContain('Step "run" failed: iteration blew up');
  });

  test("cancelling mid-loop ends the run cancelled", async () => {
    let aborted = false;
    const { bus, workflow } = setup([
      blockingAgent("loop-blocker", () => {
        aborted = true;
      }),
    ]);
    const def: WorkflowDefinition = {
      name: "loop-cancel",
      description: "t",
      steps: [
        {
          name: "run",
          agent: "loop-blocker",
          input: { iteration: "$loop.iteration" },
          loop: { maxIterations: 3 },
        },
      ],
    };
    const started = new Promise<void>((resolve) => {
      const off = bus.on("run:start", () => {
        off();
        resolve();
      });
    });
    const controller = new AbortController();
    const runPromise = workflow.runWorkflow(def, {}, undefined, undefined, controller.signal);
    await started;
    controller.abort();
    const run = await runPromise;
    expect(run.status).toBe("cancelled");
    expect(aborted).toBe(true);
  });
});

// ── Terminal step status: a non-agent step (gate/transform/loop) that fails
//    must never be left "running" — only agent steps mirror their AgentRun
//    status, so the executor terminalizes the rest. ───────────────────────

describe("WorkflowExecutor — terminal step status on failure", () => {
  test("a failed gate marks its step run 'error' (not left running)", async () => {
    const { workflow } = setup([]);
    const def: WorkflowDefinition = {
      name: "gate-terminal",
      description: "t",
      steps: [
        {
          name: "assert",
          kind: "gate",
          condition: { ref: "$input.value", op: "gt", value: 100 },
        },
      ],
    };
    const run = await workflow.runWorkflow(def, { value: 5 });
    expect(run.status).toBe("error");
    expect(run.steps[0]!.status).toBe("error");
  });

  test("a transform strict-ref failure marks its step run 'error'", async () => {
    const { workflow } = setup([]);
    const def: WorkflowDefinition = {
      name: "transform-terminal",
      description: "t",
      steps: [
        {
          name: "shape",
          kind: "transform",
          output: { x: "$steps.nope.output" },
        },
      ],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("error");
    expect(run.steps[0]!.status).toBe("error");
  });

  test("loop exhaustion (onExhausted:'fail') marks the looped step 'error'", async () => {
    const { workflow } = setup([]);
    const def: WorkflowDefinition = {
      name: "loop-terminal",
      description: "t",
      steps: [
        {
          name: "never",
          kind: "transform",
          output: { n: "$loop.iteration" },
          loop: {
            maxIterations: 2,
            until: { ref: "$result.output.n", op: "gte", value: 999 },
          },
        },
      ],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("error");
    expect(run.steps[0]!.status).toBe("error");
  });

  test("AGENT-loop exhaustion marks the looped step 'error' (not stale 'success')", async () => {
    // Regression: runAgentAttempt stamps each successful iteration's
    // "success" onto the step run, so the exhaustion throw used to leave a
    // failed step reporting "success" (the transform variant above never
    // stamps stepRun.status, which is why it didn't catch this).
    const { workflow } = setup([
      makeAgent("small", async () => ({ success: true, output: { n: 1 } })),
    ]);
    const def: WorkflowDefinition = {
      name: "agent-loop-terminal",
      description: "t",
      steps: [
        {
          name: "s1",
          agent: "small",
          loop: {
            maxIterations: 2,
            until: { ref: "$result.output.n", op: "gte", value: 999 },
          },
        },
      ],
    };
    const run = await workflow.runWorkflow(def, {});
    expect(run.status).toBe("error");
    expect(run.result?.error).toContain(
      'Step "s1" exhausted 2 iterations without meeting its until-condition',
    );
    expect(run.steps[0]!.status).toBe("error");
  });

  test("cancelling an in-flight step marks it 'cancelled' (terminal)", async () => {
    let aborted = false;
    const { bus, workflow } = setup([
      blockingAgent("blocker", () => {
        aborted = true;
      }),
    ]);
    const def: WorkflowDefinition = {
      name: "cancel-terminal",
      description: "t",
      steps: [{ name: "s1", agent: "blocker" }],
    };
    const started = new Promise<void>((resolve) => {
      const off = bus.on("run:start", () => {
        off();
        resolve();
      });
    });
    const controller = new AbortController();
    const runPromise = workflow.runWorkflow(def, {}, undefined, undefined, controller.signal);
    await started;
    controller.abort();
    const run = await runPromise;
    expect(run.status).toBe("cancelled");
    expect(aborted).toBe(true);
    expect(run.steps[0]!.status).toBe("cancelled");
  });
});
