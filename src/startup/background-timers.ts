import { startDecayTimer } from "../memory/lifecycle";
import { runCompaction } from "../memory/compaction";
import { deleteExpiredSessions } from "../db/queries/sessions";
import { cleanupOldErrors } from "../db/queries/error-logs";
import { cleanupOldSdkCapabilityCalls, clampDays } from "../db/queries/sdk-capability-calls";
import { getSetting } from "../db/queries/settings";
import { ScheduleDaemon } from "../extensions/schedule-daemon";
import { logger } from "../logger";

const log = logger.child("startup.timers");

let started = false;
let scheduleDaemon: ScheduleDaemon | undefined;

/** Test-only handle to the daemon singleton — lets tests assert the
 *  daemon was constructed and tear it down between cases. */
export function _getScheduleDaemonForTests(): ScheduleDaemon | undefined {
  return scheduleDaemon;
}

/**
 * Start all background maintenance timers: memory decay sweep, memory
 * compaction, expired-session cleanup, error-log retention.
 *
 * Idempotent — safe to call multiple times; only the first call schedules
 * work. This file lives under `src/` (outside vite's SSR root) so its
 * module-level `started` flag is a true process-wide singleton. The
 * SvelteKit hook that invokes this re-evaluates twice in dev, which would
 * otherwise register every interval twice.
 */
export async function startBackgroundTimers(): Promise<void> {
  if (started) return;
  started = true;

  // Memory decay (1h)
  try {
    startDecayTimer();
    log.info("Decay sweep started", { intervalHours: 1 });
  } catch (e) {
    log.warn("Failed to start decay timer", { error: String(e) });
  }

  // Session + error-log cleanup (hourly, 30-day retention on errors)
  setInterval(() => {
    deleteExpiredSessions().catch(() => {});
  }, 60 * 60 * 1000);
  setInterval(() => {
    cleanupOldErrors(30).catch(() => {});
  }, 60 * 60 * 1000);

  // Phase 50: SDK capability-call retention sweep (hourly).
  // Per-capability retention thresholds are read on every tick so
  // admin changes to `global:sdk{Llm,Memory,Lessons,Schedule}RetentionDays`
  // apply without restart. Defaults: 90/30/30/90 days.
  //
  // CR-3: clamp every setting value to [1, 3650] BEFORE handing to
  // `cleanupOldSdkCapabilityCalls`. The query module also clamps, but
  // the `force: true` escape hatch there is reachable when the caller
  // passes 0; clamping at the read layer means production paths can
  // NEVER pass 0, regardless of what's in the settings table. The
  // explicit `force` flag is intentionally NOT set — production must
  // not opt into the implicit-purge branch.
  //
  // Style mirrors `cleanupOldErrors` above. Failures swallowed —
  // retention is an opportunistic background sweep; an audit row that
  // outlives its window for one tick isn't a correctness problem.
  setInterval(() => {
    (async () => {
      const llmDays = clampDays(Number((await getSetting("global:sdkLlmRetentionDays")) ?? 90));
      const memoryDays = clampDays(Number((await getSetting("global:sdkMemoryRetentionDays")) ?? 30));
      const lessonsDays = clampDays(Number((await getSetting("global:sdkLessonsRetentionDays")) ?? 30));
      const scheduleDays = clampDays(Number((await getSetting("global:sdkScheduleRetentionDays")) ?? 90));
      await cleanupOldSdkCapabilityCalls({ llmDays, memoryDays, lessonsDays, scheduleDays });
    })().catch((e: unknown) => {
      log.warn("sdk-capability-calls cleanup failed", { error: String(e) });
    });
  }, 60 * 60 * 1000);

  // Memory compaction (configurable, default 6h)
  try {
    const intervalHours = ((await getSetting("global:compactionIntervalHours")) as number) ?? 6;
    const intervalMs = intervalHours * 60 * 60 * 1000;
    setInterval(() => {
      runCompaction().catch((e: unknown) => {
        log.error("Compaction error", { error: String(e) });
      });
    }, intervalMs);
    log.info("Compaction started", { intervalHours });
  } catch (e) {
    log.warn("Failed to start compaction timer", { error: String(e) });
  }

  // Phase 51.5: ScheduleDaemon — persistent cron driver for `ctx.schedule`.
  // Singleton owned by background-timers; gated by `EZCORP_DISABLE_SCHEDULE_DAEMON=1`
  // for ops who want to fence off cron-driven extensions in a given env.
  // The daemon's PID lockfile is the cross-process sibling-prevention
  // mechanism — see schedule-daemon.ts.
  try {
    if (process.env.EZCORP_DISABLE_SCHEDULE_DAEMON !== "1") {
      scheduleDaemon = new ScheduleDaemon();
      const ok = await scheduleDaemon.start();
      if (ok) {
        log.info("ScheduleDaemon started");
      } else {
        log.warn("ScheduleDaemon refused to start (sibling daemon detected via lockfile)");
        scheduleDaemon = undefined;
      }
    } else {
      log.info("ScheduleDaemon disabled via EZCORP_DISABLE_SCHEDULE_DAEMON");
    }
  } catch (e) {
    log.warn("Failed to start ScheduleDaemon", { error: String(e) });
  }

  // Surface coverage audit (opt-in via global:auditIntervalHours,
  // default 0 = disabled — audits make LLM calls so we don't surprise
  // users with cost. On-demand runs via the surface-audit agent always
  // work regardless of this setting.)
  try {
    const intervalHours = ((await getSetting("global:auditIntervalHours")) as number) ?? 0;
    if (intervalHours > 0) {
      const intervalMs = intervalHours * 60 * 60 * 1000;
      setInterval(() => {
        runScheduledSurfaceAudit().catch((e: unknown) => {
          log.error("Surface audit error", { error: String(e) });
        });
      }, intervalMs);
      log.info("Surface audit started", { intervalHours });
    }
  } catch (e) {
    log.warn("Failed to start surface audit timer", { error: String(e) });
  }
}

/**
 * Build a minimal AgentContext for scheduled audits and run them
 * across every project. Lazy-imported to avoid pulling the audit
 * runtime into the startup bundle when the timer is disabled.
 */
async function runScheduledSurfaceAudit(): Promise<void> {
  const [{ runScheduledAudit }, { createPiLlmAdapter }] = await Promise.all([
    import("../runtime/audit/run"),
    import("../runtime/executor-helpers"),
  ]);
  const llm = createPiLlmAdapter();
  const ctx = {
    input: {},
    llm,
    shell: { async run() { return { stdout: "", stderr: "", exitCode: 0 }; } },
    file: {
      async read(path: string) { return await Bun.file(path).text(); },
      async write(path: string, content: string) { await Bun.write(path, content); },
      async exists(path: string) { return await Bun.file(path).exists(); },
    },
    log(message: string) { log.info(message); },
    signal: new AbortController().signal,
    async run() { return { success: true, output: null }; },
  };
  await runScheduledAudit(ctx as never);
}

/** Test-only: reset the singleton flag so tests can re-invoke. */
export function _resetForTests(): void {
  started = false;
  if (scheduleDaemon) {
    scheduleDaemon.stop();
    scheduleDaemon = undefined;
  }
}
