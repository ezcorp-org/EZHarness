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

/** Start a blocking parent run on a fresh executor and resolve its id.
 *  Used by the registry tests below — registerChildRun's liveness gate
 *  (validator-a1 MED fix) only registers under a RUNNING parent, so the
 *  synthetic-id parents these tests originally used are no longer
 *  registrable. */
async function startBlockingRun(
  exec: AgentExecutor,
  bus: EventBus<AgentEvents>,
  name: string,
): Promise<{ id: string; done: Promise<unknown> }> {
  const started = new Map<string, string>();
  const off = bus.on("run:start", ({ run }) => started.set(run.agentName, run.id));
  const done = exec.runAgent(name, {});
  await waitFor(() => started.has(name));
  off();
  return { id: started.get(name)!, done };
}

describe("AgentExecutor — child-run registry bounding", () => {
  test("a child's terminal event deregisters it; the empty parent set is dropped", async () => {
    const bus = new EventBus<AgentEvents>();
    const exec = track(new AgentExecutor(loadAgentsStatic([blockingAgent("p-bound")]), bus));
    const parent = await startBlockingRun(exec, bus, "p-bound");

    exec.registerChildRun(parent.id, "C1");
    exec.registerChildRun(parent.id, "C2");
    expect(exec.getRegisteredChildRunIds(parent.id).sort()).toEqual(["C1", "C2"]);

    // C1 completes → removed from the set (size 2→1, entry retained).
    bus.emit("run:complete", { run: runShape("C1"), conversationId: "c" });
    expect(exec.getRegisteredChildRunIds(parent.id)).toEqual(["C2"]);

    // C2 errors → removed (size 1→0, whole entry dropped so the map
    // can't grow unbounded across a long orchestrator run).
    bus.emit("run:error", { run: runShape("C2"), runId: "C2", error: "boom", conversationId: "c" });
    expect(exec.getRegisteredChildRunIds(parent.id)).toEqual([]);

    exec.cancelRun(parent.id);
    await parent.done;
  });

  test("a parent's terminal event clears its entire children entry", async () => {
    const bus = new EventBus<AgentEvents>();
    const exec = track(new AgentExecutor(loadAgentsStatic([blockingAgent("p-clear")]), bus));
    const parent = await startBlockingRun(exec, bus, "p-clear");

    exec.registerChildRun(parent.id, "X");
    exec.registerChildRun(parent.id, "Y");
    exec.cancelRun(parent.id);
    await parent.done;
    expect(exec.getRegisteredChildRunIds(parent.id)).toEqual([]);
  });

  test("destroy() clears the registry", async () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(loadAgentsStatic([blockingAgent("p-destroy")]), bus);
    const parent = await startBlockingRun(exec, bus, "p-destroy");
    exec.registerChildRun(parent.id, "CA");
    expect(exec.getRegisteredChildRunIds(parent.id)).toEqual(["CA"]);
    exec.destroy();
    expect(exec.getRegisteredChildRunIds(parent.id)).toEqual([]);
    await parent.done;
  });
});

// ── Validator-a1 fixes: liveness gate + orphan cascade on abnormal parent
//    terminals ─────────────────────────────────────────────────────────

describe("AgentExecutor — registerChildRun liveness gate (dead-parent race)", () => {
  test("registers under a RUNNING parent (true); refuses unknown and terminal parents (false, nothing registered)", async () => {
    const bus = new EventBus<AgentEvents>();
    const exec = track(new AgentExecutor(loadAgentsStatic([blockingAgent("gate-p")]), bus));

    // Unknown parent → refused.
    expect(exec.registerChildRun("never-existed", "c0")).toBe(false);
    expect(exec.getRegisteredChildRunIds("never-existed")).toEqual([]);

    // Running parent → accepted.
    const parent = await startBlockingRun(exec, bus, "gate-p");
    expect(exec.registerChildRun(parent.id, "c1")).toBe(true);
    expect(exec.getRegisteredChildRunIds(parent.id)).toEqual(["c1"]);

    // Cancelled (terminal) parent → refused; the Stop-races-spawn window
    // can no longer produce an ownerless streaming child.
    exec.cancelRun(parent.id);
    await parent.done;
    expect(exec.registerChildRun(parent.id, "c2")).toBe(false);
    expect(exec.getRegisteredChildRunIds(parent.id)).toEqual([]);
  });
});

describe("AgentExecutor — orphan cascade on abnormal parent terminals", () => {
  test("parent run:error (watchdog-trip seam) cancels registered children instead of just dropping them", async () => {
    const bus = new EventBus<AgentEvents>();
    const exec = track(
      new AgentExecutor(
        loadAgentsStatic([blockingAgent("err-parent"), blockingAgent("err-child")]),
        bus,
      ),
    );
    const parent = await startBlockingRun(exec, bus, "err-parent");
    const child = await startBlockingRun(exec, bus, "err-child");
    expect(exec.registerChildRun(parent.id, child.id)).toBe(true);

    // Simulate the watchdog trip / finalizeError seam: they emit run:error
    // for the parent WITHOUT calling cancelRun. The executor's terminal
    // listener must cascade-cancel the child, not orphan it.
    bus.emit("run:error", {
      run: { ...runShape(parent.id), status: "error" },
      runId: parent.id,
      error: "watchdog kill",
      conversationId: "c",
    });

    await child.done;
    expect((await exec.getRun(child.id))!.status).toBe("cancelled");
    expect(exec.getRegisteredChildRunIds(parent.id)).toEqual([]);

    exec.cancelRun(parent.id); // tidy the still-blocked parent agent
    await parent.done;
  });

  test("parent run:complete does NOT cascade — children survive a clean parent completion (future background mode)", async () => {
    const bus = new EventBus<AgentEvents>();
    const exec = track(
      new AgentExecutor(
        loadAgentsStatic([blockingAgent("done-parent"), blockingAgent("done-child")]),
        bus,
      ),
    );
    const parent = await startBlockingRun(exec, bus, "done-parent");
    const child = await startBlockingRun(exec, bus, "done-child");
    expect(exec.registerChildRun(parent.id, child.id)).toBe(true);

    bus.emit("run:complete", { run: { ...runShape(parent.id), status: "success" }, conversationId: "c" });

    // Child untouched (still running); registry entry dropped.
    expect((await exec.getRun(child.id))!.status).toBe("running");
    expect(exec.getRegisteredChildRunIds(parent.id)).toEqual([]);

    exec.cancelRun(parent.id);
    exec.cancelRun(child.id);
    await Promise.all([parent.done, child.done]);
  });
});
