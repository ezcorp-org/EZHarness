import { test, expect, describe } from "bun:test";
import { recoverRuns } from "./recovery";
import { PIPELINE_STEPS } from "./config";
import { emptyFindings } from "./runs";
import type { RunRecord, RunStatus, RunStore, StepResultRecord, StepStatus } from "./runs";

// ── in-memory store (the recovery-relevant methods) ─────────────────

function memStore(): RunStore & { runs: Map<string, RunRecord>; steps: Map<string, StepResultRecord> } {
  const runs = new Map<string, RunRecord>();
  const steps = new Map<string, StepResultRecord>();
  const store = {
    runs,
    steps,
    async listRuns() {
      return [...runs.values()];
    },
    async getRun(id: string) {
      return runs.get(id) ?? null;
    },
    async getStepResult(runId: string, step: string) {
      return steps.get(`${runId}/${step}`) ?? null;
    },
    async updateRun(id: string, patch: Partial<RunRecord>) {
      const cur = runs.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updatedAt: "t2" };
      runs.set(id, next);
      return next;
    },
    async createRun() {},
    async putStepResult() {},
    async appendStepRound() {},
    async getStepRounds() {
      return [];
    },
    async patchLastStepRound() {},
  };
  return store as unknown as RunStore & { runs: Map<string, RunRecord>; steps: Map<string, StepResultRecord> };
}

function mkRun(id: string, status: RunStatus, worktreePath: string | null): RunRecord {
  return {
    id,
    repoId: "0123456789ab",
    branch: "feat/x",
    ref: "refs/heads/feat/x",
    headSha: "abc",
    baseSha: "0".repeat(40),
    status,
    worktreePath,
    createdAt: "t",
    updatedAt: "t",
    parkedMs: 0,
    awaitingAgentSince: status === "awaiting_approval" ? "t" : null,
    intent: null,
    intentSource: null,
  };
}

function stepRow(runId: string, step: string, status: StepStatus): StepResultRecord {
  return {
    runId,
    step,
    status,
    findings: emptyFindings(),
    agentPid: null,
    autoFixLimit: 0,
    round: 1,
    autoFixAttempts: 0,
    executionMs: 0,
    fixSummary: null,
  };
}

/** Seed a run + its step statuses into the store. */
function seed(
  store: ReturnType<typeof memStore>,
  run: RunRecord,
  stepStatuses: Partial<Record<string, StepStatus>>,
): void {
  store.runs.set(run.id, run);
  for (const [step, status] of Object.entries(stepStatuses)) {
    store.steps.set(`${run.id}/${step}`, stepRow(run.id, step, status!));
  }
}

