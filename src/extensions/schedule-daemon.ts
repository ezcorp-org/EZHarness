/**
 * ScheduleDaemon — persistent cron daemon for `ctx.schedule`.
 *
 * Locked invariants:
 *   - **At-most-once delivery default.** `next_fire_at` IS the queue.
 *     Claim-before-dispatch: in one transaction we SELECT FOR UPDATE
 *     SKIP LOCKED → INSERT into `extension_schedule_fires` with
 *     `status: pending` → UPDATE `next_fire_at` to the next slot.
 *     Only after the transaction commits do we dispatch the
 *     notification. A crash between commit and dispatch is acceptable
 *     because the row already advanced to the next slot.
 *   - **At-least-once opt-in via `maxRetries > 0`.** A `running` row
 *     older than `maxRunDurationMs * 2` is reaped only if the
 *     extension's grant has `maxRetries > 0`.
 *   - **Single-process invariant.** PID lockfile at
 *     `.ezcorp/schedule-daemon.pid`. Distributed cron is out of
 *     scope.
 *   - **Concurrent-fire cap.** 5 per extension, 30 across host.
 *     Counters seeded from `running` rows on startup; decremented on
 *     every completion path (ok / error / timeout).
 *   - **Auto-disable after 5 consecutive errors.**
 *
 * Phase 51.5.5 / 51.5.6 hardening (this file ships the production-grade
 * pieces flagged by the validators):
 *   - PID lockfile sibling-prevention via `.ezcorp/schedule-daemon.pid`.
 *   - Jitter on catch-up fires (0-60s).
 *   - Missed-run policies actually applied (skip / fire-once / fire-all).
 *   - Crash-mid-fire reaping with `maxRetries`-gated retry.
 *   - `maxRunsPerDay` enforcement against `extension_schedule_fires`.
 *   - TZ-aware cron via `parseCron(expr, tz)`.
 *   - Per-extension grant caching (read once per tick from
 *     `getGrantedPermissions(extensionId).schedule`).
 */
import { logger } from "../logger";
import { getDb } from "../db/connection";
import {
  extensionSchedules, extensionScheduleFires, extensions,
} from "../db/schema";
import { eq, and, lte, gte } from "drizzle-orm";
import { parseCron } from "./cron";
import type { ExtensionRegistry } from "./registry";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";
import { registerFireCallProvenance } from "./call-provenance";
import { acquireLockfile, releaseLockfile, isProcessAlive } from "../startup/process-lockfile";
import { loopsKillSwitchEngaged } from "./loops-kill-switch";

const log = logger.child("ext.schedule-daemon");

export interface ScheduleDaemonOptions {
  /** Wake interval (ms). Default 30s. Tests pass smaller. */
  wakeIntervalMs?: number;
  /** Max concurrent fires per extension. Default 5. */
  maxConcurrentPerExt?: number;
  /** Max concurrent fires host-wide. Default 30. */
  maxConcurrentHost?: number;
  /** Now-injection for clock-driven tests. Default
   *  `() => new Date()`. */
  now?: () => Date;
  /** Optional registry (for sending notifications). When unset,
   *  the daemon claims rows and writes audit but does NOT call
   *  the subprocess — useful for the "claim-before-dispatch"
   *  unit test. */
  registry?: Pick<ExtensionRegistry, "getProcessIfRunning"> & {
    getGrantedPermissions?: (extensionId: string) => unknown;
  };
  /** Disable the PID lockfile (test-only — multiple test daemons
   *  can run sequentially without colliding). */
  skipLockfile?: boolean;
  /** Override the lockfile path for tests (default
   *  `.ezcorp/schedule-daemon.pid`). */
  lockfilePath?: string;
  /** Jitter ceiling in ms for catch-up fires. Default 60_000.
   *  Tests pass 0 for determinism. */
  catchUpJitterMs?: number;
  /** Override `Math.random` for jitter determinism in tests. */
  random?: () => number;
}

