import type { AgentRun, AgentEvents } from "../types";
import type { EventBus } from "./events";
import type { Agent } from "@mariozechner/pi-agent-core";
import * as activeRunsDb from "../db/queries/active-runs";
import { logger } from "../logger";

const log = logger.child("executor.watchdog");

// Watchdog thresholds (activity-based heartbeat).
// - WATCHDOG_TICK_MS: how often the watchdog polls activity
// - WATCHDOG_IDLE_MS: if no progress signal for this long (and no pending permission), kill the run
// - HEARTBEAT_REFRESH_MS: how often the watchdog refreshes active_runs.last_heartbeat while alive
const WATCHDOG_TICK_MS = 15_000;
const WATCHDOG_IDLE_MS = 90_000;
const HEARTBEAT_REFRESH_MS = 30_000;

/**
 * Minimal read-only surface the watchdog needs from the executor it serves.
 * Passed by reference — the watchdog never owns the state it reads, only
 * the state it explicitly tracks (heartbeats, activity timestamps, orphan
 * cleanup interval).
 */
export interface WatchdogHost {
  readonly runs: Map<string, AgentRun>;
  readonly controllers: Map<string, AbortController>;
  readonly activeAgents: Map<string, Agent>;
  readonly runConversations: Map<string, string>;
  readonly pendingPermissions: Map<string, { conversationId: string }>;
  readonly bus: EventBus<AgentEvents>;
  readonly persist: boolean;
}

/**
 * Manages all liveness-detection state for {@link AgentExecutor}:
 *   - periodic orphan-run cleanup (enabled only when persist=true)
 *   - per-run activity-based watchdog (heartbeat refresh + idle detection)
 *   - destroy() hook for test teardown / graceful shutdown
 *
 * Owns its own state (heartbeats, lastActivityAt, lastHeartbeatWriteAt,
 * orphanInterval). Reads the executor's state via a {@link WatchdogHost}
 * reference — no state is duplicated.
 */
export class WatchdogManager {
  private heartbeats = new Map<string, ReturnType<typeof setInterval>>();
  // Last time a run emitted a real progress signal (token, tool event, agent event, turn).
  // Used to distinguish "actually working" from "leaked promise".
  private lastActivityAt = new Map<string, number>();
  // Last time we wrote active_runs.last_heartbeat for a run, so we can
  // throttle DB writes to HEARTBEAT_REFRESH_MS while still running the tick at WATCHDOG_TICK_MS.
  private lastHeartbeatWriteAt = new Map<string, number>();
  private orphanInterval: ReturnType<typeof setInterval> | undefined;

  constructor(private host: WatchdogHost) {}

  /**
   * Start the process-wide orphan-cleanup loop. Safe to call only when the
   * host is configured with persist=true; no-op otherwise. Kicks off an
   * immediate cleanup pass, then re-runs every 60s.
   */
  startOrphanCleanup(): void {
    if (!this.host.persist) return;

    // Clean up orphaned runs on startup and periodically.
    // Also cancel any in-memory runs whose DB record was marked interrupted.
    // On fresh startup, ALL "running" DB entries are orphaned — interrupt them immediately
    activeRunsDb.interruptAllRuns().then((count) => {
      if (count > 0) log.info("Interrupted orphaned runs from previous process", { count });
    }).catch((err) => {
      log.error("interruptAllRuns on startup failed", { error: String(err) });
    });

    const cleanupOrphans = async () => {
      const cleaned = await activeRunsDb.cleanupOrphanedRuns(5);
      if (cleaned > 0) {
        log.info("Cleaned up orphaned runs", { count: cleaned });
        // Cancel in-memory controllers for cleaned-up runs
        for (const [runId, ctrl] of this.host.controllers) {
          if (!ctrl.signal.aborted) {
            const convId = this.host.runConversations.get(runId);
            if (convId) {
              const dbRun = await activeRunsDb.getActiveRun(convId);
              if (!dbRun || dbRun.status !== "running") {
                log.info("Aborting orphaned in-memory run", { runId });
                ctrl.abort();
              }
            }
          }
        }
      }
    };
    cleanupOrphans().catch((err) => {
      log.error("Orphan cleanup on startup failed", { error: String(err) });
    });
    this.orphanInterval = setInterval(() => {
      cleanupOrphans().catch((err) => {
        log.error("Periodic orphan cleanup failed", { error: String(err) });
      });
    }, 60_000);
  }

