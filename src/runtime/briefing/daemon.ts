/**
 * BriefingDaemon — the Daily Briefing scheduler (spec §5.1).
 *
 * Borrows the ScheduleDaemon's PATTERNS without touching its locked
 * invariants (src/extensions/schedule-daemon.ts is untouched):
 *
 *   - **Claim-before-dispatch / at-most-once.** `next_fire_at` IS the
 *     queue. `claimDueBriefingConfigs` advances it inside one
 *     transaction (SELECT … FOR UPDATE SKIP LOCKED) BEFORE any
 *     dispatch, so a crash between commit and dispatch loses at most
 *     one fire and never double-fires.
 *   - **Missed-run policy: hardcoded fire-once** (locked decision
 *     §6.4). The claim advances from `now`, never enumerating missed
 *     slots; the boot tick in `start()` is what catches up a host that
 *     slept through 7am. Catch-up fires (> 60s past the slot) are
 *     flagged so the agent can say "while you were away".
 *   - **Auto-disable after 5 consecutive errors** — bookkeeping lives
 *     in `recordBriefingFireResult`; the daemon posts the one-time
 *     notification conversation on the disable transition.
 *   - **Single-process guard via the background-timers `started`
 *     flag** (spec §2) — no PID lockfile: the daemon is constructed
 *     only from `startBackgroundTimers()`, whose module-level
 *     singleton flag already prevents double-wiring.
 *
 * Concurrency cap: 3 simultaneous briefing runs host-wide (small
 * instances). The per-tick claim limit is `maxConcurrent - inFlight`,
 * so overlapping ticks can never exceed the cap.
 *
 * A guard timeout (`guardTimeoutMs`, default per-fire timeout + 30s
 * grace) bounds a pathologically hung pipeline so a wedged run can
 * never permanently occupy a concurrency slot — the pipeline's own
 * per-fire timeout (run.ts) is the primary cancellation path.
 *
 * Fail-safe: when the briefing runtime (executor + bus) was never
 * registered — backend-only boot, or a boot-ordering race — the tick
 * is a logged no-op that does NOT claim, so nothing is consumed and
 * no consecutive-errors accrue for an operational condition.
 */
import {
  claimDueBriefingConfigs,
  recordBriefingFireResult,
  type BriefingConfig,
  type ClaimedBriefing,
} from "../../db/queries/briefing-configs";
import type { BriefingRunResult } from "./run";
import { getBriefingRuntime } from "./runtime-registry";
import { logger } from "../../logger";

const log = logger.child("briefing.daemon");

const DEFAULT_WAKE_MS = 60_000;
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_RUN_TIMEOUT_MS = 300_000; // 5 min, spec §5.1
const GUARD_GRACE_MS = 30_000;
/** A fire whose slot is more than this far in the past is a catch-up
 *  (host was offline at the scheduled time). Mirrors ScheduleDaemon. */
const CATCH_UP_THRESHOLD_MS = 60_000;

export interface BriefingDaemonOptions {
  /** Wake interval (ms). Default 60s. Tests pass smaller. */
  wakeIntervalMs?: number;
  /** Max simultaneous briefing runs host-wide. Default 3. */
  maxConcurrent?: number;
  /** Per-fire timeout forwarded to the run pipeline. Default 5 min. */
  runTimeoutMs?: number;
  /** Hard ceiling on a single dispatch (slot-release guard). Default
   *  `runTimeoutMs + 30s`. Tests pass smaller. */
  guardTimeoutMs?: number;
  /** Now-injection for clock-driven tests. */
  now?: () => Date;
  /** Pipeline injection for tests. Default lazily imports
   *  `runBriefingForUser` and threads `runTimeoutMs` through. */
  runPipeline?: (config: BriefingConfig, opts: { catchUp: boolean }) => Promise<BriefingRunResult>;
  /** Auto-disable notification injection. Default lazily imports
   *  `notifyBriefingAutoDisabled`. */
  onAutoDisable?: (config: BriefingConfig, consecutiveErrors: number) => Promise<void>;
}

export interface BriefingTickResult {
  claimed: number;
  /** Resolves when every dispatch from THIS tick has completed its
   *  bookkeeping. Tests await it; production fire-and-forgets. */
  settled: Promise<void>;
}

export class BriefingDaemon {
  private readonly opts: Required<Pick<BriefingDaemonOptions, "wakeIntervalMs" | "maxConcurrent" | "runTimeoutMs" | "guardTimeoutMs">> & {
    now: () => Date;
    runPipeline?: BriefingDaemonOptions["runPipeline"];
    onAutoDisable?: BriefingDaemonOptions["onAutoDisable"];
  };
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = 0;

  constructor(options?: BriefingDaemonOptions) {
    const runTimeoutMs = options?.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.opts = {
      wakeIntervalMs: options?.wakeIntervalMs ?? DEFAULT_WAKE_MS,
      maxConcurrent: options?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      runTimeoutMs,
      guardTimeoutMs: options?.guardTimeoutMs ?? runTimeoutMs + GUARD_GRACE_MS,
      now: options?.now ?? (() => new Date()),
      ...(options?.runPipeline ? { runPipeline: options.runPipeline } : {}),
      ...(options?.onAutoDisable ? { onAutoDisable: options.onAutoDisable } : {}),
    };
  }

