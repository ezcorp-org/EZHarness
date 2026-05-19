import { test, expect, describe } from "bun:test";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import type { AgentDefinition, AgentEvents, AgentRun } from "../types";

function makeAgent(
  name: string,
  fn: AgentDefinition["execute"],
): AgentDefinition {
  return {
    name,
    description: `${name} agent`,
    capabilities: ["shell"],
    execute: fn,
  };
}

// Seam: `runs` and `runConversations` are private Maps only populated by the
// streamChat/DB/LLM path. To exercise filter+sort logic without standing up a
// DB we reach in via `as any` — same pragmatic choice documented in
// executor-active-run.test.ts.
function seedRun(
  exec: AgentExecutor,
  run: AgentRun,
  conversationId: string,
): void {
  (exec as any).runs.set(run.id, run);
  (exec as any).runConversations.set(run.id, conversationId);
}

function makeRun(partial: Partial<AgentRun> & { id: string }): AgentRun {
  return {
    id: partial.id,
    agentName: partial.agentName ?? "x",
    projectId: partial.projectId,
    status: partial.status ?? "running",
    startedAt: partial.startedAt ?? Date.now(),
    finishedAt: partial.finishedAt,
    logs: partial.logs ?? [],
    result: partial.result,
  };
}

describe("AgentExecutor.listActiveAgentRuns", () => {
  test("returns [] when no runs exist", () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus);

    expect(exec.listActiveAgentRuns()).toEqual([]);
  });

  test("returns running run with its conversationId", () => {
    const agents = loadAgentsStatic([
      makeAgent("x", async () => ({ success: true, output: null })),
    ]);
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(agents, bus);

    const run = makeRun({ id: "r1", status: "running", startedAt: 100 });
    seedRun(exec, run, "conv-1");

    const result = exec.listActiveAgentRuns();
    expect(result).toHaveLength(1);
    expect(result[0]!.run.id).toBe("r1");
    expect(result[0]!.conversationId).toBe("conv-1");
  });

  test("excludes non-running runs even if in runConversations", () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus);

    seedRun(exec, makeRun({ id: "r-ok", status: "success", startedAt: 100 }), "conv-a");
    seedRun(exec, makeRun({ id: "r-fail", status: "error", startedAt: 200 }), "conv-b");
    seedRun(exec, makeRun({ id: "r-live", status: "running", startedAt: 300 }), "conv-c");

    const result = exec.listActiveAgentRuns();
    expect(result).toHaveLength(1);
    expect(result[0]!.run.id).toBe("r-live");
  });

  test("filters by projectId when provided", () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus);

    seedRun(exec, makeRun({ id: "r-p1", status: "running", projectId: "p1", startedAt: 100 }), "c1");
    seedRun(exec, makeRun({ id: "r-p2", status: "running", projectId: "p2", startedAt: 200 }), "c2");
    seedRun(exec, makeRun({ id: "r-none", status: "running", startedAt: 300 }), "c3");

    const result = exec.listActiveAgentRuns("p1");
    expect(result).toHaveLength(1);
    expect(result[0]!.run.id).toBe("r-p1");
    expect(result[0]!.conversationId).toBe("c1");
  });

  test("sorts descending by startedAt", () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus);

    seedRun(exec, makeRun({ id: "old", status: "running", startedAt: 100 }), "c-old");
    seedRun(exec, makeRun({ id: "new", status: "running", startedAt: 300 }), "c-new");
    seedRun(exec, makeRun({ id: "mid", status: "running", startedAt: 200 }), "c-mid");

    const ids = exec.listActiveAgentRuns().map(r => r.run.id);
    expect(ids).toEqual(["new", "mid", "old"]);
  });
});
