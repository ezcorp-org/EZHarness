import { test, expect, describe, } from "bun:test";
import { PipelineExecutor } from "../runtime/pipeline-executor";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import type { AgentDefinition, AgentEvents, PipelineDefinition } from "../types";

function makeAgent(name: string, fn: AgentDefinition["execute"]): AgentDefinition {
  return { name, description: `${name} agent`, capabilities: ["llm"], execute: fn };
}

function setup(agents: AgentDefinition[]) {
  const bus = new EventBus<AgentEvents>();
  const agentMap = loadAgentsStatic(agents);
  const executor = new AgentExecutor(agentMap, bus);
  const pipeline = new PipelineExecutor(executor, bus);
  return { bus, executor, pipeline };
}

describe("PipelineExecutor", () => {
  test("runs steps sequentially when no dependsOn", async () => {
    const order: string[] = [];
    const { pipeline } = setup([
      makeAgent("a", async () => {
        order.push("a");
        return { success: true, output: "result-a" };
      }),
      makeAgent("b", async () => {
        order.push("b");
        return { success: true, output: "result-b" };
      }),
    ]);

    const def: PipelineDefinition = {
      name: "test-pipeline",
      description: "test",
      steps: [
        { name: "step-1", agent: "a" },
        { name: "step-2", agent: "b" },
      ],
    };

    const run = await pipeline.runPipeline(def, {});

    expect(run.status).toBe("success");
    expect(order).toEqual(["a", "b"]);
    expect(run.steps).toHaveLength(2);
  });

  test("runs parallel steps with dependsOn", async () => {
    const startTimes: Record<string, number> = {};
    const { pipeline } = setup([
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

    const def: PipelineDefinition = {
      name: "parallel-pipeline",
      description: "test",
      steps: [
        { name: "step-a", agent: "slow-a", dependsOn: [] },
        { name: "step-b", agent: "slow-b", dependsOn: [] },
        { name: "step-c", agent: "combiner", dependsOn: ["step-a", "step-b"] },
      ],
    };

    const run = await pipeline.runPipeline(def, {});

    expect(run.status).toBe("success");
    expect(run.steps).toHaveLength(3);
    // step-c should start after both a and b
    expect(startTimes["c"]).toBeGreaterThanOrEqual(Math.max(startTimes["a"]!, startTimes["b"]!));
  });

  test("halts pipeline on step failure", async () => {
    const { pipeline } = setup([
      makeAgent("fail-agent", async () => {
        return { success: false, output: null, error: "step failed" };
      }),
      makeAgent("never-run", async () => {
        throw new Error("should not run");
      }),
    ]);

    const def: PipelineDefinition = {
      name: "failing-pipeline",
      description: "test",
      steps: [
        { name: "step-1", agent: "fail-agent" },
        { name: "step-2", agent: "never-run" },
      ],
    };

    const run = await pipeline.runPipeline(def, {});

    expect(run.status).toBe("error");
    expect(run.result?.error).toContain("step failed");
  });

  test("detects circular dependencies", () => {
    const { pipeline } = setup([]);

    expect(() => {
      pipeline.resolveExecutionOrder([
        { name: "a", agent: "x", dependsOn: ["b"] },
        { name: "b", agent: "x", dependsOn: ["a"] },
      ]);
    }).toThrow("Circular dependency");
  });

  test("resolves $input, $prev, $steps references", () => {
    const { pipeline } = setup([]);

    const resolved = pipeline.resolveStepInput(
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

  test("emits pipeline events", async () => {
    const events: string[] = [];
    const { pipeline, bus } = setup([
      makeAgent("ok", async () => ({ success: true, output: null })),
    ]);

    bus.on("pipeline:start", () => events.push("start"));
    bus.on("pipeline:step", () => events.push("step"));
    bus.on("pipeline:complete", () => events.push("complete"));

    const def: PipelineDefinition = {
      name: "event-test",
      description: "test",
      steps: [{ name: "step-1", agent: "ok" }],
    };

    await pipeline.runPipeline(def, {});

    expect(events).toContain("start");
    expect(events).toContain("step");
    expect(events).toContain("complete");
  });
});

// ── Wave 0 (orchestration-upgrade): pipeline events carry the initiating
//    userId so the SSE filter can scope delivery fail-closed. ──────────

describe("PipelineExecutor — pipeline:* userId scoping", () => {
  test("success path stamps userId on start/step/complete events", async () => {
    const { bus, pipeline } = setup([
      makeAgent("ok", async () => ({ success: true, output: "fine" })),
    ]);
    const seen: Array<{ type: string; userId?: string }> = [];
    bus.on("pipeline:start", (d) => seen.push({ type: "start", userId: d.userId }));
    bus.on("pipeline:step", (d) => seen.push({ type: "step", userId: d.userId }));
    bus.on("pipeline:complete", (d) => seen.push({ type: "complete", userId: d.userId }));

    const def: PipelineDefinition = {
      name: "scoped",
      description: "t",
      steps: [{ name: "s1", agent: "ok" }],
    };
    const run = await pipeline.runPipeline(def, {}, undefined, "user-42");

    expect(run.status).toBe("success");
    expect(seen.map((e) => e.type)).toEqual(["start", "step", "complete"]);
    for (const e of seen) expect(e.userId).toBe("user-42");
  });

  test("error path stamps userId on pipeline:error; CLI runs (no user) emit undefined", async () => {
    const { bus, pipeline } = setup([
      makeAgent("boom", async () => ({ success: false, output: null, error: "nope" })),
    ]);
    const errors: Array<string | undefined> = [];
    bus.on("pipeline:error", (d) => errors.push(d.userId));

    const def: PipelineDefinition = {
      name: "scoped-err",
      description: "t",
      steps: [{ name: "s1", agent: "boom" }],
    };

    const withUser = await pipeline.runPipeline(def, {}, undefined, "user-42");
    expect(withUser.status).toBe("error");
    const cli = await pipeline.runPipeline(def, {});
    expect(cli.status).toBe("error");

    expect(errors).toEqual(["user-42", undefined]);
  });
});

// ── Phase C1 (durability): abort propagation, sibling cancel on failure,
//    per-step retry, strict `$steps`/`$prev` refs. ─────────────────────

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

describe("PipelineExecutor — abort propagation (C1)", () => {
  test("aborting the pipeline cancels the in-flight step run and marks it cancelled", async () => {
    let aborted = false;
    const { bus, pipeline } = setup([
      blockingAgent("blocker", () => {
        aborted = true;
      }),
    ]);
    const def: PipelineDefinition = {
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
    const runPromise = pipeline.runPipeline(
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

  test("a signal already aborted before start cancels the pipeline without running steps", async () => {
    let ran = false;
    const { pipeline } = setup([
      makeAgent("never", async () => {
        ran = true;
        return { success: true, output: null };
      }),
    ]);
    const def: PipelineDefinition = {
      name: "pre-aborted",
      description: "t",
      steps: [{ name: "s1", agent: "never" }],
    };
    const controller = new AbortController();
    controller.abort();
    const run = await pipeline.runPipeline(
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

describe("PipelineExecutor — sibling cancel on failure (C1)", () => {
  test("a step failure cancels its still-running batch siblings and fails the pipeline", async () => {
    let siblingAborted = false;
    const { pipeline } = setup([
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
    const def: PipelineDefinition = {
      name: "sibling-cancel",
      description: "t",
      steps: [
        { name: "s-fail", agent: "failer", dependsOn: [] },
        { name: "s-block", agent: "sibling", dependsOn: [] },
        { name: "s-sink", agent: "sink", dependsOn: ["s-fail", "s-block"] },
      ],
    };

    const run = await pipeline.runPipeline(def, {});
    expect(run.status).toBe("error");
    expect(run.result?.error).toContain("boom");
    expect(siblingAborted).toBe(true);
    // The dependent batch-2 step never ran (only the two batch-1 siblings were pushed).
    expect(run.steps.map((s) => s.stepName).sort()).toEqual(["s-block", "s-fail"]);
  });
});

describe("PipelineExecutor — per-step retry (C1)", () => {
  test("retries a failing step up to its budget, then succeeds", async () => {
    let attempts = 0;
    const { pipeline } = setup([
      makeAgent("flaky", async () => {
        attempts++;
        return attempts < 3
          ? { success: false, output: null, error: "transient" }
          : { success: true, output: "ok" };
      }),
    ]);
    const def: PipelineDefinition = {
      name: "retry-ok",
      description: "t",
      steps: [{ name: "s1", agent: "flaky", retries: 2 }],
    };
    const run = await pipeline.runPipeline(def, {});
    expect(run.status).toBe("success");
    expect(attempts).toBe(3); // 1 initial + 2 retries
    expect(run.result?.output).toBe("ok");
  });

  test("fails the pipeline once the retry budget is exhausted", async () => {
    let attempts = 0;
    const { pipeline } = setup([
      makeAgent("always-fails", async () => {
        attempts++;
        return { success: false, output: null, error: "nope" };
      }),
    ]);
    const def: PipelineDefinition = {
      name: "retry-exhausted",
      description: "t",
      steps: [{ name: "s1", agent: "always-fails", retries: 1 }],
    };
    const run = await pipeline.runPipeline(def, {});
    expect(run.status).toBe("error");
    expect(attempts).toBe(2); // 1 initial + 1 retry
    expect(run.result?.error).toContain("nope");
  });

  test("clamps a retry budget above 2 down to 2 (max 3 attempts)", async () => {
    let attempts = 0;
    const { pipeline } = setup([
      makeAgent("f", async () => {
        attempts++;
        return { success: false, output: null, error: "x" };
      }),
    ]);
    const def: PipelineDefinition = {
      name: "retry-clamp-high",
      description: "t",
      steps: [{ name: "s1", agent: "f", retries: 5 }],
    };
    const run = await pipeline.runPipeline(def, {});
    expect(run.status).toBe("error");
    expect(attempts).toBe(3);
  });

  test("treats a negative retry budget as zero (single attempt)", async () => {
    let attempts = 0;
    const { pipeline } = setup([
      makeAgent("f", async () => {
        attempts++;
        return { success: false, output: null, error: "x" };
      }),
    ]);
    const def: PipelineDefinition = {
      name: "retry-clamp-neg",
      description: "t",
      steps: [{ name: "s1", agent: "f", retries: -1 }],
    };
    const run = await pipeline.runPipeline(def, {});
    expect(run.status).toBe("error");
    expect(attempts).toBe(1);
  });
});

describe("PipelineExecutor — strict `$steps` / `$prev` references (C1)", () => {
  test("a missing `$steps` reference fails the pipeline with a descriptive error", async () => {
    const { pipeline } = setup([
      makeAgent("a", async () => ({ success: true, output: "a" })),
    ]);
    const def: PipelineDefinition = {
      name: "bad-ref",
      description: "t",
      steps: [{ name: "s1", agent: "a", input: { x: "$steps.nope.output" } }],
    };
    const run = await pipeline.runPipeline(def, {});
    expect(run.status).toBe("error");
    expect(run.result?.error).toContain('step "nope" has not produced a result');
  });

  test("`$steps.NAME` without a field returns the whole step result", () => {
    const { pipeline } = setup([]);
    const resolved = pipeline.resolveStepInput(
      { whole: "$steps.s1" },
      {},
      new Map([["s1", { success: true, output: "o" }]]),
      undefined,
    );
    expect(resolved.whole).toEqual({ success: true, output: "o" });
  });

  test("throws when `$prev` has no previous step result", () => {
    const { pipeline } = setup([]);
    expect(() =>
      pipeline.resolveStepInput({ x: "$prev.output" }, {}, new Map(), undefined),
    ).toThrow(/no previous step/);
  });

  test("throws when a `$prev` field is missing on the previous result", () => {
    const { pipeline } = setup([]);
    expect(() =>
      pipeline.resolveStepInput(
        { x: "$prev.nope" },
        {},
        new Map(),
        { success: true, output: "o" },
      ),
    ).toThrow(/field "nope" is missing/);
  });

  test("throws when a `$steps` field is missing on the step result", () => {
    const { pipeline } = setup([]);
    expect(() =>
      pipeline.resolveStepInput(
        { x: "$steps.s1.nope" },
        {},
        new Map([["s1", { success: true, output: "o" }]]),
        undefined,
      ),
    ).toThrow(/field "nope" is missing/);
  });
});