  /**
   * Start the daemon: one immediate boot tick (the fire-once offline
   * catch-up — a host that slept through 7am fires once now), then the
   * recurring wake interval. Returns true; the boolean return mirrors
   * the sibling daemons' contract so background-timers' fail-safe
   * wiring stays uniform.
   */
  async start(): Promise<boolean> {
    if (this.timer) return true;

    // Boot catch-up tick. Claim errors must not block boot.
    try {
      await this.tick();
    } catch (err) {
      log.warn("boot tick failed", { error: String(err) });
    }

    this.timer = setInterval(() => {
      void this.tick().catch((err) => log.warn("tick failed", { error: String(err) }));
    }, this.opts.wakeIntervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as unknown as { unref: () => void }).unref();
    }
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Test-only visibility into the concurrency gauge. */
  _getInFlightForTests(): number {
    return this.inFlight;
  }

  /**
   * Single claim + dispatch pass. Public so tests can drive it without
   * waiting on the wake interval. Dispatches are NOT awaited here —
   * the returned `settled` promise tracks them so overlapping ticks
   * see the live `inFlight` gauge (that's what makes the cap bite
   * across ticks).
   */
  async tick(): Promise<BriefingTickResult> {
    const now = this.opts.now();

    // Fail-safe: without a runtime (and no injected pipeline) we must
    // NOT claim — claiming would consume the slot and the dispatch
    // would only manufacture a consecutive-errors increment for what
    // is an operational boot-ordering condition.
    if (!this.opts.runPipeline && !getBriefingRuntime()) {
      log.debug("tick skipped — briefing runtime not registered");
      return { claimed: 0, settled: Promise.resolve() };
    }

    const capacity = this.opts.maxConcurrent - this.inFlight;
    if (capacity <= 0) {
      return { claimed: 0, settled: Promise.resolve() };
    }

    const claimed = await claimDueBriefingConfigs(now, capacity);
    if (claimed.length === 0) {
      return { claimed: 0, settled: Promise.resolve() };
    }

    const dispatches = claimed.map((c) =>
      this.dispatch(c, now).catch((err) => {
        // dispatch() itself folds every failure — this is belt-and-
        // suspenders so one rejected dispatch can't break Promise.all.
        log.warn("dispatch escaped its error fold", { userId: c.config.userId, error: String(err) });
      }),
    );

    return {
      claimed: claimed.length,
      settled: Promise.all(dispatches).then(() => undefined),
    };
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async dispatch(claim: ClaimedBriefing, now: Date): Promise<void> {
    const { config, scheduledFor } = claim;
    this.inFlight++;
    try {
      const catchUp = scheduledFor.getTime() < now.getTime() - CATCH_UP_THRESHOLD_MS;
      const runPipeline = this.opts.runPipeline ?? this.defaultRunPipeline();

      let result: BriefingRunResult;
      let guard: ReturnType<typeof setTimeout> | undefined;
      try {
        const guardPromise = new Promise<BriefingRunResult>((resolve) => {
          guard = setTimeout(
            () => resolve({ status: "error", error: `briefing dispatch exceeded guard timeout (${this.opts.guardTimeoutMs}ms)` }),
            this.opts.guardTimeoutMs,
          );
          if (typeof guard === "object" && "unref" in guard) {
            (guard as unknown as { unref: () => void }).unref();
          }
        });
        result = await Promise.race([runPipeline(config, { catchUp }), guardPromise]);
      } catch (err) {
        result = { status: "error", error: err instanceof Error ? err.message : String(err) };
      } finally {
        if (guard) clearTimeout(guard);
      }

      log.info("briefing fire completed", {
        userId: config.userId,
        status: result.status,
        catchUp,
        ...(result.error ? { error: result.error } : {}),
      });

      const outcome = await recordBriefingFireResult(config.userId, result.status, this.opts.now());
      if (outcome?.disabled) {
        log.warn("briefing auto-disabled after consecutive errors", {
          userId: config.userId,
          consecutiveErrors: outcome.consecutiveErrors,
        });
        try {
          const onAutoDisable = this.opts.onAutoDisable ?? this.defaultOnAutoDisable();
          await onAutoDisable(config, outcome.consecutiveErrors);
        } catch (notifyErr) {
          log.warn("auto-disable notification failed", { userId: config.userId, error: String(notifyErr) });
        }
      }
    } finally {
      this.inFlight--;
    }
  }

  private defaultRunPipeline(): NonNullable<BriefingDaemonOptions["runPipeline"]> {
    const runTimeoutMs = this.opts.runTimeoutMs;
    return async (config, opts) => {
      const { runBriefingForUser } = await import("./run");
      return runBriefingForUser(config, opts, { runTimeoutMs });
    };
  }

  private defaultOnAutoDisable(): NonNullable<BriefingDaemonOptions["onAutoDisable"]> {
    return async (config, consecutiveErrors) => {
      const { notifyBriefingAutoDisabled } = await import("./run");
      await notifyBriefingAutoDisabled(config, consecutiveErrors);
    };
  }
}
