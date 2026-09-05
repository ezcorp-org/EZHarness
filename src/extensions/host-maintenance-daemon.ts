/**
 * HostMaintenanceDaemon — sibling cron driver for host-scoped maintenance
 * sweeps that don't fit the per-extension `ScheduleDaemon` model.
 *
 * Phase 3 of the capability-expiry milestone (see
 * `tasks/capability-expiry-milestone.md` § Phase 3). Phase 1 shipped the
 * data-model contract (TTL table, always-allow value shape, audit-action
 * constant). Phase 2 shipped the sweep itself (`./perm-expiry-sweep.ts`)
 * + a manual CLI. This module wires the sweep to a hourly tick so the
 * sweep runs without admin intervention.
 *
 * Why a sibling daemon and not `ScheduleDaemon` re-use? The schedule-
 * daemon is keyed on `extension_schedules` rows (per-extension cron
 * registrations). Capability-expiry sweep is host-wide — there's no
 * extension to register against, and stuffing a synthetic "host
 * extension" row into the schedules table would conflate data shapes for
 * unclear ownership. Locked design decision (`tasks/capability-expiry-
 * design.md` § 2.2). Phase 4's UX hooks here too if it needs a periodic
 * "expired-recently" digest.
 *
 * Locked invariants (Phase 3 contract):
 *   - **Single-process invariant.** PID lockfile at
 *     `.ezcorp/host-maintenance-daemon.pid`. Distributed cron is out of
 *     scope.
 *   - **Hourly cadence by default.** `EZCORP_PERM_SWEEP_INTERVAL_MS`
 *     overrides; clamps to ≥1000ms so a misconfigured prod can't tick
 *     pathologically often. Tests pass small values for fast ticks.
 *   - **Kill switch.** `EZCORP_DISABLE_PERM_SWEEP=1` (strict — only
 *     `"1"`, not `"true"` / `"yes"`) skips lockfile acquisition and
 *     returns `false` from `start()`. No tick is installed.
 *   - **Tick errors are swallowed.** A sweep that throws is logged and
 *     the next tick still fires. The daemon must NEVER crash the host.
 *   - **First tick is delayed by one interval.** Boot is hot already
 *     (migrations, schedule-daemon backfill, etc.); we don't pile on a
 *     full DB scan in the first second.
 *
 * Implementation note on lockfile helpers: `ScheduleDaemon` carries the
 * same primitives (acquire / release / isProcessAlive). Phase 3 inlines a
 * private copy here rather than refactoring the schedule-daemon module
 * into a shared lockfile helper — the orchestrator brief flagged
 * "no schedule-daemon edits" as out of scope, and the duplication is
 * tiny (~30 LOC) for one well-tested primitive. A future phase that
 * adds a third lockfile-using daemon should extract; two callers don't
 * yet justify the indirection.
 */

import { sql } from "drizzle-orm";
import { logger } from "../logger";
import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { getDb } from "../db/connection";
import {
  TTL_CONFIG,
  getForeverTtlMs,
  type CapabilityExpiryKind,
} from "./perm-expiry-config";
import {
  applySweepResult,
  runSweep,
  type ApplyError,
} from "./perm-expiry-sweep";
import { acquireLockfile, releaseLockfile, isProcessAlive } from "../startup/process-lockfile";
import { sweepWorkflowDefinitionVersions } from "../db/queries/workflow-versions";
import { listPinnedDelegationVersionIds } from "../db/queries/workflow-delegations";
import {
  sweepExpiredWorkflowApprovals,
  type ApprovalTimeoutSweepResult,
} from "../runtime/workflow-approval-timeout-sweep";
import {
  sweepAllDynamicTriggers,
  type SweepAllResult,
  type SweepRegistry,
} from "./triggers-sweep";

