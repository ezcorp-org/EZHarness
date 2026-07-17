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
    expect(summary).toEqual({ scanned: 2, advanced: 1, stillParked: 1, skipped: 0 });
    expect(logs[0]).toContain("advanced 1");
  });

  test("reconciles a CI-timeout-parked (awaiting_approval) run too", async () => {
    const summary = await reconcileSweep({
      store: fakeStore([run("ci-parked", "awaiting_approval")]),
      reconcile: async () => ({ status: "awaiting_approval", parked: true }),
      now: () => 0,
    });
    expect(summary).toEqual({ scanned: 1, advanced: 0, stillParked: 1, skipped: 0 });
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
    expect(summary).toEqual({ scanned: 0, advanced: 0, stillParked: 0, skipped: 0 });
  });

  test("counts a null reconcile (unresumable run) as skipped", async () => {
    const summary = await reconcileSweep({
      store: fakeStore([run("gone", "checks_passed")]),
      reconcile: async () => null,
      now: () => 0,
    });
    expect(summary).toEqual({ scanned: 1, advanced: 0, stillParked: 0, skipped: 1 });
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