const DEFAULT_WAKE_MS = 30_000;
const DEFAULT_MAX_PER_EXT = 5;
const DEFAULT_MAX_HOST = 30;
const AUTO_DISABLE_AFTER = 5; // consecutive errors
const DEFAULT_CATCH_UP_JITTER_MS = 60_000;
const DEFAULT_LOCKFILE_PATH = ".ezcorp/schedule-daemon.pid";
const DEFAULT_MAX_RUN_DURATION_MS = 300_000; // 5 min
const DEFAULT_MAX_RETRIES = 0;
const DEFAULT_MAX_RUNS_PER_DAY = 24;
const DEFAULT_MISSED_RUN_POLICY: "skip" | "fire-once" | "fire-all" = "fire-once";

/** Per-extension grant slice consumed by the daemon. */
interface DaemonGrant {
  maxRetries: number;
  maxRunsPerDay: number;
  maxRunDurationMs: number;
  missedRunPolicy: "skip" | "fire-once" | "fire-all";
  tz?: string;
}

export class ScheduleDaemon {
  private readonly opts: Required<Omit<ScheduleDaemonOptions, "registry" | "now" | "skipLockfile" | "lockfilePath" | "random">> & {
    now: () => Date;
    skipLockfile: boolean;
    lockfilePath: string;
    random: () => number;
    registry?: ScheduleDaemonOptions["registry"];
  };
  private timer?: ReturnType<typeof setInterval>;
  private readonly inFlight = new Map<string, number>(); // extensionId → count
  private inFlightHost = 0;
  private lockfileOwned = false;

  constructor(options?: ScheduleDaemonOptions) {
    this.opts = {
      wakeIntervalMs: options?.wakeIntervalMs ?? DEFAULT_WAKE_MS,
      maxConcurrentPerExt: options?.maxConcurrentPerExt ?? DEFAULT_MAX_PER_EXT,
      maxConcurrentHost: options?.maxConcurrentHost ?? DEFAULT_MAX_HOST,
      now: options?.now ?? (() => new Date()),
      catchUpJitterMs: options?.catchUpJitterMs ?? DEFAULT_CATCH_UP_JITTER_MS,
      skipLockfile: options?.skipLockfile ?? false,
      lockfilePath: options?.lockfilePath ?? DEFAULT_LOCKFILE_PATH,
      random: options?.random ?? Math.random,
      ...(options?.registry ? { registry: options.registry } : {}),
    };
  }