describe("recoverRuns", () => {
  test("recovers a cleanly-parked run (invariant held) and KEEPS its worktree", async () => {
    const store = memStore();
    seed(store, mkRun("parked", "awaiting_approval", "/wt/parked"), {
      intent: "completed",
      rebase: "completed",
      review: "awaiting_approval",
    });
    const reaped: string[] = [];
    const summary = await recoverRuns({
      store,
      reapWorktree: async (r) => {
        reaped.push(r.id);
      },
    });
    expect(summary).toEqual({ recovered: 1, failedClosed: 0, reaped: 0 });
    expect(reaped).toEqual([]); // a live parked run's worktree is never touched
    expect(store.runs.get("parked")!.status).toBe("awaiting_approval");
    expect(store.runs.get("parked")!.worktreePath).toBe("/wt/parked");
  });

  test("recovers a checks_passed run (all prior steps done, ci parked)", async () => {
    const store = memStore();
    const priorDone: Record<string, StepStatus> = {};
    for (const s of PIPELINE_STEPS) priorDone[s] = s === "ci" ? "awaiting_approval" : "completed";
    seed(store, mkRun("green", "checks_passed", "/wt/green"), priorDone);
    const summary = await recoverRuns({ store, reapWorktree: async () => {} });
    expect(summary.recovered).toBe(1);
    expect(summary.failedClosed).toBe(0);
  });

  test("fails closed a parked run with NO gate row recorded (half-recorded)", async () => {
    const store = memStore();
    // Parked status but every step completed → no parked step row.
    seed(store, mkRun("halfrec", "awaiting_approval", "/wt/half"), {
      intent: "completed",
      rebase: "completed",
    });
    const reaped: string[] = [];
    const summary = await recoverRuns({
      store,
      reapWorktree: async (r) => {
        reaped.push(r.id);
      },
    });
    expect(summary).toEqual({ recovered: 0, failedClosed: 1, reaped: 1 });
    expect(store.runs.get("halfrec")!.status).toBe("failed");
    expect(store.runs.get("halfrec")!.error).toContain("no gate row recorded");
    expect(reaped).toEqual(["halfrec"]);
    expect(store.runs.get("halfrec")!.worktreePath).toBeNull(); // reaped → nulled
  });

  test("fails closed a parked run with a GAP in the prior steps", async () => {
    const store = memStore();
    seed(store, mkRun("gap", "awaiting_approval", "/wt/gap"), {
      intent: "completed",
      rebase: "pending", // gap: rebase not completed before the parked review
      review: "awaiting_approval",
    });
    const summary = await recoverRuns({ store, reapWorktree: async () => {} });
    expect(summary.failedClosed).toBe(1);
    expect(store.runs.get("gap")!.error).toContain("prior step 'rebase'");
  });

  test("fails closed a mid-flight run (running) and reaps its worktree", async () => {
    const store = memStore();
    seed(store, mkRun("mid", "running", "/wt/mid"), { intent: "completed", rebase: "running" });
    const reaped: string[] = [];
    const summary = await recoverRuns({
      store,
      reapWorktree: async (r) => {
        reaped.push(r.id);
      },
    });
    expect(summary).toEqual({ recovered: 0, failedClosed: 1, reaped: 1 });
    expect(store.runs.get("mid")!.status).toBe("failed");
    expect(store.runs.get("mid")!.error).toContain("interrupted mid-pipeline");
    expect(reaped).toEqual(["mid"]);
  });

  test("leaves a stalled run as-is — no fail-close, no reap, worktree kept", async () => {
    const store = memStore();
    // Non-terminal + not awaiting_approval/checks_passed → would fall into the
    // mid-flight fail-close without the explicit passthrough branch (L3).
    seed(store, mkRun("stuck", "stalled", "/wt/stuck"), { intent: "completed", rebase: "running" });
    const reaped: string[] = [];
    const logs: string[] = [];
    const summary = await recoverRuns({
      store,
      reapWorktree: async (r) => {
        reaped.push(r.id);
      },
      log: (m) => logs.push(m),
    });
    expect(summary).toEqual({ recovered: 0, failedClosed: 0, reaped: 0 });
    expect(store.runs.get("stuck")!.status).toBe("stalled"); // untouched
    expect(store.runs.get("stuck")!.worktreePath).toBe("/wt/stuck"); // kept
    expect(reaped).toEqual([]);
    expect(logs.some((l) => l.includes("left stalled run stuck as-is"))).toBe(true);
  });

  test("reaps a terminal run's ORPHANED worktree and nulls the path", async () => {
    const store = memStore();
    seed(store, mkRun("done", "completed", "/wt/done"), {});
    const reaped: string[] = [];
    const summary = await recoverRuns({
      store,
      reapWorktree: async (r) => {
        reaped.push(r.id);
      },
    });
    expect(summary).toEqual({ recovered: 0, failedClosed: 0, reaped: 1 });
    expect(reaped).toEqual(["done"]);
    expect(store.runs.get("done")!.worktreePath).toBeNull();
  });

  test("does NOT reap a terminal run with no worktree", async () => {
    const store = memStore();
    seed(store, mkRun("clean", "completed", null), {});
    let calls = 0;
    const summary = await recoverRuns({
      store,
      reapWorktree: async () => {
        calls++;
      },
    });
    expect(calls).toBe(0);
    expect(summary.reaped).toBe(0);
  });

  test("swallows a reap THROW (best-effort) and still nulls the path + logs", async () => {
    const store = memStore();
    seed(store, mkRun("boom", "failed", "/wt/boom"), {});
    const logs: string[] = [];
    const summary = await recoverRuns({
      store,
      reapWorktree: async () => {
        throw new Error("worktree remove failed");
      },
      log: (m) => logs.push(m),
    });
    expect(summary.reaped).toBe(1);
    expect(store.runs.get("boom")!.worktreePath).toBeNull();
    expect(logs.some((l) => l.includes("reap failed for run boom"))).toBe(true);
  });

  test("logs a final summary line", async () => {
    const store = memStore();
    seed(store, mkRun("done", "completed", null), {});
    const logs: string[] = [];
    await recoverRuns({ store, reapWorktree: async () => {}, log: (m) => logs.push(m) });
    expect(logs.some((l) => l.startsWith("crash recovery:"))).toBe(true);
  });
});
