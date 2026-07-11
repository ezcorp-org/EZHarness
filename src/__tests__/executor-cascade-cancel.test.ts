/**
 * Parent→child cascade cancellation (Phase A1, the "Stop doesn't stop the
 * work" P1). Cancelling an orchestrator run must also cancel every
 * `invoke_agent` child it spawned, recursively, or those children keep
 * running and burning tokens after the user hit Stop.
 *
 * These tests exercise the REAL AgentExecutor: blocking agents stand in
 * for live sub-agent runs so `cancelRun` aborts real controllers and emits
 * the real terminal bus events. They prove:
 *   - a nested tree (parent → 2 children, one with a grandchild) all gets
 *     cancelled and emits one run:cancel each (the quota-releasing signal);
 *   - an already-terminal / unknown child is skipped without error;
 *   - the in-memory registry self-bounds on each run's terminal event and
 *     is fully cleared after a cascade;
 *   - a defensive registration cycle (A→B, B→A) does not infinite-loop.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import type { AgentDefinition, AgentEvents, AgentRun } from "../types";

// Mirror the watchdog/timer cleanup pattern from executor.test.ts so the
// orphan-cleanup interval + child-run listeners don't leak across files.
const executors: AgentExecutor[] = [];
function track(exec: AgentExecutor): AgentExecutor {
  executors.push(exec);
  return exec;
}
afterAll(() => {
  for (const exec of executors) exec.destroy();
  executors.length = 0;
});

/** An agent that blocks until its run is aborted, then throws — mirrors a
 *  live streaming sub-agent that unwinds on cancel. runAgent's catch keeps
 *  the status at "cancelled" (its !cancelled guard), so the promise
 *  resolves rather than rejects. */
function blockingAgent(name: string): AgentDefinition {
  return {
    name,
    description: `${name} agent`,
    capabilities: ["shell"],
    execute: async (ctx) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 60_000);
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      });
      return { success: true, output: null };
    },
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Minimal AgentRun shape for driving terminal bus events directly. */
function runShape(id: string): AgentRun {
  return { id, agentName: "sub", status: "running", startedAt: Date.now(), logs: [] };
}