/**
 * Sub-tick cadence — every 6th `tickOnce()` fires
 * `gin_clean_pending_list('idx_marketplace_listings_trgm')`. With the
 * default 1h wake interval that's a 6h sweep, matching UX-02 (Phase
 * 57-04) Phase 3 of the marketplace search stack. Constant kept here
 * because the cadence is daemon-local — no env-var override, no
 * background-timers.ts change.
 */
const GIN_SWEEP_TICK_MODULO = 6;
const GIN_TRGM_INDEX_NAME = "idx_marketplace_listings_trgm";

/**
 * Cadence for the workflow-definition-version retention sweep — every
 * 24th tick, i.e. daily on the default 1h wake. Versions are a small
 * `steps` blob and are the audit trail for what actually ran, so this is
 * housekeeping, not pressure relief; a slower cadence than the GIN sweep
 * is correct.
 */
const VERSION_SWEEP_TICK_MODULO = 24;

const log = logger.child("perm-expiry.daemon");

// ── Defaults / env-var contract ──────────────────────────────────────

/** Default tick cadence — 1 hour. */
const DEFAULT_WAKE_MS = 3_600_000;
/** Floor on the configured wake interval. Tests legitimately pass small
 *  values (<1s) but a misconfigured prod must not tick faster than 1s
 *  — capability-expiry isn't latency-sensitive and a 1ms tick would
 *  hammer the DB. */
const MIN_WAKE_MS = 1000;
/** Default lockfile path. Sibling to `.ezcorp/schedule-daemon.pid`. */
const DEFAULT_LOCKFILE_PATH = ".ezcorp/host-maintenance-daemon.pid";

/**
 * Read `EZCORP_PERM_SWEEP_INTERVAL_MS` and return a sane wake interval.
 *
 * Validation (mirrors `getForeverTtlMs` from `./perm-expiry-config.ts`):
 *   - unset / empty → default 1h
 *   - non-numeric / non-finite / ≤ 0 → default 1h, log warning
 *   - below the 1s floor → clamped up to 1s, log warning
 *
 * The function logs warnings via the daemon's logger so a misconfigured
 * deployment surfaces the bad value at boot. It NEVER throws — the
 * sweep should never crash on a typo'd env var. Same defensive contract
 * that `getForeverTtlMs` honors for `EZCORP_PERM_FOREVER_TTL_DAYS`.
 */
export function getSweepIntervalMs(): number {
  const raw = process.env.EZCORP_PERM_SWEEP_INTERVAL_MS;
  if (raw === undefined || raw === "") return DEFAULT_WAKE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    log.warn("EZCORP_PERM_SWEEP_INTERVAL_MS invalid — using default", {
      raw,
      defaultMs: DEFAULT_WAKE_MS,
    });
    return DEFAULT_WAKE_MS;
  }
  const intMs = Math.floor(n);
  if (intMs < MIN_WAKE_MS) {
    log.warn("EZCORP_PERM_SWEEP_INTERVAL_MS below floor — clamped", {
      raw,
      requestedMs: intMs,
      clampedMs: MIN_WAKE_MS,
    });
    return MIN_WAKE_MS;
  }
  return intMs;
}

/**
 * Returns true when the kill switch is engaged. Strict on the value
 * (`"1"` only — not `"true"`, not `"yes"`) so the contract is
 * unambiguous and admins don't get bitten by a near-miss spelling.
 */
function isDisabledByKillSwitch(): boolean {
  return process.env.EZCORP_DISABLE_PERM_SWEEP === "1";
}

// ── Options + class ──────────────────────────────────────────────────

