import { test, expect, describe } from "bun:test";
import {
  reconcileSweep,
  RECONCILABLE_STATUSES,
  DEFAULT_MAX_PER_SWEEP,
  SWEEP_CRON,
  SWEEP_HEARTBEAT_KEY,
  type ReconcileResult,
  type SweepHeartbeat,
} from "./sweep";
import type { RunRecord, RunStatus, RunStore } from "./runs";

function run(id: string, status: RunStatus): RunRecord {
  return {
    id,
    repoId: "0123456789ab",
    branch: "feat/x",
    ref: "refs/heads/feat/x",
    headSha: "abc",
    baseSha: "0".repeat(40),
    status,
    worktreePath: null,
    createdAt: "t",
    updatedAt: "t",
    parkedMs: 0,
    awaitingAgentSince: null,
    intent: null,
    intentSource: null,
  };
}

/** A store whose only meaningful method is listRuns. */
function fakeStore(runs: RunRecord[]): RunStore {
  return { async listRuns() { return runs; } } as unknown as RunStore;
}

describe("constants", () => {
  test("reconciles checks_passed + awaiting_approval only", () => {
    expect([...RECONCILABLE_STATUSES].sort()).toEqual(["awaiting_approval", "checks_passed"]);
  });
  test("has a bound + a 15-min cron", () => {
    expect(DEFAULT_MAX_PER_SWEEP).toBeGreaterThan(0);
    expect(SWEEP_CRON).toBe("*/15 * * * *");
    expect(SWEEP_HEARTBEAT_KEY).toBe("sweep-heartbeat");
  });
});