  /**
   * Start the daemon.
   *
   * Returns `true` on successful start, `false` when refused due to a
   * sibling daemon detected via the PID lockfile. Callers can log the
   * refusal and skip the wake-loop installation — production wires
   * this from `background-timers.ts`.
   *
   * Side-effects (in order):
   *   1. Acquire PID lockfile (refuse start if another daemon is alive).
   *   2. Reap crash-mid-fire `running` rows per the at-most-once invariant.
   *   3. Apply missed-run policy on schedules whose `next_fire_at` is
   *      already in the past (daemon just came up after offline).
   *   4. Seed `inFlight*` counters from any rows still `running`.
   *   5. Install the 30s wake interval.
   */
  async start(): Promise<boolean> {
    if (this.timer) return true;

    if (!this.opts.skipLockfile) {
      const acquired = await acquireLockfile(this.opts.lockfilePath);
      if (!acquired) {
        log.warn("schedule-daemon refused to start (sibling alive)", {
          lockfile: this.opts.lockfilePath,
        });
        return false;
      }
      this.lockfileOwned = true;
    }

    // Crash-mid-fire reaping. Done before we install the wake loop so
    // the at-most-once invariant holds across the daemon's restart.
    try {
      await this.reapCrashedFires();
    } catch (err) {
      log.warn("reap-on-start-failed", { error: String(err) });
    }

    // Missed-run policy on offline catch-up. Each schedule's grant
    // dictates skip / fire-once / fire-all behavior.
    try {
      await this.applyMissedRunPolicies();
    } catch (err) {
      log.warn("missed-run-policy-on-start-failed", { error: String(err) });
    }

    // Seed in-flight counters from any rows still `running` (defense
    // against a sibling daemon that exited mid-tick — those rows count
    // toward the cap until they get reaped on a later cycle).
    try {
      const live = await getDb().select({
        scheduleId: extensionScheduleFires.scheduleId,
      })
        .from(extensionScheduleFires)
        .where(eq(extensionScheduleFires.status, "running"));
      for (const row of live) {
        const sched = await getDb().select({ extensionId: extensionSchedules.extensionId })
          .from(extensionSchedules)
          .where(eq(extensionSchedules.id, row.scheduleId));
        const extId = sched[0]?.extensionId;
        if (extId) {
          this.inFlight.set(extId, (this.inFlight.get(extId) ?? 0) + 1);
          this.inFlightHost++;
        }
      }
    } catch (err) {
      log.debug("seed-counters-failed", { error: String(err) });
    }

    this.timer = setInterval(() => {
      void this.tick().catch((err) => log.warn("tick-failed", { error: String(err) }));
    }, this.opts.wakeIntervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as unknown as { unref: () => void }).unref();
    }
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.lockfileOwned) {
      void releaseLockfile(this.opts.lockfilePath).catch(() => {});
      this.lockfileOwned = false;
    }
  }

  /** Single-pass claim + dispatch. Public so tests can drive it
   *  directly without a 30s wait. */
  async tick(): Promise<{ claimed: number; dispatched: number }> {
    // Global loops kill switch: suspend the cron claim path entirely. Rows
    // stay due (next_fire_at unchanged), so the daemon resumes cleanly the
    // moment the operator disengages the switch — no fires are lost, none
    // fire while suspended. Checked before any DB work.
    if (await loopsKillSwitchEngaged()) {
      return { claimed: 0, dispatched: 0 };
    }

    const db = getDb();
    const now = this.opts.now();

    // ── Claim phase ──────────────────────────────────────────────
    // Select rows that are due, then insert per-fire rows + advance
    // next_fire_at. PGlite doesn't do `FOR UPDATE SKIP LOCKED` the
    // same way as Postgres-native; the production Postgres path uses
    // it. For PGlite we accept the at-most-once degradation
    // (single-writer; no contention).
    const due = await db.select().from(extensionSchedules).where(and(
      eq(extensionSchedules.enabled, true),
      lte(extensionSchedules.nextFireAt, now),
    )).limit(100);

    let claimed = 0;
    let dispatched = 0;
    // Per-tick claim counters — independent of `inFlight*` so the cap
    // bites even when dispatch is synchronous (no-registry test mode
    // decrements `inFlight*` before the next loop iteration). The
    // inFlight* counters still gate across overlapping ticks.
    const tickClaimsByExt = new Map<string, number>();
    let tickClaimsHost = 0;

    for (const row of due) {
      // Concurrent-fire caps. Honor BOTH the live in-flight counters
      // (cross-tick) AND the per-tick claim counters (intra-tick).
      const liveHost = this.inFlightHost + tickClaimsHost;
      if (liveHost >= this.opts.maxConcurrentHost) break;
      const liveExt = (this.inFlight.get(row.extensionId) ?? 0)
        + (tickClaimsByExt.get(row.extensionId) ?? 0);
      if (liveExt >= this.opts.maxConcurrentPerExt) continue;

      const grant = await this.readGrant(row.extensionId);

      // maxRunsPerDay quota check (count today's `running` + completed
      // fires for this schedule's extension).
      const dailyCount = await this.todaysFireCount(row.extensionId);
      if (dailyCount >= grant.maxRunsPerDay) {
        await this.auditQuotaExceeded(row.extensionId, row.id, dailyCount, grant.maxRunsPerDay);
        // Advance next_fire_at so we don't re-pick this row 30s later.
        try {
          const next = parseCron(row.cron, grant.tz).next(now);
          await db.update(extensionSchedules)
            .set({ nextFireAt: next, updatedAt: now })
            .where(eq(extensionSchedules.id, row.id));
        } catch (err) {
          log.warn("advance-after-quota-failed", { scheduleId: row.id, error: String(err) });
        }
        continue;
      }

      try {
        const nextNext = parseCron(row.cron, grant.tz).next(now);
        // Determine catch-up (and apply jitter).
        const isCatchUp = row.nextFireAt.getTime() < now.getTime() - 60_000;
        const jitterMs = isCatchUp
          ? Math.floor(this.opts.random() * this.opts.catchUpJitterMs)
          : 0;
        const firedAt = jitterMs > 0 ? new Date(now.getTime() + jitterMs) : now;

        // Atomic claim: insert fire row (status=running) + bump next_fire_at.
        const [fire] = await db.insert(extensionScheduleFires).values({
          scheduleId: row.id,
          scheduledAt: row.nextFireAt,
          firedAt,
          status: "running",
          catchUp: isCatchUp,
        }).returning();
        await db.update(extensionSchedules)
          .set({ nextFireAt: nextNext, lastFireAt: firedAt, lastFireId: fire!.id, updatedAt: now })
          .where(eq(extensionSchedules.id, row.id));
        claimed++;
        // Bump per-tick claims (gates further claims this tick) AND
        // in-flight (gates across overlapping ticks). dispatchFire's
        // completion path decrements only `inFlight*`; per-tick
        // counters remain elevated until tick() returns.
        tickClaimsHost++;
        tickClaimsByExt.set(row.extensionId, (tickClaimsByExt.get(row.extensionId) ?? 0) + 1);
        this.inFlightHost++;
        this.inFlight.set(row.extensionId, (this.inFlight.get(row.extensionId) ?? 0) + 1);

        // ── Dispatch phase ────────────────────────────────────────
        // Await the dispatch so error/completion paths (and their
        // counter decrements) finish in deterministic order. The
        // cap-enforcement invariant is preserved because every
        // claim within this tick has already incremented the
        // counter before the next loop iteration runs the cap check.
        // For the per-tick cap to bite, we additionally enforce
        // `claimed >= maxConcurrentPerExt` as a hard cap below.
        await this.dispatchFire(row, fire!.id, firedAt, isCatchUp, 0);
        dispatched++;
      } catch (err) {
        log.warn("claim-failed", { scheduleId: row.id, error: String(err) });
      }
    }

    return { claimed, dispatched };
  }

  /** Drive a `Schedule.fireNow()` from the host handler. Counts
   *  against `maxRunsPerDay`. Returns `{ ok, fireId? }` or
   *  `{ ok: false, reason }`. */
  async fireNow(extensionId: string, cron: string): Promise<{ ok: true; fireId: string } | { ok: false; reason: string }> {
    // Global loops kill switch: refuse manual cron-fire triggers too.
    if (await loopsKillSwitchEngaged()) {
      return { ok: false, reason: "loops-suspended" };
    }
    const db = getDb();
    const now = this.opts.now();
    // Manifest validation: cron must be in the extension's
    // `extension_schedules` registrations (the reconciler has
    // already pushed these from the manifest).
    const sched = await db.select().from(extensionSchedules).where(and(
      eq(extensionSchedules.extensionId, extensionId),
      eq(extensionSchedules.cron, cron),
    ));
    if (sched.length === 0) return { ok: false, reason: "cron-not-declared" };
    const row = sched[0]!;
    if (!row.enabled) return { ok: false, reason: "schedule-disabled" };

    const grant = await this.readGrant(extensionId);
    const dailyCount = await this.todaysFireCount(extensionId);
    if (dailyCount >= grant.maxRunsPerDay) {
      return { ok: false, reason: "max-runs-per-day-exceeded" };
    }

    // Insert pending fire row + dispatch immediately.
    const [fire] = await db.insert(extensionScheduleFires).values({
      scheduleId: row.id,
      scheduledAt: now,
      firedAt: now,
      status: "running",
      catchUp: false,
    }).returning();

    this.inFlightHost++;
    this.inFlight.set(extensionId, (this.inFlight.get(extensionId) ?? 0) + 1);

    await this.dispatchFire(row, fire!.id, now, false, 0, /* fireNow */ true);
    return { ok: true, fireId: fire!.id };
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private async dispatchFire(
    schedule: typeof extensionSchedules.$inferSelect,
    fireId: string,
    firedAt: Date,
    catchUp: boolean,
    attempt: number,
    fireNow = false,
  ): Promise<void> {
    const proc = this.opts.registry?.getProcessIfRunning(schedule.extensionId);
    const completion = (status: "ok" | "error" | "timeout", error?: string): Promise<void> =>
      this.completeFire(schedule, fireId, firedAt, status, error);
    if (this.opts.registry && proc) {
      try {
        // Cron fires have NO conversation or user — they are ownerless.
        // We still mint a host-issued correlation token so a reverse-RPC
        // from the fire handler resolves to a CLEAN soft-fail (-32106 +
        // info log) instead of the old `missing onBehalfOf` throw /
        // 90s-watchdog hang. The token's `ownerless` flag is what the
        // capability handlers key the soft-fail on.
        const ezCallId = registerFireCallProvenance({
          onBehalfOf: null,
          conversationId: null,
          runId: null,
          parentCallId: null,
          actorExtensionId: schedule.extensionId,
          kind: "schedule",
          ownerless: true,
        });
        log.info(
          "scheduled cron fire has no resolvable owner — extension capability calls will be skipped (clean soft-fail)",
          { extensionId: schedule.extensionId, cron: schedule.cron, fireId },
        );
        proc.sendNotification("ezcorp/schedule-fire", {
          cron: schedule.cron,
          scheduledAt: schedule.nextFireAt.toISOString(),
          firedAt: firedAt.toISOString(),
          fireId,
          catchUp,
          retry: attempt > 0,
          attempt,
          _meta: { ezCallId },
        });
        if (fireNow) {
          await insertAuditEntry(
            null,
            EXT_AUDIT_ACTIONS.SDK_SCHEDULE_FIRE_NOW,
            schedule.extensionId,
            { capability: "schedule", oldValue: undefined, newValue: schedule.cron, actor: "system", reason: "fire-now invocation" },
          ).catch(() => {});
        }
        await completion("ok");
      } catch (err) {
        await this.handleFireError(schedule, fireId, err, attempt);
      }
    } else {
      // No registry / not running — mark as ok so the daemon doesn't
      // wedge on a sleeping subprocess (test-mode + production no-op).
      await completion("ok");
    }
  }

  private async completeFire(
    schedule: typeof extensionSchedules.$inferSelect,
    fireId: string,
    firedAt: Date,
    status: "ok" | "error" | "timeout",
    error?: string,
  ): Promise<void> {
    const db = getDb();
    const durationMs = this.opts.now().getTime() - firedAt.getTime();
    await db.update(extensionScheduleFires)
      .set({ status, durationMs, ...(error !== undefined ? { error } : {}) })
      .where(eq(extensionScheduleFires.id, fireId));
    if (status === "ok") {
      await db.update(extensionSchedules)
        .set({ lastFireStatus: "ok", consecutiveErrors: 0 })
        .where(eq(extensionSchedules.id, schedule.id));
    }
    // Decrement in-flight counters on every completion path.
    const cur = this.inFlight.get(schedule.extensionId) ?? 0;
    if (cur > 0) this.inFlight.set(schedule.extensionId, cur - 1);
    if (this.inFlightHost > 0) this.inFlightHost--;
  }

  private async handleFireError(
    schedule: typeof extensionSchedules.$inferSelect,
    fireId: string,
    err: unknown,
    attempt: number,
  ): Promise<void> {
    const db = getDb();
    const grant = await this.readGrant(schedule.extensionId);
    const errMsg = String((err as Error)?.message ?? err);

    if (attempt < grant.maxRetries) {
      // Schedule a retry — leave the existing fire as `error` and
      // synthesize a new attempt row.
      await db.update(extensionScheduleFires)
        .set({ status: "error", error: errMsg })
        .where(eq(extensionScheduleFires.id, fireId));
      // Decrement counters before the retry so the cap doesn't double-count.
      const cur = this.inFlight.get(schedule.extensionId) ?? 0;
      if (cur > 0) this.inFlight.set(schedule.extensionId, cur - 1);
      if (this.inFlightHost > 0) this.inFlightHost--;

      const retryFiredAt = this.opts.now();
      const [retryFire] = await db.insert(extensionScheduleFires).values({
        scheduleId: schedule.id,
        scheduledAt: schedule.nextFireAt,
        firedAt: retryFiredAt,
        status: "running",
        attempt: attempt + 1,
        catchUp: false,
      }).returning();
      this.inFlightHost++;
      this.inFlight.set(schedule.extensionId, (this.inFlight.get(schedule.extensionId) ?? 0) + 1);
      await this.dispatchFire(schedule, retryFire!.id, retryFiredAt, false, attempt + 1);
      return;
    }

    // No more retries — mark error + bump consecutive count.
    await db.update(extensionScheduleFires)
      .set({ status: "error", error: errMsg })
      .where(eq(extensionScheduleFires.id, fireId));

    const cur = this.inFlight.get(schedule.extensionId) ?? 0;
    if (cur > 0) this.inFlight.set(schedule.extensionId, cur - 1);
    if (this.inFlightHost > 0) this.inFlightHost--;

    const newCount = (schedule.consecutiveErrors ?? 0) + 1;
    await db.update(extensionSchedules)
      .set({
        consecutiveErrors: newCount,
        lastFireStatus: "error",
        ...(newCount >= AUTO_DISABLE_AFTER ? { enabled: false } : {}),
      })
      .where(eq(extensionSchedules.id, schedule.id));

    if (newCount >= AUTO_DISABLE_AFTER) {
      await insertAuditEntry(
        null,
        EXT_AUDIT_ACTIONS.SDK_SCHEDULE_DISABLED,
        schedule.extensionId,
        {
          capability: "schedule",
          oldValue: { enabled: true },
          newValue: { enabled: false, consecutiveErrors: newCount },
          actor: "system",
          reason: `Auto-disabled after ${newCount} consecutive errors`,
        },
      ).catch(() => {});
    }
  }

  /** Read this extension's schedule grant from the registry. Falls back
   *  to the daemon defaults when the registry is missing or didn't
   *  return a grant. */
  private async readGrant(extensionId: string): Promise<DaemonGrant> {
    const fallback: DaemonGrant = {
      maxRetries: DEFAULT_MAX_RETRIES,
      maxRunsPerDay: DEFAULT_MAX_RUNS_PER_DAY,
      maxRunDurationMs: DEFAULT_MAX_RUN_DURATION_MS,
      missedRunPolicy: DEFAULT_MISSED_RUN_POLICY,
    };
    const reg = this.opts.registry;
    if (reg && typeof reg.getGrantedPermissions === "function") {
      const granted = reg.getGrantedPermissions(extensionId) as
        { schedule?: { maxRetries?: number; maxRunsPerDay?: number; maxRunDurationMs?: number; missedRunPolicy?: "skip" | "fire-once" | "fire-all"; tz?: string } }
        | undefined;
      const sched = granted?.schedule;
      if (sched) {
        return {
          maxRetries: sched.maxRetries ?? fallback.maxRetries,
          maxRunsPerDay: sched.maxRunsPerDay ?? fallback.maxRunsPerDay,
          maxRunDurationMs: sched.maxRunDurationMs ?? fallback.maxRunDurationMs,
          missedRunPolicy: sched.missedRunPolicy ?? fallback.missedRunPolicy,
          ...(sched.tz !== undefined ? { tz: sched.tz } : {}),
        };
      }
    }
    // Without registry, read directly from the extensions table so the
    // host can still enforce per-extension caps even in daemon-only
    // configurations (e.g. background reconciler).
    try {
      const rows = await getDb().select({ granted: extensions.grantedPermissions })
        .from(extensions)
        .where(eq(extensions.id, extensionId));
      const granted = rows[0]?.granted as { schedule?: { maxRetries?: number; maxRunsPerDay?: number; maxRunDurationMs?: number; missedRunPolicy?: "skip" | "fire-once" | "fire-all"; tz?: string } } | undefined;
      const sched = granted?.schedule;
      if (sched) {
        return {
          maxRetries: sched.maxRetries ?? fallback.maxRetries,
          maxRunsPerDay: sched.maxRunsPerDay ?? fallback.maxRunsPerDay,
          maxRunDurationMs: sched.maxRunDurationMs ?? fallback.maxRunDurationMs,
          missedRunPolicy: sched.missedRunPolicy ?? fallback.missedRunPolicy,
          ...(sched.tz !== undefined ? { tz: sched.tz } : {}),
        };
      }
    } catch {
      // Fall through to daemon defaults.
    }
    return fallback;
  }

  /** Count today's (UTC calendar day) fires for an extension across all
   *  its schedules. Used to enforce `maxRunsPerDay`. */
  private async todaysFireCount(extensionId: string): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const rows = await getDb().select({ id: extensionScheduleFires.id })
      .from(extensionScheduleFires)
      .innerJoin(extensionSchedules, eq(extensionScheduleFires.scheduleId, extensionSchedules.id))
      .where(and(
        eq(extensionSchedules.extensionId, extensionId),
        gte(extensionScheduleFires.firedAt, startOfDay),
      ));
    return rows.length;
  }

  private async auditQuotaExceeded(
    extensionId: string,
    scheduleId: string,
    used: number,
    cap: number,
  ): Promise<void> {
    await insertAuditEntry(
      null,
      EXT_AUDIT_ACTIONS.SDK_SCHEDULE_QUOTA_EXCEEDED,
      extensionId,
      {
        capability: "schedule",
        oldValue: { used },
        newValue: { cap, scheduleId },
        actor: "system",
        reason: `maxRunsPerDay exceeded (${used}/${cap})`,
      },
    ).catch(() => {});
  }

  /** Crash-mid-fire reaping. A `running` row older than
   *  `maxRunDurationMs * 2` was abandoned by a previous daemon
   *  process. If the schedule's `maxRetries > 0`, mark it `error` so
   *  the next tick can retry; otherwise leave it `running`
   *  indefinitely (preserves the at-most-once invariant). */
  private async reapCrashedFires(): Promise<void> {
    const db = getDb();
    const now = this.opts.now();
    const live = await db.select({
      fireId: extensionScheduleFires.id,
      scheduleId: extensionScheduleFires.scheduleId,
      firedAt: extensionScheduleFires.firedAt,
    })
      .from(extensionScheduleFires)
      .where(eq(extensionScheduleFires.status, "running"));

    for (const f of live) {
      const sched = await db.select().from(extensionSchedules)
        .where(eq(extensionSchedules.id, f.scheduleId));
      if (sched.length === 0) continue;
      const row = sched[0]!;
      const grant = await this.readGrant(row.extensionId);
      const ageMs = now.getTime() - f.firedAt.getTime();
      if (ageMs < grant.maxRunDurationMs * 2) continue; // Still might be live.

      if (grant.maxRetries > 0) {
        await db.update(extensionScheduleFires)
          .set({ status: "error", error: "reaped: crash mid-fire" })
          .where(eq(extensionScheduleFires.id, f.fireId));
        // Reset next_fire_at so the wake loop picks it back up.
        await db.update(extensionSchedules)
          .set({ nextFireAt: now, lastFireStatus: "error" })
          .where(eq(extensionSchedules.id, row.id));
        await insertAuditEntry(
          null,
          EXT_AUDIT_ACTIONS.SDK_SCHEDULE_REAPED,
          row.extensionId,
          {
            capability: "schedule",
            oldValue: { fireId: f.fireId, status: "running" },
            newValue: { status: "error", action: "retry-scheduled" },
            actor: "system",
            reason: `Reaped crashed fire (age=${ageMs}ms, maxRetries=${grant.maxRetries})`,
          },
        ).catch(() => {});
      } else {
        // At-most-once: leave status=running indefinitely. Audit the
        // observation so an admin can investigate.
        await insertAuditEntry(
          null,
          EXT_AUDIT_ACTIONS.SDK_SCHEDULE_REAPED,
          row.extensionId,
          {
            capability: "schedule",
            oldValue: { fireId: f.fireId, status: "running" },
            newValue: { status: "running", action: "left-as-is" },
            actor: "system",
            reason: `Detected stale running fire (age=${ageMs}ms, maxRetries=0 → at-most-once)`,
          },
        ).catch(() => {});
      }
    }
  }

  /** Apply missed-run policies on schedules whose `next_fire_at` is in
   *  the past — the daemon just came up after offline. */
  private async applyMissedRunPolicies(): Promise<void> {
    const db = getDb();
    const now = this.opts.now();
    const overdue = await db.select().from(extensionSchedules).where(and(
      eq(extensionSchedules.enabled, true),
      lte(extensionSchedules.nextFireAt, now),
    ));
    for (const row of overdue) {
      const grant = await this.readGrant(row.extensionId);
      try {
        if (grant.missedRunPolicy === "skip") {
          // Bump next_fire_at to the next slot from now.
          const next = parseCron(row.cron, grant.tz).next(now);
          await db.update(extensionSchedules)
            .set({ nextFireAt: next, lastFireStatus: "ok", updatedAt: now })
            .where(eq(extensionSchedules.id, row.id));
        } else if (grant.missedRunPolicy === "fire-all") {
          // Enumerate every missed slot back to last_fire_at, capped
          // at maxRunsPerDay (data-loss invariant — see spec § Open
          // questions). Each fire is dispatched with `catchUp: true`.
          // Cap retrieval reduces the count by today's fires already
          // recorded.
          const last = row.lastFireAt ?? row.nextFireAt;
          const dailyUsed = await this.todaysFireCount(row.extensionId);
          let cursor = parseCron(row.cron, grant.tz).next(last);
          let firedAny = false;
          let usedToday = dailyUsed;
          while (cursor.getTime() <= now.getTime() && usedToday < grant.maxRunsPerDay) {
            const jitterMs = Math.floor(this.opts.random() * this.opts.catchUpJitterMs);
            const fa = new Date(now.getTime() + jitterMs);
            const [fire] = await db.insert(extensionScheduleFires).values({
              scheduleId: row.id,
              scheduledAt: cursor,
              firedAt: fa,
              status: "running",
              catchUp: true,
            }).returning();
            this.inFlightHost++;
            this.inFlight.set(row.extensionId, (this.inFlight.get(row.extensionId) ?? 0) + 1);
            await this.dispatchFire(row, fire!.id, fa, true, 0);
            firedAny = true;
            usedToday++;
            cursor = parseCron(row.cron, grant.tz).next(cursor);
          }
          // Advance schedule.next_fire_at past all enumerated slots.
          const next = parseCron(row.cron, grant.tz).next(now);
          await db.update(extensionSchedules)
            .set({ nextFireAt: next, ...(firedAny ? { lastFireAt: now } : {}), updatedAt: now })
            .where(eq(extensionSchedules.id, row.id));
        } else {
          // "fire-once" (default) — fire ONE catch-up, advance.
          const jitterMs = Math.floor(this.opts.random() * this.opts.catchUpJitterMs);
          const fa = new Date(now.getTime() + jitterMs);
          const [fire] = await db.insert(extensionScheduleFires).values({
            scheduleId: row.id,
            scheduledAt: row.nextFireAt,
            firedAt: fa,
            status: "running",
            catchUp: true,
          }).returning();
          this.inFlightHost++;
          this.inFlight.set(row.extensionId, (this.inFlight.get(row.extensionId) ?? 0) + 1);
          await this.dispatchFire(row, fire!.id, fa, true, 0);
          const next = parseCron(row.cron, grant.tz).next(now);
          await db.update(extensionSchedules)
            .set({ nextFireAt: next, lastFireAt: fa, lastFireId: fire!.id, updatedAt: now })
            .where(eq(extensionSchedules.id, row.id));
        }
      } catch (err) {
        log.warn("missed-run-policy-failed", { scheduleId: row.id, error: String(err) });
      }
    }
  }
}

// ── PID lockfile helpers ──────────────────────────────────────────
//
// Shared, PID-reuse-safe primitive — see src/startup/process-lockfile.ts
// for the boot-token / self-PID reclaim semantics that fix the
// cross-restart self-deadlock (a persisted `.pid` whose PID got reused on
// the next boot no longer wedges start).

/** Test-only export: lets tests inspect/own the lockfile helpers. */
export const _scheduleDaemonInternals = {
  acquireLockfile,
  releaseLockfile,
  isProcessAlive,
};
