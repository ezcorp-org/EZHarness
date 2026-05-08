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

import { logger } from "../logger";
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
}

export class HostMaintenanceDaemon {
  private readonly opts: {
    wakeIntervalMs: number;
    now: () => number;
    skipLockfile: boolean;
    lockfilePath: string;
    ttlConfig?: Readonly<Record<CapabilityExpiryKind, number | "never">>;
    foreverTtlMs?: number;
  };
  private timer?: ReturnType<typeof setInterval>;
  private lockfileOwned = false;

  constructor(options?: HostMaintenanceDaemonOptions) {
    // The env-var read here happens at construction time so that tests
    // passing `wakeIntervalMs` explicitly bypass it entirely; production
    // (no override) gets the clamped env-var-resolved value. Either way,
    // the resolved value is clamped to MIN_WAKE_MS.
    const requested = options?.wakeIntervalMs ?? getSweepIntervalMs();
    this.opts = {
      wakeIntervalMs: Math.max(MIN_WAKE_MS, requested),
      now: options?.now ?? (() => Date.now()),
      skipLockfile: options?.skipLockfile ?? false,
      lockfilePath: options?.lockfilePath ?? DEFAULT_LOCKFILE_PATH,
      ...(options?.ttlConfig !== undefined ? { ttlConfig: options.ttlConfig } : {}),
      ...(options?.foreverTtlMs !== undefined ? { foreverTtlMs: options.foreverTtlMs } : {}),
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
      if (plan.revocations.length === 0) {
        log.debug("tick: no revocations", { audits: 0 });
        return empty;
      }
      const outcome = await applySweepResult(db, plan, now);
      if (outcome.errors.length > 0) {
        log.warn("tick: per-extension errors during apply", {
          errorCount: outcome.errors.length,
          firstError: outcome.errors[0],
          applied: outcome.applied,
          skipped: outcome.skippedConcurrent,
        });
      } else {
        log.info("tick: sweep applied", {
          applied: outcome.applied,
          skipped: outcome.skippedConcurrent,
          audits: outcome.audits,
        });
      }
      return {
        applied: outcome.applied,
        skippedConcurrent: outcome.skippedConcurrent,
        audits: outcome.audits,
        errors: outcome.errors,
      };
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
// Inlined copy of the same primitives in `./schedule-daemon.ts`. See the
// module header for why this is duplicated rather than extracted —
// short version: tiny scope, one extra caller, refactor when a third
// daemon shows up.

async function ensureDir(path: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  if (dir && dir !== ".") await fs.mkdir(dir, { recursive: true });
}

/** Returns true when the process for `pid` is alive on this host. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "EPERM"; // process exists but owned by another user
  }
}

async function acquireLockfile(path: string): Promise<boolean> {
  await ensureDir(path);
  const file = Bun.file(path);
  if (await file.exists()) {
    const text = (await file.text()).trim();
    const pid = parseInt(text, 10);
    // Refuse if the lockfile points at ANY live process — including
    // ours. Same rationale as schedule-daemon: a second daemon in the
    // same process means double-wiring, and that's a bug we want to
    // catch loudly.
    if (Number.isFinite(pid) && isProcessAlive(pid)) {
      return false;
    }
    // Stale lock — overwrite.
  }
  await Bun.write(path, String(process.pid));
  return true;
}

async function releaseLockfile(path: string): Promise<void> {
  try {
    const fs = await import("node:fs/promises");
    await fs.unlink(path);
  } catch {
    // Already gone — fine.
  }
}

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
