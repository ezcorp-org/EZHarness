import { startDecayTimer } from "../memory/lifecycle";
import { runCompaction } from "../memory/compaction";
import { deleteExpiredSessions } from "../db/queries/sessions";
import { cleanupOldErrors } from "../db/queries/error-logs";
import { getSetting } from "../db/queries/settings";
import { logger } from "../logger";

const log = logger.child("startup.timers");

let started = false;

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
}
