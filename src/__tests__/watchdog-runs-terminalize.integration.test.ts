/**
 * Regression test for the orphaned-`running`-row bug.
 *
 * Forensic finding: when the watchdog kills a hung run it wrote
 * `active_runs.status='interrupted'` but left the `runs` mirror at
 * `status='running', finished_at=NULL` forever (~131 systemic orphans).
 * Root cause: the watchdog only called `activeRunsDb.markInterrupted`;
 * the `runs` row was only ever terminalized by `streamChat`'s
 * `finally → finalizeCleanup → dbRuns.updateRun`, which never runs when
 * the underlying await is a leaked/hung promise the abort can't unblock
 * (the exact case the watchdog exists to handle).
 *
 * This pins:
 *   (a) the watchdog-interrupt path now terminalizes BOTH representations
 *       — markInterrupted (active_runs) AND finalizeRunRow (runs:
 *       terminal status + finished_at) — atomically in the same tick;
 *   (b) the boot reconciliation pass invokes the `runs`-table drain
 *       (terminalizeOrphanedRuns) alongside the existing active_runs
 *       interruptAllRuns, AND leaves a legitimately-active run untouched
 *       (the WHERE-guarded query only matches still-`running` rows).
 *
 * Harness mirrors executor-watchdog-inflight-tools.test.ts (fake clock +
 * captured setInterval) but additionally records every call into the
 * mocked db/queries/runs + db/queries/active-runs so the dual-write is
 * observable without a real DB.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mocks (must precede SUT import) ────────────────────────────────────

interface FinalizeCall { runId: string; status: string; error?: string }
const finalizeRunRowCalls: FinalizeCall[] = [];
const markInterruptedCalls: string[] = [];
let interruptAllRunsCalls = 0;
let terminalizeOrphanedRunsCalls = 0;
// What terminalizeOrphanedRuns "found" — drives the boot-reconcile assertion.
let orphanBacklog = 0;

mock.module("../db/queries/active-runs", () => ({
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
  markInterrupted: async (id: string) => {
    markInterruptedCalls.push(id);
  },
  cleanupOrphanedRuns: async () => 0,
  interruptAllRuns: async () => {
    interruptAllRunsCalls += 1;
    return 0;
  },
  getActiveRun: async () => null,
}));

mock.module("../db/queries/runs", () => ({
  finalizeRunRow: async (runId: string, status: string, error?: string) => {
    finalizeRunRowCalls.push({ runId, status, error });
    return 1;
  },
  terminalizeOrphanedRuns: async () => {
    terminalizeOrphanedRunsCalls += 1;
    return orphanBacklog;
  },
}));

import {
  WatchdogManager,
  type WatchdogHost,
} from "../runtime/executor-watchdog";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";

// ── Fake clock + setInterval capture ───────────────────────────────────

let originalSetInterval: typeof setInterval;
let originalDateNow: () => number;
let fakeNow = 0;
let capturedTicks: Array<() => void> = [];

beforeEach(() => {
  originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: (...args: unknown[]) => void) => {
    capturedTicks.push(() => fn());
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  originalDateNow = Date.now;
  fakeNow = 1_000_000;
  Date.now = () => fakeNow;
  capturedTicks = [];

  finalizeRunRowCalls.length = 0;
  markInterruptedCalls.length = 0;
  interruptAllRunsCalls = 0;
  terminalizeOrphanedRunsCalls = 0;
  orphanBacklog = 0;
});

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  Date.now = originalDateNow;
  capturedTicks = [];
});

async function advanceAndTick(deltaMs: number): Promise<void> {
  fakeNow += deltaMs;
  for (const fn of capturedTicks) fn();
  await new Promise<void>((r) => queueMicrotask(r));
}

// ── Harness ────────────────────────────────────────────────────────────

function makeRun(id: string): AgentRun {
  return { id, agentName: "chat", status: "running", startedAt: fakeNow, logs: [] };
}

interface Harness {
  manager: WatchdogManager;
  host: WatchdogHost;
  runs: Map<string, AgentRun>;
  controllers: Map<string, AbortController>;
}

function makeHarness(): Harness {
  const bus = new EventBus<AgentEvents>();
  const runs = new Map<string, AgentRun>();
  const controllers = new Map<string, AbortController>();
  const host: WatchdogHost = {
    runs,
    controllers,
    activeAgents: new Map(),
    runConversations: new Map(),
    pendingPermissions: new Map(),
    bus,
    persist: true,
    errorMessagePersisted: new Set<string>(),
  };
  return { manager: new WatchdogManager(host), host, runs, controllers };
}

const RUN_ID = "run-wd-1";
const CONV_ID = "conv-wd-1";

// ── (a) watchdog-interrupt terminalizes the runs row ───────────────────

describe("watchdog interrupt → runs row terminalized (the orphan-row bug)", () => {
  test("idle kill writes BOTH active_runs (markInterrupted) AND runs (finalizeRunRow error)", async () => {
    const h = makeHarness();
    const run = makeRun(RUN_ID);
    h.runs.set(RUN_ID, run);
    h.controllers.set(RUN_ID, new AbortController());
    h.manager.startWatchdog(RUN_ID, CONV_ID, () => "");

    // No activity for > WATCHDOG_IDLE_MS (90s) and no deferral → kill.
    await advanceAndTick(95_000);

    // Pre-fix this was the ONLY write — `runs` stayed status='running'.
    expect(markInterruptedCalls).toEqual([RUN_ID]);

    // The fix: the `runs` mirror is terminalized in the same tick.
    expect(finalizeRunRowCalls).toHaveLength(1);
    expect(finalizeRunRowCalls[0]!.runId).toBe(RUN_ID);
    expect(finalizeRunRowCalls[0]!.status).toBe("error");
    expect(finalizeRunRowCalls[0]!.error).toMatch(/Watchdog: no activity for \d+s/);

    // In-memory run is terminal too (unchanged behavior, sanity check).
    expect(run.status).toBe("error");
    expect(run.finishedAt).toBeDefined();
  });

  test("does NOT terminalize a run that is still making progress (no false kill)", async () => {
    const h = makeHarness();
    const run = makeRun(RUN_ID);
    h.runs.set(RUN_ID, run);
    h.controllers.set(RUN_ID, new AbortController());
    h.manager.startWatchdog(RUN_ID, CONV_ID, () => "");

    // Activity keeps getting bumped every tick → never idle long enough.
    for (let i = 0; i < 4; i++) {
      h.manager.bumpActivity(RUN_ID);
      await advanceAndTick(30_000); // < WATCHDOG_IDLE_MS each window
    }

    expect(finalizeRunRowCalls).toHaveLength(0);
    expect(markInterruptedCalls).toHaveLength(0);
    expect(run.status).toBe("running");
  });
});

// ── (b) boot reconciliation wiring + active-run safety ─────────────────

describe("boot reconciliation drains the runs backlog", () => {
  test("startOrphanCleanup invokes terminalizeOrphanedRuns alongside interruptAllRuns", async () => {
    orphanBacklog = 131; // the systemic backlog the user observed

    const h = makeHarness();
    h.manager.startOrphanCleanup();
    // Both startup passes are fire-and-forget promises — drain microtasks.
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));

    // active_runs counterpart (pre-existing) still runs...
    expect(interruptAllRunsCalls).toBe(1);
    // ...and the new `runs`-table twin pass runs too. Returning 131 here
    // proves the backlog drains on the next legitimate restart with no
    // manual DB surgery.
    expect(terminalizeOrphanedRunsCalls).toBe(1);

    h.manager.destroy();
  });

  test("clean boot (no backlog) is a harmless no-op", async () => {
    orphanBacklog = 0;

    const h = makeHarness();
    h.manager.startOrphanCleanup();
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));

    expect(terminalizeOrphanedRunsCalls).toBe(1);
    // A genuinely-live run is distinguished from an orphan by the query's
    // own `WHERE status='running' AND finished_at IS NULL` guard at the
    // DB layer (asserted in runs-finalize.test.ts) — boot itself can't
    // race a live run because a fresh process owns zero in-memory runs.

    h.manager.destroy();
  });
});
