/**
 * Runs the three shipped demo workflows (src/agents/*.workflow.yaml) through
 * the real loader + executor to prove they are valid and behave as documented:
 *   - demo-deterministic reproduces byte-identical output across two runs,
 *   - demo-loop-counter reports iterations: 3 and fails loudly when its
 *     until-condition is made unreachable,
 *   - demo-mixed chains agent → transform → gate (agent mocked via the harness).
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "node:path";
import { WorkflowExecutor } from "../runtime/workflow-executor";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import { loadYamlWorkflows } from "../runtime/workflow-loader";
import type { AgentDefinition, AgentEvents, WorkflowDefinition } from "../types";

const agentsDir = join(import.meta.dir, "../agents");

function fakeSummarizer(): AgentDefinition {
  return {
    name: "summarizer",
    description: "fake summarizer",
    capabilities: ["llm"],
    execute: async (ctx) => ({
      success: true,
      output: { summary: `SUMMARY(${(ctx.input as Record<string, unknown>).text})` },
    }),
  };
}

function executorWith(agents: AgentDefinition[]) {
  const bus = new EventBus<AgentEvents>();
  const executor = new AgentExecutor(loadAgentsStatic(agents), bus);
  return new WorkflowExecutor(executor, bus);
}

let demos: WorkflowDefinition[];
function demo(name: string): WorkflowDefinition {
  const d = demos.find((w) => w.name === name);
  if (!d) throw new Error(`demo workflow "${name}" not loaded`);
  return d;
}

describe("shipped demo workflows", () => {
  beforeAll(async () => {
    demos = await loadYamlWorkflows(agentsDir);
  });

  test("all three demos load and pass definition-time validation", () => {
    for (const name of ["demo-deterministic", "demo-loop-counter", "demo-mixed"]) {
      expect(demos.find((w) => w.name === name)).toBeDefined();
    }
  });

  test("demo-deterministic reshapes + gates and is reproducible", async () => {
    const wf = executorWith([]);
    const a = await wf.runWorkflow(demo("demo-deterministic"), { topic: "workflows" });
    const b = await wf.runWorkflow(demo("demo-deterministic"), { topic: "workflows" });
    expect(a.status).toBe("success");
    expect(b.status).toBe("success");
    // Gate is the last step ⇒ the run result is { passed: true }.
    expect(a.result?.output).toEqual({ passed: true });
    // Determinism: the whole run result is byte-identical across two runs of
    // the same input (a transform/gate-only workflow is a pure function — no
    // LLM, no I/O, no clock).
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result));
    // The intermediate compose step is present and byte-identical too.
    const composeA = a.steps.find((s) => s.stepName === "compose");
    const composeB = b.steps.find((s) => s.stepName === "compose");
    expect(composeA).toBeDefined();
    expect(composeB).toBeDefined();
    expect(JSON.stringify(composeA)).toBe(JSON.stringify(composeB));
  });

  test("demo-loop-counter counts to 3 by default", async () => {
    const wf = executorWith([]);
    const run = await wf.runWorkflow(demo("demo-loop-counter"), {});
    expect(run.status).toBe("success");
    const count = run.steps.find((s) => s.stepName === "count");
    expect(count?.iterations).toBe(3);
    expect(run.result?.output).toMatchObject({ n: 3, previous: 2 });
  });

  test("demo-loop-counter fails loudly when neverStop makes the until unreachable", async () => {
    const wf = executorWith([]);
    const run = await wf.runWorkflow(demo("demo-loop-counter"), { neverStop: true });
    expect(run.status).toBe("error");
    expect(run.result?.error).toContain(
      'Step "count" exhausted 5 iterations without meeting its until-condition',
    );
  });

  test("demo-mixed chains agent → transform → gate", async () => {
    const wf = executorWith([fakeSummarizer()]);
    const run = await wf.runWorkflow(demo("demo-mixed"), { text: "hello world" });
    expect(run.status).toBe("success");
    expect(run.result?.output).toEqual({ passed: true });
    const reshape = run.steps.find((s) => s.stepName === "reshape");
    expect(reshape?.status).toBe("success");
  });
});