describe("reconcileSweep", () => {
  test("advances a merged-PR run and leaves an open-PR run parked", async () => {
    const runs = [run("merged", "checks_passed"), run("open", "checks_passed")];
    const reconcile = async (id: string): Promise<ReconcileResult> =>
      id === "merged"
        ? { status: "completed", parked: false }
        : { status: "checks_passed", parked: false };
    const logs: string[] = [];
    const summary = await reconcileSweep({
      store: fakeStore(runs),
      reconcile,
      now: () => 0,
      log: (m) => logs.push(m),
    });
    expect(summary).toEqual({ scanned: 2, advanced: 1, stillParked: 1, skipped: 0, stalled: 0 });
    expect(logs[0]).toContain("advanced 1");
    expect(logs[0]).toContain("stalled 0");
  });

  test("reconciles a CI-timeout-parked (awaiting_approval) run too", async () => {
    const summary = await reconcileSweep({
      store: fakeStore([run("ci-parked", "awaiting_approval")]),
      reconcile: async () => ({ status: "awaiting_approval", parked: true }),
      now: () => 0,
    });
    expect(summary).toEqual({ scanned: 1, advanced: 0, stillParked: 1, skipped: 0, stalled: 0 });
  });

  test("skips terminal + mid-flight runs (never reconcilable)", async () => {
    let calls = 0;
    const summary = await reconcileSweep({
      store: fakeStore([
        run("done", "completed"),
        run("failed", "failed"),
        run("aborted", "aborted"),
        run("running", "running"),
        run("created", "created"),
      ]),
      reconcile: async () => {
        calls++;
        return { status: "completed", parked: false };
      },
      now: () => 0,
    });
    expect(calls).toBe(0);
    expect(summary).toEqual({ scanned: 0, advanced: 0, stillParked: 0, skipped: 0, stalled: 0 });
  });

  test("counts a null reconcile (unresumable run) as skipped", async () => {
    const summary = await reconcileSweep({
      store: fakeStore([run("gone", "checks_passed")]),
      reconcile: async () => null,
      now: () => 0,
    });
    expect(summary).toEqual({ scanned: 1, advanced: 0, stillParked: 0, skipped: 1, stalled: 0 });
  });

  test("records a heartbeat with an ISO timestamp + the summary", async () => {
    let hb: SweepHeartbeat | null = null;
    await reconcileSweep({
      store: fakeStore([run("merged", "checks_passed")]),
      reconcile: async () => ({ status: "completed", parked: false }),
      now: () => 1_700_000_000_000,
      recordHeartbeat: async (h) => {
        hb = h;
      },
    });
    expect(hb).not.toBeNull();
    const heartbeat = hb as unknown as SweepHeartbeat;
    expect(heartbeat.ranAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(heartbeat.summary.advanced).toBe(1);
  });

  test("respects maxPerSweep — bounds the fan-out", async () => {
    const runs = [
      run("a", "checks_passed"),
      run("b", "checks_passed"),
      run("c", "checks_passed"),
    ];
    let calls = 0;
    const summary = await reconcileSweep({
      store: fakeStore(runs),
      reconcile: async () => {
        calls++;
        return { status: "checks_passed", parked: false };
      },
      now: () => 0,
      maxPerSweep: 2,
    });
    expect(calls).toBe(2);
    expect(summary.scanned).toBe(2);
  });
});

// ── Staleness pass (L3, the status-truthfulness fix) ────────────────

const STALL_MS = 10 * 60 * 1000;

/** A store recording updateRun patches, over a fixed run list. */
function updatingStore(runs: RunRecord[]): RunStore & { updates: Array<{ id: string; patch: Partial<RunRecord> }> } {
  const updates: Array<{ id: string; patch: Partial<RunRecord> }> = [];
  return {
    async listRuns() {
      return runs;
    },
    async updateRun(id: string, patch: Partial<RunRecord>) {
      updates.push({ id, patch });
      return null;
    },
    updates,
  } as unknown as RunStore & { updates: Array<{ id: string; patch: Partial<RunRecord> }> };
}

function runningAt(id: string, updatedAt: string): RunRecord {
  return { ...run(id, "running"), updatedAt };
}

describe("reconcileSweep staleness pass", () => {
  const nowMs = 2_000_000_000_000;
  const freshIso = new Date(nowMs - 60_000).toISOString(); // 1 min ago
  const staleIso = new Date(nowMs - STALL_MS - 60_000).toISOString(); // > threshold ago

  test("marks a running run stalled when its heartbeat is silent past the threshold", async () => {
    const store = updatingStore([runningAt("dead", staleIso)]);
    const summary = await reconcileSweep({
      store,
      reconcile: async () => ({ status: "completed", parked: false }),
      readHeartbeat: async () => staleIso,
      now: () => nowMs,
    });
    expect(summary.stalled).toBe(1);
    expect(store.updates).toEqual([{ id: "dead", patch: { status: "stalled" } }]);
  });

  test("leaves a running run alone when its heartbeat is fresh", async () => {
    const store = updatingStore([runningAt("alive", staleIso)]);
    const summary = await reconcileSweep({
      store,
      reconcile: async () => ({ status: "completed", parked: false }),
      // A fresh heartbeat keeps a live process from ever tripping, even though
      // updatedAt (the last status write) is old.
      readHeartbeat: async () => freshIso,
      now: () => nowMs,
    });
    expect(summary.stalled).toBe(0);
    expect(store.updates).toEqual([]);
  });

  test("no heartbeat key (legacy run, frozen updatedAt) trips immediately", async () => {
    const store = updatingStore([runningAt("legacy", staleIso)]);
    const summary = await reconcileSweep({
      store,
      reconcile: async () => ({ status: "completed", parked: false }),
      readHeartbeat: async () => null,
      now: () => nowMs,
    });
    expect(summary.stalled).toBe(1);
    expect(store.updates[0]!.patch).toEqual({ status: "stalled" });
  });

  test("a recently-updated running run with no heartbeat is NOT stalled", async () => {
    const store = updatingStore([runningAt("busy", freshIso)]);
    const summary = await reconcileSweep({
      store,
      reconcile: async () => ({ status: "completed", parked: false }),
      readHeartbeat: async () => null,
      now: () => nowMs,
    });
    expect(summary.stalled).toBe(0);
    expect(store.updates).toEqual([]);
  });

  test("omitted readHeartbeat seam → staleness evaluated on updatedAt alone", async () => {
    const store = updatingStore([runningAt("frozen", staleIso)]);
    const summary = await reconcileSweep({
      store,
      reconcile: async () => ({ status: "completed", parked: false }),
      now: () => nowMs,
    });
    expect(summary.stalled).toBe(1);
  });
});
