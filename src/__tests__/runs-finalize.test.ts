/**
 * Unit tests for the shared abnormal-termination finalize helpers added
 * to src/db/queries/runs.ts:
 *
 *   - finalizeRunRow(runId, status, error?) — the single "terminalize the
 *     `runs` mirror" path every kill route (watchdog / cancel / setup
 *     error / host crash) funnels through, idempotent + race-safe via a
 *     `WHERE status='running'` guard so it never clobbers a richer
 *     terminal result the healthy finalizeCleanup path recorded.
 *   - terminalizeOrphanedRuns() — boot reconciliation that drains every
 *     `runs` row still stuck `status='running' AND finished_at IS NULL`
 *     (the systemic ~131-row backlog + future crash orphans).
 *
 * Mirrors the chainable-DB-mock harness from active-runs.test.ts so the
 * exact `.set(...)` / `.where(...)` shapes the query builds are pinned.
 */

import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mock DB layer (chainable, matches active-runs.test.ts) ───────────

let mockRows: any[] = [];
let lastUpdateSet: any = null;
let lastWhereArgs: any = null;

function resetMockState() {
  mockRows = [];
  lastUpdateSet = null;
  lastWhereArgs = null;
}

function createChainableDb() {
  const chain: any = {
    _op: null,
    update: (_table: any) => {
      chain._op = "update";
      return chain;
    },
    set: (vals: any) => {
      lastUpdateSet = vals;
      return chain;
    },
    where: (args: any) => {
      lastWhereArgs = args;
      return chain;
    },
    returning: (_cols?: any) => Promise.resolve(mockRows),
  };
  return chain;
}

mock.module("../db/connection", () => ({
  getDb: () => createChainableDb(),
}));

// ── Import subject after mocks ───────────────────────────────────────

import { finalizeRunRow, terminalizeOrphanedRuns } from "../db/queries/runs";

// ── Tests ────────────────────────────────────────────────────────────

describe("finalizeRunRow", () => {
  beforeEach(() => resetMockState());

  test("terminalizes a still-running row with status + finished_at + error result", async () => {
    mockRows = [{ id: "run-1" }];

    const transitioned = await finalizeRunRow("run-1", "error", "Watchdog: no activity for 95s");

    expect(transitioned).toBe(1);
    expect(lastUpdateSet.status).toBe("error");
    // sql`NOW()` template — present (not null) so the row becomes terminal.
    expect(lastUpdateSet.finishedAt).toBeDefined();
    expect(lastUpdateSet.result).toEqual({
      success: false,
      output: null,
      error: "Watchdog: no activity for 95s",
    });
    // The WHERE clause must scope to this run AND status='running' so it
    // is a no-op on an already-terminal row (race/idempotency guard).
    expect(lastWhereArgs).toBeDefined();
  });

  test("cancelled status without an error message omits the result write", async () => {
    mockRows = [{ id: "run-2" }];

    const transitioned = await finalizeRunRow("run-2", "cancelled");

    expect(transitioned).toBe(1);
    expect(lastUpdateSet.status).toBe("cancelled");
    expect(lastUpdateSet.finishedAt).toBeDefined();
    // No error arg → must NOT clobber any partial result the cancel path
    // (finalizeError AbortError branch) may have already stored.
    expect("result" in lastUpdateSet).toBe(false);
  });

  test("returns 0 when the row is already terminal (idempotent no-op)", async () => {
    // Healthy path: finalizeCleanup already persisted a terminal state,
    // so the `WHERE status='running'` guard matches no rows.
    mockRows = [];

    const transitioned = await finalizeRunRow("run-3", "error", "late watchdog");

    expect(transitioned).toBe(0);
  });
});

describe("terminalizeOrphanedRuns (boot reconciliation)", () => {
  beforeEach(() => resetMockState());

  test("marks every stuck running row error + finished_at and returns the drained count", async () => {
    // Simulates the ~131-row backlog: many rows still status='running',
    // finished_at NULL from a process that died before finalizeCleanup.
    mockRows = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];

    const drained = await terminalizeOrphanedRuns();

    expect(drained).toBe(3);
    expect(lastUpdateSet.status).toBe("error");
    expect(lastUpdateSet.finishedAt).toBeDefined();
    expect(lastUpdateSet.result).toEqual({
      success: false,
      output: null,
      error: "Run orphaned: process restarted while run was active",
    });
    // Scoped to status='running' AND finished_at IS NULL — never touches
    // rows the normal path already terminalized.
    expect(lastWhereArgs).toBeDefined();
  });

  test("returns 0 when there is no backlog (clean boot)", async () => {
    mockRows = [];

    const drained = await terminalizeOrphanedRuns();

    expect(drained).toBe(0);
  });
});
