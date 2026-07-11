import { test, expect, describe } from "bun:test";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";

// Minimal stub of pi's Agent exposing only the steer queue the P1 plumbing
// touches. steerConversation resolves activeAgents by reference, so seeding a
// stub into the private map exercises the queue path without a real streamChat
// run / LLM.
class StubAgent {
  readonly queue: unknown[] = [];
  steer(message: unknown): void {
    this.queue.push(message);
  }
}

function makeRun(partial: Partial<AgentRun> & { id: string }): AgentRun {
  return {
    id: partial.id,
    agentName: partial.agentName ?? "chat",
    projectId: partial.projectId,
    status: partial.status ?? "running",
    startedAt: partial.startedAt ?? Date.now(),
    finishedAt: partial.finishedAt,
    logs: partial.logs ?? [],
    result: partial.result,
  };
}

// Seam mirrors executor-list-active-agent-runs.test.ts: the run-tracking maps
// (`runs`, `runConversations`, `activeAgents`) are private and only populated
// by the streamChat/DB/LLM path, so we reach in via `as any` to seed a live
// run and its Agent instance.
function seed(
  exec: AgentExecutor,
  run: AgentRun,
  conversationId: string,
  agent?: StubAgent,
): void {
  (exec as any).runs.set(run.id, run);
  (exec as any).runConversations.set(run.id, conversationId);
  if (agent) (exec as any).activeAgents.set(run.id, agent);
}

describe("AgentExecutor.steerConversation", () => {
  test("steers a UserMessage into the live agent's queue and returns steered+runId", () => {
    const exec = new AgentExecutor(new Map(), new EventBus<AgentEvents>());
    const agent = new StubAgent();
    seed(exec, makeRun({ id: "r1" }), "conv-1", agent);

    const result = exec.steerConversation("conv-1", "hello");

    expect(result).toEqual({ status: "steered", runId: "r1" });
    expect(agent.queue).toHaveLength(1);
    // Converted to a pi UserMessage: role "user", string content, real timestamp.
    expect(agent.queue[0]).toMatchObject({ role: "user", content: "hello" });
    expect((agent.queue[0] as { timestamp: number }).timestamp).toBeGreaterThan(0);
  });

  test("preserves drain order across multiple steers", () => {
    const exec = new AgentExecutor(new Map(), new EventBus<AgentEvents>());
    const agent = new StubAgent();
    seed(exec, makeRun({ id: "r1" }), "conv-1", agent);

    exec.steerConversation("conv-1", "first");
    exec.steerConversation("conv-1", "second");

    expect(agent.queue.map((m) => (m as { content: string }).content)).toEqual([
      "first",
      "second",
    ]);
  });

  test("returns no-live-run when no run owns the conversation", () => {
    const exec = new AgentExecutor(new Map(), new EventBus<AgentEvents>());

    expect(exec.steerConversation("conv-absent", "hi")).toEqual({ status: "no-live-run" });
  });

  test("returns no-live-run (not a throw) when the only run for the conversation is terminal", () => {
    const exec = new AgentExecutor(new Map(), new EventBus<AgentEvents>());
    const agent = new StubAgent();
    // Run tracked for the conversation but already cancelled — the terminal-run
    // race. getActiveRunForConversation matches only `status === "running"`, so
    // this must degrade to no-live-run rather than steer into a dead run.
    seed(exec, makeRun({ id: "r1", status: "cancelled" }), "conv-1", agent);

    const result = exec.steerConversation("conv-1", "hi");

    expect(result).toEqual({ status: "no-live-run" });
    expect(agent.queue).toHaveLength(0);
  });

  test("returns no-agent when the run is live but no Agent instance is registered", () => {
    const exec = new AgentExecutor(new Map(), new EventBus<AgentEvents>());
    // Live run, but no activeAgents entry — the pre-first-token window before
    // failover.ts:220 registers the first built Agent.
    seed(exec, makeRun({ id: "r1", status: "running" }), "conv-1");

    expect(exec.steerConversation("conv-1", "hi")).toEqual({ status: "no-agent", runId: "r1" });
  });
});
