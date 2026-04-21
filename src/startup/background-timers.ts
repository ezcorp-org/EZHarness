import { startDecayTimer } from "../memory/lifecycle";
import { runCompaction } from "../memory/compaction";
import { deleteExpiredSessions } from "../db/queries/sessions";
import { cleanupOldErrors } from "../db/queries/error-logs";
import { getSetting } from "../db/queries/settings";

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
    console.log("[timers] Decay sweep started (1h interval)");
  } catch (e) {
    console.warn("[timers] Failed to start decay timer:", e);
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
        console.error("[timers] Compaction error:", e);
      });
    }, intervalMs);
    console.log(`[timers] Compaction started (${intervalHours}h interval)`);
  } catch (e) {
    console.warn("[timers] Failed to start compaction timer:", e);
  }
}

/** Test-only: reset the singleton flag so tests can re-invoke. */
export function _resetForTests(): void {
  started = false;
}