export interface HostMaintenanceDaemonOptions {
  getBus?: () => EventBus<AgentEvents> | null | undefined;
  /** Wake interval (ms). Default `EZCORP_PERM_SWEEP_INTERVAL_MS` env or
   *  3_600_000 (1h). Clamped to ≥1000ms. */
  wakeIntervalMs?: number;
  /** Now-injection for clock-driven tests. Default `() => Date.now()`. */
  now?: () => number;
  /** Disable the PID lockfile (test-only — multiple test daemons can
   *  run sequentially without colliding). */
  skipLockfile?: boolean;
  /** Override the lockfile path for tests (default
   *  `.ezcorp/host-maintenance-daemon.pid`). */
  lockfilePath?: string;
  /** Optional config injection for tests — bypasses env-var lookups
   *  on each tick. When unset, the daemon reads `TTL_CONFIG` /
   *  `getForeverTtlMs()` per-tick (so an admin flip of
   *  `EZCORP_PERM_FOREVER_TTL_DAYS` applies without restart). */
  ttlConfig?: Readonly<Record<CapabilityExpiryKind, number | "never">>;
  foreverTtlMs?: number;
  /**
   * Extension registry for the dynamic-trigger orphan sweep. Injected
   * (the singleton is wired in `startup/background-timers.ts`) rather than
   * imported, so a test drives the sweep with two stub objects and this
   * module keeps no dependency on the registry's spawn/sandbox import
   * graph. Omitted → the sweep sub-tick is a no-op, which is the correct
   * behaviour for every caller that constructs a bare daemon.
   */
  triggerRegistry?: SweepRegistry;
}

/** Outcome of one tick — exposed for tests that want to drive the
 *  daemon synchronously without waiting on the wake interval. */
export interface TickOutcome {
  /** Number of revocations actually written to the DB. */
  applied: number;
  /** Number of revocations that planned to apply but were skipped due
   *  to a concurrent rewrite (race mitigation). */
  skippedConcurrent: number;
  /** Number of audit rows written. 1:1 with applied revocations. */
  audits: number;
  /** Per-extension hard errors (DB connection, FK violation, …). */
  errors: ApplyError[];
  /** What the approval-timeout sub-tick did this pass. */
  approvalTimeouts: ApprovalTimeoutSweepResult;
  /** What the dynamic-trigger orphan sub-tick did this pass. All zeroes
   *  when no registry was injected. */
  triggerSweep: SweepAllResult;
}

/** Zeroed sub-tick result — the shape a tick that swept nothing reports. */
const NO_APPROVAL_TIMEOUTS: ApprovalTimeoutSweepResult = {
  scanned: 0,
  answered: 0,
  aborted: 0,
  deferred: 0,
  raced: 0,
};

/** Zeroed trigger-sweep result — a tick with no registry wired. */
const NO_TRIGGER_SWEEP: SweepAllResult = {
  scanned: 0,
  disabled: 0,
  skipped: 0,
  errored: 0,
};

export class HostMaintenanceDaemon {
  private readonly opts: {
    getBus?: () => EventBus<AgentEvents> | null | undefined;
    wakeIntervalMs: number;
    now: () => number;
    skipLockfile: boolean;
    lockfilePath: string;
    ttlConfig?: Readonly<Record<CapabilityExpiryKind, number | "never">>;
    foreverTtlMs?: number;
    triggerRegistry?: SweepRegistry;
  };
  private timer?: ReturnType<typeof setInterval>;
  private lockfileOwned = false;
  /**
   * Sub-tick counter — incremented after each successful `tickOnce()`
   * (whether the TTL sweep wrote revocations or not). When
   * `tickCount % GIN_SWEEP_TICK_MODULO === 0`, the GIN pending-list
   * sweep fires for the marketplace trigram index. Resets to 0 at
   * construction; persistent across `start()`/`stop()` cycles is not
   * required (a fresh daemon is a fresh boot).
   */
  private tickCount = 0;

