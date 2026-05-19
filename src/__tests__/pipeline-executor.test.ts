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
