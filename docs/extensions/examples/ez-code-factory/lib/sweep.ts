// ── Periodic reconcile sweep (M6, deferred from M4 MED-2) ───────────
//
// A run that rests at `checks_passed` (CI went green, worktree released) — or
// is parked at the CI gate on an idle timeout — waits for its PR to merge/close
// before it can complete. M4 shipped the manual "Re-check PR state" button; M6
// adds the background sweep the README promised: a scheduled fire that polls
// every reconcilable run and advances the ones whose PR resolved.
//
// The sweep is READ-ONLY per run (it drives the CI step's opt-in
// ReconcileApprovalGate — a `gh pr view` state poll — which only completes a run
// when external truth says the PR merged/closed; it never guesses). It is
// BOUNDED (`maxPerSweep`), DETERMINISTIC (an injected `now` clock — no
// wall-clock), and HONEST (one summary line per fire). The `reconcile` seam is
// the SAME resume+reconcile-runner path the Hub button drives, so the sweep
// forks none of the gate semantics; index.ts owns the production wiring (cron
// trigger → per-run gateDir resolution).

import type { RunRecord, RunStatus, RunStore } from "./runs";
import { isRunStale } from "./heartbeat";

/** Statuses a sweep re-checks: a run RESTING at checks_passed (the common case)
 *  or PARKED awaiting approval (a CI idle-timeout park lives here — the
 *  reconcile runner cheaply no-ops a non-CI parked step). Terminal + mid-flight
 *  runs are never touched. */
export const RECONCILABLE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "checks_passed",
  "awaiting_approval",
]);

/** Default cap on runs reconciled per sweep — bounds the gh fan-out so one fire
 *  can never stampede the host. */
export const DEFAULT_MAX_PER_SWEEP = 200;

/** A single run's reconcile outcome (mirrors resumeGateLifecycle's return). */
export type ReconcileResult = { status: RunStatus; parked: boolean } | null;

export interface SweepDeps {
  store: RunStore;
  /**
   * Drive one run's ReconcileApprovalGate. Production: resumeGateLifecycle +
   * the reconcile runner (read-only PR-state poll against the run's gate repo).
   * Null when the run could not resume (no worktree row / store race).
   */
  reconcile: (runId: string) => Promise<ReconcileResult>;
  /**
   * Read one run's per-run liveness heartbeat (ISO string under
   * `heartbeats/<runId>`), or null when absent (matches the injection style of
   * the other seams). Drives the staleness pass over `running` runs. Optional —
   * when omitted the pass evaluates staleness on `updatedAt` alone (a legacy
   * frozen run still trips; a normally-updated one does not).
   */
  readHeartbeat?: (runId: string) => Promise<string | null>;
  /** Injected clock (ms) for the heartbeat timestamp — no wall-clock. */
  now: () => number;
  /** Persist the sweep heartbeat so `code_factory_doctor` can report loop
   *  health (last run + counts). Optional. */
  recordHeartbeat?: (hb: SweepHeartbeat) => Promise<void>;
  /** Once-per-fire summary sink. Optional. */
  log?: (message: string) => void;
  /** Max runs reconciled this fire (defaults to {@link DEFAULT_MAX_PER_SWEEP}). */
  maxPerSweep?: number;
}

/** What one sweep touched. */
export interface SweepSummary {
  /** Reconcilable runs the sweep attempted (≤ maxPerSweep). */
  scanned: number;
  /** Runs the reconcile advanced to `completed` (PR merged/closed). */
  advanced: number;
  /** Runs left parked/resting (PR still open, or not CI-reconcilable). */
  stillParked: number;
  /** Runs that could not resume (null result — store race / missing row). */
  skipped: number;
  /** `running` runs whose heartbeat went silent past the stall threshold and
   *  were marked `stalled` this fire (the status-truthfulness fix, L3). */
  stalled: number;
}

/** The self-tracked sweep heartbeat (doctor's "loop healthy?" evidence). */
export interface SweepHeartbeat {
  /** ISO timestamp of the fire. */
  ranAt: string;
  summary: SweepSummary;
}

/** Storage key the sweep heartbeat is written under (doctor reads the same). */
export const SWEEP_HEARTBEAT_KEY = "sweep-heartbeat";

/** The reconcile-sweep cron (every 15 min — a coarse background re-check;
 *  the CI step's own poll handles the fast path). Declared in the manifest's
 *  `permissions.schedule.crons`; ezcorp.config.test.ts guards them in sync. */
export const SWEEP_CRON = "*/15 * * * *";

/**
 * Run one reconcile sweep: list every run, reconcile up to `maxPerSweep`
 * reconcilable ones, and tally the outcome. A reconcile that advances a run to
 * `completed` counts as `advanced`; anything still resting/parked is
 * `stillParked`; an unresumable run is `skipped`. Writes a heartbeat + logs one
 * summary line. Never throws for a single run — the reconcile seam already
 * fail-safes a stale gate to "parked".
 */
export async function reconcileSweep(deps: SweepDeps): Promise<SweepSummary> {
  const max = deps.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP;
  const runs = await deps.store.listRuns();
  const summary: SweepSummary = { scanned: 0, advanced: 0, stillParked: 0, skipped: 0, stalled: 0 };

  for (const run of runs) {
    // Staleness pass (L3): a `running` run whose heartbeat went silent past the
    // threshold is marked `stalled` — truthful, immediate, durable. Checked
    // before the reconcile cap (a heartbeat read is a cheap KV get, not a `gh`
    // fan-out) and separate from it (a running run is never reconcilable).
    if (run.status === "running") {
      const heartbeatAt = deps.readHeartbeat ? await deps.readHeartbeat(run.id) : null;
      if (isRunStale(run, heartbeatAt, deps.now())) {
        await deps.store.updateRun(run.id, { status: "stalled" });
        summary.stalled += 1;
      }
      continue;
    }
    if (summary.scanned >= max) break;
    if (!isReconcilable(run)) continue;
    summary.scanned += 1;
    const result = await deps.reconcile(run.id);
    if (result === null) {
      summary.skipped += 1;
      continue;
    }
    // Reconcile only ever advances a run to `completed` (on merge/close); every
    // other outcome leaves it resting/parked (fail-safe: it never guesses).
    if (result.status === "completed") {
      summary.advanced += 1;
    } else {
      summary.stillParked += 1;
    }
  }

  const ranAt = new Date(deps.now()).toISOString();
  if (deps.recordHeartbeat) await deps.recordHeartbeat({ ranAt, summary });
  deps.log?.(
    `reconcile sweep: scanned ${summary.scanned}, advanced ${summary.advanced}, ` +
      `still-parked ${summary.stillParked}, skipped ${summary.skipped}, stalled ${summary.stalled}`,
  );
  return summary;
}

/** True iff a run is in a state the sweep re-checks. */
function isReconcilable(run: RunRecord): boolean {
  return RECONCILABLE_STATUSES.has(run.status);
}