  constructor(options?: HostMaintenanceDaemonOptions) {
    // The env-var read here happens at construction time so that tests
    // passing `wakeIntervalMs` explicitly bypass it entirely; production
    // (no override) gets the clamped env-var-resolved value. Either way,
    // the resolved value is clamped to MIN_WAKE_MS.
    const requested = options?.wakeIntervalMs ?? getSweepIntervalMs();
    this.opts = {
      ...(options?.getBus ? { getBus: options.getBus } : {}),
      wakeIntervalMs: Math.max(MIN_WAKE_MS, requested),
      now: options?.now ?? (() => Date.now()),
      skipLockfile: options?.skipLockfile ?? false,
      lockfilePath: options?.lockfilePath ?? DEFAULT_LOCKFILE_PATH,
      ...(options?.ttlConfig !== undefined ? { ttlConfig: options.ttlConfig } : {}),
      ...(options?.foreverTtlMs !== undefined ? { foreverTtlMs: options.foreverTtlMs } : {}),
      ...(options?.triggerRegistry !== undefined
        ? { triggerRegistry: options.triggerRegistry }
        : {}),
    };
  }

  /**
   * Start the daemon.
   *
   * Returns:
   *   - `true` on successful start (lockfile acquired, interval armed).
   *   - `false` when refused — kill switch engaged OR sibling daemon
   *     detected via the PID lockfile.
   *
   * Side-effects (in order):
   *   1. Honor kill switch — if `EZCORP_DISABLE_PERM_SWEEP=1`, log and
   *      return false WITHOUT touching the lockfile (otherwise we'd
   *      orphan a lock owned by a daemon that never ticks).
   *   2. Acquire PID lockfile (refuse start if another daemon is alive).
   *   3. Install the wake interval — first tick fires AFTER one interval
   *      (we don't run-immediately at boot; the host is busy enough).
   *
   * Idempotent: a second call while already-started returns true
   * without rearming the interval.
   */
  async start(): Promise<boolean> {
    if (this.timer) return true;

    if (isDisabledByKillSwitch()) {
      log.warn("perm-expiry sweep disabled by EZCORP_DISABLE_PERM_SWEEP=1");
      return false;
    }

    if (!this.opts.skipLockfile) {
      const acquired = await acquireLockfile(this.opts.lockfilePath);
      if (!acquired) {
        log.warn("host-maintenance-daemon refused to start (sibling alive)", {
          lockfile: this.opts.lockfilePath,
        });
        return false;
      }
      this.lockfileOwned = true;
    }

    this.timer = setInterval(() => {
      void this.tickOnce().catch((err: unknown) =>
        log.warn("tick-failed", { error: String(err) }),
      );
    }, this.opts.wakeIntervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as unknown as { unref: () => void }).unref();
    }
    return true;
  }

  /** Stop the daemon — clears the wake interval and releases the
   *  lockfile (idempotent; a second `stop()` call is a no-op). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.lockfileOwned) {
      void releaseLockfile(this.opts.lockfilePath).catch(() => {});
      this.lockfileOwned = false;
    }
  }

  /**
   * Single sweep pass. Public so tests can drive it directly without a
   * wake-interval wait. Production code should NEVER call this — let
   * the interval drive ticks.
   *
   * Tick errors are caught and logged. The contract is "next tick still
   * fires no matter what" — `setInterval`'s callback already wraps this
   * in a `catch` (see `start()`), but we duplicate the safety net here
   * so direct test calls also see a quiet failure mode.
   */
  async tickOnce(): Promise<TickOutcome> {
    const empty: TickOutcome = {
      applied: 0,
      skippedConcurrent: 0,
      audits: 0,
      errors: [],
      approvalTimeouts: NO_APPROVAL_TIMEOUTS,
      triggerSweep: NO_TRIGGER_SWEEP,
    };
    try {
      const db = getDb();
      const now = this.opts.now();
      const config: {
        ttlConfig?: Readonly<Record<CapabilityExpiryKind, number | "never">>;
        foreverTtlMs?: number;
      } = {};
      if (this.opts.ttlConfig !== undefined) config.ttlConfig = this.opts.ttlConfig;
      else config.ttlConfig = TTL_CONFIG;
      if (this.opts.foreverTtlMs !== undefined) config.foreverTtlMs = this.opts.foreverTtlMs;
      else config.foreverTtlMs = getForeverTtlMs();

      const plan = await runSweep({ db, now, config });
      let outcome: TickOutcome;
      if (plan.revocations.length === 0) {
        log.debug("tick: no revocations", { audits: 0 });
        outcome = empty;
      } else {
        const applied = await applySweepResult(db, plan, now);
        if (applied.errors.length > 0) {
          log.warn("tick: per-extension errors during apply", {
            errorCount: applied.errors.length,
            firstError: applied.errors[0],
            applied: applied.applied,
            skipped: applied.skippedConcurrent,
          });
        } else {
          log.info("tick: sweep applied", {
            applied: applied.applied,
            skipped: applied.skippedConcurrent,
            audits: applied.audits,
          });
        }
        outcome = {
          applied: applied.applied,
          skippedConcurrent: applied.skippedConcurrent,
          audits: applied.audits,
          errors: applied.errors,
          approvalTimeouts: NO_APPROVAL_TIMEOUTS,
          triggerSweep: NO_TRIGGER_SWEEP,
        };
      }

      // Sub-tick: every Nth tick (default 6 → 6h on the default 1h
      // cadence), sweep the marketplace trigram GIN pending list. The
      // counter increments AFTER the TTL sweep so a thrown sweep
      // doesn't skew the GIN counter (the outer catch below handles
      // that). UX-02 (Phase 57-04). Wrapped in try/catch — PGlite may
      // not implement `gin_clean_pending_list`, and an empty pending
      // list isn't an error worth crashing the daemon over.
      this.tickCount++;
      if (this.tickCount % GIN_SWEEP_TICK_MODULO === 0) {
        try {
          await db.execute(
            sql`SELECT gin_clean_pending_list(${GIN_TRGM_INDEX_NAME})`,
          );
          log.debug("tick: gin_clean_pending_list complete", {
            tickCount: this.tickCount,
            index: GIN_TRGM_INDEX_NAME,
          });
        } catch (err) {
          log.warn("tick: gin_clean_pending_list skipped", {
            error: String((err as Error)?.message ?? err),
            tickCount: this.tickCount,
            index: GIN_TRGM_INDEX_NAME,
          });
        }
      }

      // Sub-tick: daily on the default cadence, reap unreferenced
      // workflow-definition versions.
      //
      // `pinnedVersionIds` is where C3 supplies the version ids held by
      // non-revoked delegations. The sweep EXCLUDES pins from its delete
      // set rather than attempting a delete and catching the FK's
      // ON DELETE RESTRICT — catching the violation would make the error
      // the control, which is backwards. C3 adds its ids here; the sweep
      // itself does not change.
      //
      // SUPPLIED as of C3 phase 4, which is also the change that first
      // makes `workflow_delegations` writable. The empty literal that
      // stood here was the truth only while no delegation could exist;
      // leaving it would have turned every pinned snapshot into a
      // RESTRICT violation, and this `catch` logs `warn` and carries on,
      // so the sweep would have stopped reaping permanently, silently,
      // from a line no test can observe. The required field is what made
      // that a compile-time reminder instead of a discovery in
      // production.
      if (this.tickCount % VERSION_SWEEP_TICK_MODULO === 0) {
        try {
          const swept = await sweepWorkflowDefinitionVersions({
            pinnedVersionIds: await listPinnedDelegationVersionIds(),
          });
          if (swept.deleted > 0) {
            log.info("tick: workflow version retention sweep", {
              scanned: swept.scanned,
              deleted: swept.deleted,
              retained: swept.retained,
            });
          }
        } catch (err) {
          // Housekeeping must never take the daemon down.
          log.warn("tick: workflow version sweep skipped", {
            error: String((err as Error)?.message ?? err),
            tickCount: this.tickCount,
          });
        }
      }

      // Sub-tick: apply `onTimeout` to every parked approval whose
      // deadline has passed.
      //
      // No modulo, unlike its two siblings above, and the difference is
      // deliberate. Those are HOUSEKEEPING — a GIN pending list and an
      // unreferenced-version reap — where a slower cadence costs nothing
      // a human can perceive. A timeout is a PROMISE made to the person
      // staring at "Expires in 30 min" in the approvals inbox, so its
      // resolution is bounded by the wake interval and nothing else.
      // C4 §4.4: "the daemon sweeps expired approvals on each tick".
      //
      // The daemon's injected clock is what the sweep selects on, so a
      // test drives a deadline by passing `now` rather than by waiting.
      // Wrapped like its siblings: a parked run nobody can resume must
      // never take the host's maintenance daemon down with it.
      let approvalTimeouts = NO_APPROVAL_TIMEOUTS;
      try {
        approvalTimeouts = await sweepExpiredWorkflowApprovals({ now: new Date(now) });
      } catch (err) {
        log.warn("tick: approval timeout sweep skipped", {
          error: String((err as Error)?.message ?? err),
          tickCount: this.tickCount,
        });
      }

      // Sub-tick: retire dynamic trigger rows whose extension no longer
      // claims them — the ORPHANED TRIGGER THAT STILL FIRES
      // (`./triggers-sweep.ts`). No modulo, like the approval sweep above
      // and unlike the two housekeeping ones: an orphan wakes a
      // subprocess (or records an `undispatched` fire) on every one of its
      // slots until it is retired, so the cost of waiting is proportional
      // to the delay.
      //
      // `sweepAllDynamicTriggers` is FAIL-OPEN per extension and absorbs
      // per-extension failures itself. What it explicitly does NOT absorb
      // is a registry whose iterator throws — that one is this `catch`'s,
      // and it is the same belt-and-braces the siblings carry, because a
      // sweep is housekeeping and must never take the daemon down.
      let triggerSweep = NO_TRIGGER_SWEEP;
      const triggerRegistry = this.opts.triggerRegistry;
      if (triggerRegistry !== undefined) {
        try {
          triggerSweep = await sweepAllDynamicTriggers(triggerRegistry, new Date(now));
        } catch (err) {
          log.warn("tick: dynamic-trigger sweep skipped", {
            error: String((err as Error)?.message ?? err),
            tickCount: this.tickCount,
          });
        }
      }

      try {
        const { purgeExpiredEventReceipts } = await import("../db/queries/extension-event-receipts");
        await db.transaction((transaction: import("../db/migrations/types").MigrationDb) => purgeExpiredEventReceipts(transaction, now));
      } catch (cause) {
        log.warn("tick: event receipt cleanup failed", { error: String(cause), tickCount: this.tickCount });
      }
      try {
        const { reconcileInterruptedAssignments } = await import("../runtime/boot-reconcile-assignments");
        await reconcileInterruptedAssignments(this.opts.getBus?.() ?? undefined, 50);
      } catch (cause) {
        log.warn("tick: task assignment reconciliation failed", { error: String(cause), tickCount: this.tickCount });
      }
      return { ...outcome, approvalTimeouts, triggerSweep };
    } catch (err) {
      log.warn("tick: sweep crashed — daemon continues", {
        error: String((err as Error)?.message ?? err),
      });
      return empty;
    }
  }
}

// ── PID lockfile helpers ──────────────────────────────────────────────
//
// Shared, PID-reuse-safe primitive — see src/startup/process-lockfile.ts
// for the boot-token / self-PID reclaim semantics that fix the
// cross-restart self-deadlock.

/** Test-only export: lets tests inspect/own the lockfile helpers and
 *  verify the kill-switch / env-var resolution paths without standing
 *  up a real daemon instance. */
export const _hostMaintenanceDaemonInternals = {
  acquireLockfile,
  releaseLockfile,
  isProcessAlive,
  isDisabledByKillSwitch,
  DEFAULT_WAKE_MS,
  MIN_WAKE_MS,
  DEFAULT_LOCKFILE_PATH,
};
