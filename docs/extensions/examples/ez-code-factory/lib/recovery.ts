// ── Crash recovery — re-derive parked state on (re)start (M6, spec §1) ──
//
// Upstream re-derives every run's parked state from the DB alone on restart: a
// gate is recoverable ONLY when every prior step completed/skipped AND the gate
// row is fully recorded; otherwise it fails closed. A run interrupted MID-step
// (running / created / worktree_ready) cannot be safely resumed — the worktree
// may hold a half-applied fix, so we never re-enter it — so it fails closed too.
// Orphaned worktrees (a terminal/failed run's checkout the teardown missed) are
// reaped; a LIVE parked run's worktree is the human's review copy and is NEVER
// touched.
//
// PURE over injected seams (store + a `reapWorktree` closure the caller binds to
// the run's gate dir + an injected clock), so both the recover-parked and the
// fail-closed paths are unit-tested with fakes — no live git, no restart.

import { PIPELINE_STEPS } from "./config";
import { isTerminalRunStatus, type RunRecord, type RunStore } from "./runs";

export interface RecoveryDeps {
  store: RunStore;
  /** Remove a run's orphaned worktree. Production: removeWorktree bound to the
   *  run's gate dir. Best-effort — a throw is caught + logged, never fatal (a
   *  leaked worktree is recoverable; aborting recovery is not). */
  reapWorktree: (run: RunRecord) => Promise<void>;
  /** Once-per-restart summary sink. Optional. */
  log?: (message: string) => void;
}

/** What one recovery pass did. */
export interface RecoverySummary {
  /** Cleanly-parked runs whose invariant held — left parked (worktree kept). */
  recovered: number;
  /** Interrupted / half-recorded runs marked `failed` (fail closed). */
  failedClosed: number;
  /** Orphaned worktrees removed (terminal + fail-closed runs). */
  reaped: number;
}

/**
 * Re-derive every run's state after a (re)start:
 *   - TERMINAL run (completed/failed/aborted) with a lingering worktree row →
 *     reap the orphan (the teardown missed it or a crash interrupted it).
 *   - Cleanly PARKED / RESTING run (awaiting_approval / checks_passed) → recover
 *     ONLY if the gate row is fully recorded (a parked step exists) AND every
 *     prior step completed/skipped; else fail closed + reap. A recovered run
 *     keeps its worktree (the human's review copy).
 *   - MID-FLIGHT run (running / created / worktree_ready) → fail closed + reap:
 *     a restart cannot safely re-enter a half-executed step.
 * Never throws — a single run's reap failure is logged and the pass continues.
 */
export async function recoverRuns(deps: RecoveryDeps): Promise<RecoverySummary> {
  const summary: RecoverySummary = { recovered: 0, failedClosed: 0, reaped: 0 };
  const runs = await deps.store.listRuns();

  for (const run of runs) {
    if (isTerminalRunStatus(run.status)) {
      if (await reapIfWorktree(deps, run)) summary.reaped += 1;
      continue;
    }

    if (run.status === "awaiting_approval" || run.status === "checks_passed") {
      const derived = await deriveParkedState(deps.store, run);
      if (derived.recoverable) {
        summary.recovered += 1;
        deps.log?.(`recovered parked run ${run.id} (${run.status})`);
        continue; // keep the worktree — it is the human's review copy
      }
      await failClosed(deps, run, `unrecoverable parked run — ${derived.reason}`);
      summary.failedClosed += 1;
      if (await reapIfWorktree(deps, run)) summary.reaped += 1;
      continue;
    }

    // running / created / worktree_ready — interrupted mid-pipeline.
    await failClosed(
      deps,
      run,
      `interrupted mid-pipeline at status '${run.status}' — a restart cannot safely resume`,
    );
    summary.failedClosed += 1;
    if (await reapIfWorktree(deps, run)) summary.reaped += 1;
  }

  deps.log?.(
    `crash recovery: recovered ${summary.recovered}, failed-closed ${summary.failedClosed}, ` +
      `reaped ${summary.reaped} orphaned worktree(s)`,
  );
  return summary;
}

/** Result of re-deriving whether a parked run may resume. */
interface DerivedState {
  recoverable: boolean;
  /** Why the run is unrecoverable (present when `recoverable` is false). */
  reason?: string;
}

/**
 * A parked run is recoverable iff its GATE ROW is fully recorded (a step is
 * actually parked at awaiting_approval/fix_review) AND every step BEFORE it
 * completed or skipped. A parked status with no parked step, or a gap in the
 * prior steps, is a half-recorded crash artifact → fail closed. Pure over the
 * store reads.
 */
async function deriveParkedState(store: RunStore, run: RunRecord): Promise<DerivedState> {
  let parkedIndex = -1;
  for (let i = 0; i < PIPELINE_STEPS.length; i++) {
    const sr = await store.getStepResult(run.id, PIPELINE_STEPS[i]!);
    if (sr && (sr.status === "awaiting_approval" || sr.status === "fix_review")) {
      parkedIndex = i;
      break;
    }
  }
  if (parkedIndex < 0) return { recoverable: false, reason: "no gate row recorded (no parked step)" };
  for (let i = 0; i < parkedIndex; i++) {
    const sr = await store.getStepResult(run.id, PIPELINE_STEPS[i]!);
    if (!sr || (sr.status !== "completed" && sr.status !== "skipped")) {
      return {
        recoverable: false,
        reason: `prior step '${PIPELINE_STEPS[i]}' is not completed/skipped`,
      };
    }
  }
  return { recoverable: true };
}

/** Mark a run failed (fail-closed recovery). */
async function failClosed(deps: RecoveryDeps, run: RunRecord, reason: string): Promise<void> {
  await deps.store.updateRun(run.id, { status: "failed", error: reason, awaitingAgentSince: null });
  deps.log?.(`failed closed run ${run.id}: ${reason}`);
}

/**
 * Reap a run's worktree when it has one, then null the row's `worktreePath` so a
 * later restart never re-reaps it (idempotent recovery). Best-effort: a reap
 * throw is caught + logged. Returns true when a reap was attempted.
 */
async function reapIfWorktree(deps: RecoveryDeps, run: RunRecord): Promise<boolean> {
  if (!run.worktreePath) return false;
  try {
    await deps.reapWorktree(run);
  } catch (err) {
    deps.log?.(`reap failed for run ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  await deps.store.updateRun(run.id, { worktreePath: null });
  return true;
}
