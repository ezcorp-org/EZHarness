import { test, expect, describe } from "bun:test";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { dequeue, enqueue, hasPending } from "../runtime/pending-messages";
import type { AgentEvents, AgentRun } from "../types";

// Stub of pi's Agent exposing the steer queue + the subscribe seam
// steerConversation uses. `emitEvent` simulates pi's runLoop draining a steer
// (which emits `message_start` carrying the exact injected object) or any other
// Agent event, without a real streamChat run / LLM.
class StubAgent {
  readonly queue: unknown[] = [];
  private listeners = new Set<(event: unknown) => void>();
  steer(message: unknown): void {
    this.queue.push(message);
  }
  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Test helper: deliver an Agent event to every current subscriber. */
  emitEvent(event: unknown): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  /** Test helper: how many delivery-listeners are still attached. */
  listenerCount(): number {
    return this.listeners.size;
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

/** The exact UserMessage object handed to the stub's steer queue (identity
 *  key for pi's delivery `message_start`). */
function steered(agent: StubAgent, i = 0): unknown {
  return agent.queue[i];
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

  test("preserves enqueue order across multiple steers", () => {
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

  // ── P2 shadow-track: delivered vs dropped at the run's terminal ──────

  test("delivered steer (message_start observed) is NOT re-offered on run:complete", () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus);
    const agent = new StubAgent();
    const run = makeRun({ id: "r1" });
    seed(exec, run, "conv-1", agent);

    let undelivered = 0;
    exec.steerConversation("conv-1", "hi", () => { undelivered++; });
    // pi drains the steer → emits message_start carrying the exact object.
    agent.emitEvent({ type: "message_start", message: steered(agent) });
    bus.emit("run:complete", { run } as AgentEvents["run:complete"]);

    expect(undelivered).toBe(0); // no double-delivery
  });

  test("undelivered steer is re-enqueued on run:complete and drainable by branch (1)", () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus);
    const agent = new StubAgent();
    const run = makeRun({ id: "r1" });
    const conv = "conv-p2-reenqueue";
    seed(exec, run, conv, agent);

    // The route's real fallback: re-enqueue to the pending-messages mailbox.
    const pending = { messageId: "m1", content: "hi", createdAt: "2026-07-11T00:00:00.000Z" };
    exec.steerConversation(conv, "hi", () => enqueue(conv, pending));
    // No message_start → the steer was never delivered before the run ended.
    bus.emit("run:complete", { run } as AgentEvents["run:complete"]);

    expect(hasPending(conv)).toBe(true);
    // Branch (1) drains via dequeue — prove the re-enqueued message is exactly it.
    expect(dequeue(conv)).toEqual(pending);
    expect(hasPending(conv)).toBe(false);
  });

  test("steer dropped on run:cancel is re-offered (cancel mid-run)", () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus);
    const agent = new StubAgent();
    const run = makeRun({ id: "r1" });
    seed(exec, run, "conv-1", agent);

    let undelivered = 0;
    exec.steerConversation("conv-1", "hi", () => { undelivered++; });
    bus.emit("run:cancel", { run } as AgentEvents["run:cancel"]);

    expect(undelivered).toBe(1);
  });

  test("steer dropped on run:error is re-offered", () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus);
    const agent = new StubAgent();
    const run = makeRun({ id: "r1" });
    seed(exec, run, "conv-1", agent);

    let undelivered = 0;
    exec.steerConversation("conv-1", "hi", () => { undelivered++; });
    bus.emit("run:error", { run } as AgentEvents["run:error"]);

    expect(undelivered).toBe(1);
  });

  test("only the undelivered steer is re-offered when multiple are queued", () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus);
    const agent = new StubAgent();
    const run = makeRun({ id: "r1" });
    seed(exec, run, "conv-1", agent);

    let firstDropped = 0;
    let secondDropped = 0;
    exec.steerConversation("conv-1", "first", () => { firstDropped++; });
    exec.steerConversation("conv-1", "second", () => { secondDropped++; });
    // Only the FIRST steer is drained/delivered.
    agent.emitEvent({ type: "message_start", message: steered(agent, 0) });
    bus.emit("run:complete", { run } as AgentEvents["run:complete"]);

    expect(firstDropped).toBe(0);
    expect(secondDropped).toBe(1);
  });

  test("a non-matching event never marks the steer delivered", () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus);
    const agent = new StubAgent();
    const run = makeRun({ id: "r1" });
    seed(exec, run, "conv-1", agent);

    let undelivered = 0;
    exec.steerConversation("conv-1", "hi", () => { undelivered++; });
    // Wrong type, and a message_start for a DIFFERENT object (e.g. the prompt).
    agent.emitEvent({ type: "turn_start" });
    agent.emitEvent({ type: "message_start", message: { role: "user", content: "other", timestamp: 1 } });
    bus.emit("run:complete", { run } as AgentEvents["run:complete"]);

    expect(undelivered).toBe(1);
  });

  test("a second terminal event for the same run is a no-op", () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus);
    const agent = new StubAgent();
    const run = makeRun({ id: "r1" });
    seed(exec, run, "conv-1", agent);

    let undelivered = 0;
    exec.steerConversation("conv-1", "hi", () => { undelivered++; });
    bus.emit("run:complete", { run } as AgentEvents["run:complete"]);
    bus.emit("run:complete", { run } as AgentEvents["run:complete"]);

    expect(undelivered).toBe(1); // fired once, not twice
  });

  test("delivered-then-failover-swapped steer is re-offered (delivered to a discarded attempt)", () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus);
    const attempt1 = new StubAgent();
    const run = makeRun({ id: "r1" });
    seed(exec, run, "conv-1", attempt1);

    let undelivered = 0;
    exec.steerConversation("conv-1", "hi", () => { undelivered++; });
    // Drained on attempt-1's loop-start poll → message_start fires (delivered).
    // But a user-message injection doesn't set emittedToClient, so a
    // pre-first-token failure fails over: the run's live Agent is swapped to
    // attempt-2, whose context (rebuilt from DB) never held the steer.
    attempt1.emitEvent({ type: "message_start", message: steered(attempt1) });
    const attempt2 = new StubAgent();
    (exec as any).activeAgents.set("r1", attempt2);
    bus.emit("run:complete", { run } as AgentEvents["run:complete"]);

    expect(undelivered).toBe(1); // delivered to a since-discarded instance → re-offered
  });

  test("destroy() detaches steer delivery-listeners and does NOT re-offer", () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus);
    const agent = new StubAgent();
    seed(exec, makeRun({ id: "r1" }), "conv-1", agent);

    let undelivered = 0;
    exec.steerConversation("conv-1", "hi", () => { undelivered++; });
    expect(agent.listenerCount()).toBe(1);

    exec.destroy();

    expect(agent.listenerCount()).toBe(0); // listener detached, no leak
    expect(undelivered).toBe(0); // in-memory mailbox dies with the process
  });
});