describe("AgentExecutor — parent→child cascade cancel", () => {
  test("cancelRun on a parent cancels the whole spawn tree and emits run:cancel per run", async () => {
    const bus = new EventBus<AgentEvents>();
    const startedByName = new Map<string, string>();
    bus.on("run:start", ({ run }) => startedByName.set(run.agentName, run.id));
    const cancels: string[] = [];
    bus.on("run:cancel", ({ run }) => cancels.push(run.id));

    const exec = track(
      new AgentExecutor(
        loadAgentsStatic([
          blockingAgent("root"),
          blockingAgent("childA"),
          blockingAgent("childB"),
          blockingAgent("grand"),
        ]),
        bus,
      ),
    );

    const runs = [
      exec.runAgent("root", {}),
      exec.runAgent("childA", {}),
      exec.runAgent("childB", {}),
      exec.runAgent("grand", {}),
    ];
    await waitFor(() => startedByName.size === 4);
    const rootId = startedByName.get("root")!;
    const aId = startedByName.get("childA")!;
    const bId = startedByName.get("childB")!;
    const gId = startedByName.get("grand")!;

    // Tree: root → {childA, childB}; childA → {grand}.
    exec.registerChildRun(rootId, aId);
    exec.registerChildRun(rootId, bId);
    exec.registerChildRun(aId, gId);
    expect(exec.getRegisteredChildRunIds(rootId).sort()).toEqual([aId, bId].sort());
    expect(exec.getRegisteredChildRunIds(aId)).toEqual([gId]);

    // Cancel the root — return value is the SELF result (root existed).
    expect(exec.cancelRun(rootId)).toBe(true);
    await Promise.all(runs);

    // Every run in the tree is cancelled...
    for (const id of [rootId, aId, bId, gId]) {
      expect((await exec.getRun(id))!.status).toBe("cancelled");
    }
    // ...each emitted exactly ONE run:cancel (the quota-releasing signal).
    expect(cancels.sort()).toEqual([rootId, aId, bId, gId].sort());
    // ...and the registry is fully cleared (no lingering entries).
    expect(exec.getRegisteredChildRunIds(rootId)).toEqual([]);
    expect(exec.getRegisteredChildRunIds(aId)).toEqual([]);
  });

  test("an already-terminal / unknown child is skipped without error; entry cleared", async () => {
    const bus = new EventBus<AgentEvents>();
    const startedByName = new Map<string, string>();
    bus.on("run:start", ({ run }) => startedByName.set(run.agentName, run.id));
    const cancels: string[] = [];
    bus.on("run:cancel", ({ run }) => cancels.push(run.id));

    const exec = track(
      new AgentExecutor(
        loadAgentsStatic([blockingAgent("p"), blockingAgent("live")]),
        bus,
      ),
    );

    const runs = [exec.runAgent("p", {}), exec.runAgent("live", {})];
    await waitFor(() => startedByName.size === 2);
    const parentId = startedByName.get("p")!;
    const liveId = startedByName.get("live")!;

    exec.registerChildRun(parentId, liveId);
    // A child that is not (or no longer) a live run — cancelRunSelf returns
    // false for an unknown id, so it is a no-op (no throw, no run:cancel).
    exec.registerChildRun(parentId, "ghost-finished-id");

    expect(exec.cancelRun(parentId)).toBe(true);
    await Promise.all(runs);

    // Only the parent + the live child were cancelled; the ghost was skipped.
    expect(cancels.sort()).toEqual([parentId, liveId].sort());
    expect(cancels).not.toContain("ghost-finished-id");
    expect(exec.getRegisteredChildRunIds(parentId)).toEqual([]);
  });

  test("cancelRun returns false for an unknown id (pre-cascade contract preserved)", () => {
    const exec = track(new AgentExecutor(new Map(), new EventBus<AgentEvents>()));
    expect(exec.cancelRun("does-not-exist")).toBe(false);
  });

  test("cycle-safe: a defensive A→B, B→A registration does not infinite-loop", async () => {
    const bus = new EventBus<AgentEvents>();
    const startedByName = new Map<string, string>();
    bus.on("run:start", ({ run }) => startedByName.set(run.agentName, run.id));
    const cancels: string[] = [];
    bus.on("run:cancel", ({ run }) => cancels.push(run.id));

    const exec = track(
      new AgentExecutor(
        loadAgentsStatic([blockingAgent("cyA"), blockingAgent("cyB")]),
        bus,
      ),
    );

    const runs = [exec.runAgent("cyA", {}), exec.runAgent("cyB", {})];
    await waitFor(() => startedByName.size === 2);
    const aId = startedByName.get("cyA")!;
    const bId = startedByName.get("cyB")!;

    exec.registerChildRun(aId, bId);
    exec.registerChildRun(bId, aId); // defensive cycle

    // If the cascade weren't cycle-guarded this call would recurse forever
    // (stack overflow / hang); returning at all proves the guard holds.
    expect(exec.cancelRun(aId)).toBe(true);
    await Promise.all(runs);

    expect((await exec.getRun(aId))!.status).toBe("cancelled");
    expect((await exec.getRun(bId))!.status).toBe("cancelled");
    // Each run cancelled exactly once despite the cycle.
    expect(cancels.sort()).toEqual([aId, bId].sort());
  });
});

describe("AgentExecutor — child-run registry bounding", () => {
  test("a child's terminal event deregisters it; the empty parent set is dropped", () => {
    const bus = new EventBus<AgentEvents>();
    const exec = track(new AgentExecutor(new Map(), bus));

    exec.registerChildRun("P", "C1");
    exec.registerChildRun("P", "C2");
    expect(exec.getRegisteredChildRunIds("P").sort()).toEqual(["C1", "C2"]);

    // C1 completes → removed from P's set (size 2→1, P entry retained).
    bus.emit("run:complete", { run: runShape("C1"), conversationId: "c" });
    expect(exec.getRegisteredChildRunIds("P")).toEqual(["C2"]);

    // C2 errors → removed (size 1→0, whole P entry dropped so the map
    // can't grow unbounded across a long orchestrator run).
    bus.emit("run:error", { run: runShape("C2"), runId: "C2", error: "boom", conversationId: "c" });
    expect(exec.getRegisteredChildRunIds("P")).toEqual([]);
  });

  test("a parent's terminal event clears its entire children entry", () => {
    const bus = new EventBus<AgentEvents>();
    const exec = track(new AgentExecutor(new Map(), bus));

    exec.registerChildRun("P2", "X");
    exec.registerChildRun("P2", "Y");
    bus.emit("run:cancel", { run: runShape("P2"), conversationId: "c" });
    expect(exec.getRegisteredChildRunIds("P2")).toEqual([]);
  });

  test("destroy() clears the registry", () => {
    const exec = new AgentExecutor(new Map(), new EventBus<AgentEvents>());
    exec.registerChildRun("PA", "CA");
    expect(exec.getRegisteredChildRunIds("PA")).toEqual(["CA"]);
    exec.destroy();
    expect(exec.getRegisteredChildRunIds("PA")).toEqual([]);
  });
});
