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
 * Default per-call timeout (ms) used when a tool's manifest doesn't declare
 * `resources.callTimeoutMs` AND the built-in `BuiltinToolDef` doesn't declare
 * `callTimeoutMs`. Pinned to `WATCHDOG_IDLE_MS` on purpose: the moment the
 * tool-in-flight deferral expires, the activity-based idle kill would have
 * fired in the same tick anyway. This makes undeclared built-ins behave
 * **exactly** as pre-Tier-2 — zero new regression surface vs. the prior
 * activity-only watchdog. Slow built-ins (shell builds, LLM-backed
 * summaries) opt into a longer budget by setting `callTimeoutMs` on their
 * `BuiltinToolDef`. See `.planning/watchdog-builtins-hotfix.md`.
 */
export const DEFAULT_BUILTIN_CALL_TIMEOUT_MS = WATCHDOG_IDLE_MS;

/**
 * Per-tool-call snapshot recorded when an extension/builtin tool starts.
 * Carries everything needed to re-emit a `tool:error` event matching the
 * `AgentEvents["tool:error"]` schema in src/types.ts when the watchdog
 * decides to kill the run while this call is in flight.
 */
export interface InflightToolInfo {
  toolName: string;
  conversationId: string;
  extensionId: string;
  cardType?: string;
  cardLayout?: string;
  startedAt: number;
  callTimeoutMs: number;
  /**
   * When `true`, the watchdog defers the idle kill for the duration of
   * this call regardless of `callTimeoutMs` — see
   * `ToolDefinition.requiresUserInput`.
   */
  requiresUserInput?: boolean;
}

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
  // Per-run map of in-flight tool calls, keyed by the pi-agent toolCallId.
  // pi-agent-core emits no events while awaiting a tool result, so without
  // this state the run looks "idle" to the activity tracker and gets killed.
  // While any entry exists for a run AND it's still within its declared
  // callTimeoutMs, the watchdog defers the kill — the same shape as the
  // existing pendingPermissions deferral.
  private inflightTools = new Map<string, Map<string, InflightToolInfo>>();
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

  /**
   * Note that a tool call has started for a run. Held in memory only so the
   * watchdog can (a) defer the idle kill until the manifest-declared
   * `callTimeoutMs` is exceeded and (b) emit a properly-shaped `tool:error`
   * event for any still-pending call when the run does get killed.
   *
   * The caller is responsible for resolving `callTimeoutMs` from the
   * manifest (extensions) or `DEFAULT_BUILTIN_CALL_TIMEOUT_MS` (built-ins).
   */
  noteToolStart(runId: string, toolCallId: string, info: InflightToolInfo): void {
    let runMap = this.inflightTools.get(runId);
    if (!runMap) {
      runMap = new Map();
      this.inflightTools.set(runId, runMap);
    }
    runMap.set(toolCallId, info);
  }

  /** Drop the in-flight entry once the tool's complete/error event arrives.
   *  Safe to call for unknown ids — the caller (subscribe-bridge) doesn't
   *  always know whether a given event corresponds to a tracked tool. */
  noteToolEnd(runId: string, toolCallId: string): void {
    const runMap = this.inflightTools.get(runId);
    if (!runMap) return;
    runMap.delete(toolCallId);
    if (runMap.size === 0) this.inflightTools.delete(runId);
  }

  /**
   * Decide whether the watchdog should defer the idle kill for a run.
   *
   * Two reasons we defer:
   *   1. A permission gate is open — the user just hasn't clicked yet.
   *   2. A tool call is in flight and still within its declared
   *      callTimeoutMs budget — pi-agent-core emits no events while awaiting
   *      tool results, so the activity tracker can't see "still working".
   *
   * Returns a string reason for the log line when deferring, or null when
   * the run should be subjected to the normal idle check.
   */
  private deferralReason(runId: string, conversationId: string, now: number): string | null {
    const hasPendingPermission = [...this.host.pendingPermissions.values()].some(
      (p) => p.conversationId === conversationId,
    );
    if (hasPendingPermission) return "pending permission";
    const runMap = this.inflightTools.get(runId);
    if (runMap && runMap.size > 0) {
      for (const info of runMap.values()) {
        // Human-in-the-loop tools (requiresUserInput) defer indefinitely —
        // the wait is bounded by the user, not by callTimeoutMs.
        if (info.requiresUserInput) {
          return `tool ${info.toolName} awaiting user input`;
        }
        if (now - info.startedAt < info.callTimeoutMs) {
          return `tool ${info.toolName} in flight`;
        }
      }
    }
    return null;
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
      const now = Date.now();
      const last = this.lastActivityAt.get(runId) ?? run.startedAt;
      const idleMs = now - last;
      const deferReason = this.deferralReason(runId, conversationId, now);
      if (deferReason !== null) {
        // Legitimate idle (permission gate or in-flight tool call still
        // within its declared timeout) — keep the run alive and don't count
        // as stuck. We bump the activity timestamp so the moment the
        // deferral lifts (permission resolved or tool returns) the watchdog
        // doesn't immediately trip on the staleness accumulated while
        // waiting.
        log.info("Watchdog deferred", { runId, conversationId, idleMs, reason: deferReason });
        this.bumpActivity(runId);
        await activeRunsDb.updateHeartbeat(runId).catch(() => {});
        this.lastHeartbeatWriteAt.set(runId, now);
        return;
      }
      if (idleMs >= WATCHDOG_IDLE_MS) {
        // Pick the kill reason: a blown tool callTimeoutMs is more
        // informative than the generic idle line. We grab the first
        // expired tool — there's typically only one in flight at a time,
        // and the run-level reason is a single string anyway.
        const runMap = this.inflightTools.get(runId);
        let reason = `Watchdog: no activity for ${Math.round(idleMs / 1000)}s`;
        if (runMap) {
          for (const info of runMap.values()) {
            // Defensive: requiresUserInput tools never produce a
            // callTimeoutMs-based kill reason (the deferral path always
            // wins, but a future deferralReason refactor shouldn't
            // accidentally surface this).
            if (info.requiresUserInput) continue;
            const elapsed = now - info.startedAt;
            if (elapsed >= info.callTimeoutMs) {
              reason = `Tool ${info.toolName} exceeded its ${info.callTimeoutMs}ms call timeout`;
              break;
            }
          }
        }
        log.error("Watchdog tripped, interrupting run", { runId, conversationId, idleMs, reason });
        try {
          await activeRunsDb.markInterrupted(runId);
        } catch (err) {
          log.error("Watchdog markInterrupted failed", { error: String(err) });
        }
        // Emit tool:error for each in-flight tool BEFORE run:error so the
        // chat can render a per-tool failure card instead of the bare
        // "Request was aborted" string the abort path would otherwise
        // produce. Payload shape matches AgentEvents["tool:error"] in
        // src/types.ts exactly.
        if (runMap) {
          for (const [toolCallId, info] of runMap) {
            this.host.bus.emit("tool:error", {
              conversationId: info.conversationId,
              extensionId: info.extensionId,
              toolName: info.toolName,
              error: reason,
              duration: now - info.startedAt,
              invocationId: toolCallId,
              ...(info.cardType ? { cardType: info.cardType } : {}),
              ...(info.cardLayout ? { cardLayout: info.cardLayout } : {}),
            });
          }
        }
        run.status = "error";
        run.result = { success: false, output: null, error: reason };
        run.finishedAt = now;
        this.host.bus.emit("run:error", { run, error: reason, conversationId });
        // Abort the in-memory controller so any remaining awaits unblock.
        const controller = this.host.controllers.get(runId);
        if (controller && !controller.signal.aborted) controller.abort();
        this.host.activeAgents.get(runId)?.abort();
        return;
      }
      // Still making progress — refresh heartbeat + partial response at the throttled cadence.
      const lastWrite = this.lastHeartbeatWriteAt.get(runId) ?? 0;
      if (now - lastWrite >= HEARTBEAT_REFRESH_MS) {
        await activeRunsDb.updateHeartbeat(runId).catch(() => {});
        const partial = getPartialResponse();
        if (partial) {
          await activeRunsDb.updatePartialResponse(runId, partial).catch(() => {});
        }
        this.lastHeartbeatWriteAt.set(runId, now);
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
    this.inflightTools.delete(runId);
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
    this.inflightTools.clear();
  }
}