  /** Bump the last-activity timestamp for a run. Called on every real progress signal
   *  (token, tool start/complete/error, agent spawn/complete, turn boundaries). The watchdog
   *  uses this to distinguish "actually working" from "leaked promise that keeps the run alive". */
  bumpActivity(runId: string): void {
    this.lastActivityAt.set(runId, Date.now());
  }

  /** Start the activity-based watchdog for a run. Replaces the old setInterval-based heartbeat.
   *  Ticks every WATCHDOG_TICK_MS. If idle > WATCHDOG_IDLE_MS (with no pending permission),
   *  marks the run interrupted in the DB and emits run:error. Otherwise refreshes
   *  active_runs.last_heartbeat at most once per HEARTBEAT_REFRESH_MS and optionally writes
   *  the latest partial response. */
  startWatchdog(
    runId: string,
    conversationId: string,
    getPartialResponse: () => string,
  ): void {
    if (!this.host.persist) return;
    this.bumpActivity(runId);
    this.lastHeartbeatWriteAt.set(runId, Date.now());
    const tick = async () => {
      const run = this.host.runs.get(runId);
      if (!run || run.status !== "running") return;
      const last = this.lastActivityAt.get(runId) ?? run.startedAt;
      const idleMs = Date.now() - last;
      const hasPendingPermission = [...this.host.pendingPermissions.values()].some(
        (p) => p.conversationId === conversationId,
      );
      if (hasPendingPermission) {
        // Permission gates are legitimate idle — keep the run alive and don't count as stuck.
        this.bumpActivity(runId);
        await activeRunsDb.updateHeartbeat(runId).catch(() => {});
        this.lastHeartbeatWriteAt.set(runId, Date.now());
        return;
      }
      if (idleMs >= WATCHDOG_IDLE_MS) {
        const reason = `Watchdog: no activity for ${Math.round(idleMs / 1000)}s`;
        log.error("Watchdog tripped, interrupting run", { runId, conversationId, idleMs });
        try {
          await activeRunsDb.markInterrupted(runId);
        } catch (err) {
          log.error("Watchdog markInterrupted failed", { error: String(err) });
        }
        run.status = "error";
        run.result = { success: false, output: null, error: reason };
        run.finishedAt = Date.now();
        this.host.bus.emit("run:error", { run, error: reason, conversationId });
        // Abort the in-memory controller so any remaining awaits unblock.
        const controller = this.host.controllers.get(runId);
        if (controller && !controller.signal.aborted) controller.abort();
        this.host.activeAgents.get(runId)?.abort();
        return;
      }
      // Still making progress — refresh heartbeat + partial response at the throttled cadence.
      const lastWrite = this.lastHeartbeatWriteAt.get(runId) ?? 0;
      if (Date.now() - lastWrite >= HEARTBEAT_REFRESH_MS) {
        await activeRunsDb.updateHeartbeat(runId).catch(() => {});
        const partial = getPartialResponse();
        if (partial) {
          await activeRunsDb.updatePartialResponse(runId, partial).catch(() => {});
        }
        this.lastHeartbeatWriteAt.set(runId, Date.now());
      }
    };
    const timer = setInterval(() => {
      tick().catch((err) => log.error("Watchdog tick failed", { runId, error: String(err) }));
    }, WATCHDOG_TICK_MS);
    this.heartbeats.set(runId, timer);
  }

  /**
   * Tear down all per-run watchdog state for a completed/cancelled run.
   * Called from the finally block of the streaming code path.
   */
  clearRun(runId: string): void {
    const hb = this.heartbeats.get(runId);
    if (hb) {
      clearInterval(hb);
      this.heartbeats.delete(runId);
    }
    this.lastActivityAt.delete(runId);
    this.lastHeartbeatWriteAt.delete(runId);
  }

  /**
   * Release process-level resources: orphan-cleanup interval + any
   * straggling per-run watchdog timers. Safe to call multiple times.
   */
  destroy(): void {
    if (this.orphanInterval !== undefined) {
      clearInterval(this.orphanInterval);
      this.orphanInterval = undefined;
    }
    for (const timer of this.heartbeats.values()) {
      clearInterval(timer);
    }
    this.heartbeats.clear();
    this.lastActivityAt.clear();
    this.lastHeartbeatWriteAt.clear();
  }
}
