import { startDecayTimer } from "../memory/lifecycle";
import { runCompaction } from "../memory/compaction";
import { deleteExpiredSessions } from "../db/queries/sessions";
import { cleanupOldErrors } from "../db/queries/error-logs";
import { cleanupOldSdkCapabilityCalls, clampDays } from "../db/queries/sdk-capability-calls";
import { getSetting } from "../db/queries/settings";
import { ScheduleDaemon } from "../extensions/schedule-daemon";
import { HostMaintenanceDaemon } from "../extensions/host-maintenance-daemon";
import { EmbedWorker } from "../extensions/embed-worker";
import { PreviewPortWatcher } from "../runtime/preview/preview-port-watcher";
import { NetnsPortSource } from "../runtime/preview/preview-port-source";
import { decideOnDetection } from "../runtime/preview/preview-consent";
import { logger } from "../logger";

const log = logger.child("startup.timers");

let started = false;
let scheduleDaemon: ScheduleDaemon | undefined;
let permSweepDaemon: HostMaintenanceDaemon | undefined;
let embedWorker: EmbedWorker | undefined;
let previewPortWatcher: PreviewPortWatcher | undefined;

/**
 * Intervals + disposers registered by `startBackgroundTimers()`. Tracked
 * so `stopBackgroundTimers()` (called from the shutdown orchestrator) can
 * cancel every timer before PGlite closes — without this, a `setInterval`
 * firing mid-shutdown would issue a query against a closing PGlite handle
 * and stall the teardown until the hard-timeout watchdog (25s) kicked in.
 *
 * Decay timer goes via `disposers` because `startDecayTimer` returns a
 * cleanup function. Everything else is a raw `Timer` from `setInterval`.
 */
const intervals: Array<ReturnType<typeof setInterval>> = [];
const disposers: Array<() => void> = [];

/** Test-only handle to the daemon singleton — lets tests assert the
 *  daemon was constructed and tear it down between cases. */
export function _getScheduleDaemonForTests(): ScheduleDaemon | undefined {
  return scheduleDaemon;
}

/** Test-only handle to the perm-sweep daemon singleton — lets tests
 *  assert the daemon was constructed and tear it down between cases.
 *  Mirror of `_getScheduleDaemonForTests`. */
export function _getPermSweepDaemonForTests(): HostMaintenanceDaemon | undefined {
  return permSweepDaemon;
}

/** Test-only handle to the embed-worker singleton — mirrors
 *  `_getPermSweepDaemonForTests`. */
export function _getEmbedWorkerForTests(): EmbedWorker | undefined {
  return embedWorker;
}

/** Test-only handle to the preview-port-watcher singleton — mirrors
 *  `_getEmbedWorkerForTests`. Lets the watcher's bootstrap wiring be
 *  asserted (construct + start + handle exposed) and the daemon torn
 *  down between cases. */
export function _getPreviewPortWatcherForTests(): PreviewPortWatcher | undefined {
  return previewPortWatcher;
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
    // startDecayTimer returns a disposer (() => clearInterval). Track it
    // so stopBackgroundTimers() can cancel the recurring sweep — without
    // this, an in-flight decay query would race PGlite close.
    disposers.push(startDecayTimer());
    log.info("Decay sweep started", { intervalHours: 1 });
  } catch (e) {
    log.warn("Failed to start decay timer", { error: String(e) });
  }

  // Session + error-log cleanup (hourly, 30-day retention on errors)
  intervals.push(setInterval(() => {
    deleteExpiredSessions().catch(() => {});
  }, 60 * 60 * 1000));
  intervals.push(setInterval(() => {
    cleanupOldErrors(30).catch(() => {});
  }, 60 * 60 * 1000));

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
  intervals.push(setInterval(() => {
    (async () => {
      const llmDays = clampDays(Number((await getSetting("global:sdkLlmRetentionDays")) ?? 90));
      const memoryDays = clampDays(Number((await getSetting("global:sdkMemoryRetentionDays")) ?? 30));
      const lessonsDays = clampDays(Number((await getSetting("global:sdkLessonsRetentionDays")) ?? 30));
      const scheduleDays = clampDays(Number((await getSetting("global:sdkScheduleRetentionDays")) ?? 90));
      await cleanupOldSdkCapabilityCalls({ llmDays, memoryDays, lessonsDays, scheduleDays });
    })().catch((e: unknown) => {
      log.warn("sdk-capability-calls cleanup failed", { error: String(e) });
    });
  }, 60 * 60 * 1000));

  // Memory compaction (configurable, default 6h).
  //
  // v1.4 — `global:compactionIntervalHours` is deprecated. The
  // bundled `memory-extractor` extension now exposes a per-extension
  // `compactionIntervalHours` setting; the migration at
  // `src/extensions/migrations/memory-extractor-enabled.ts` translates
  // any non-default legacy value into the per-user setting. The
  // legacy host-side timer below (which wraps `runCompaction()`
  // directly) is kept as a backward-compat parallel driver: deleting
  // it now would silently disable compaction on hosts that haven't
  // booted the bundled extension yet. Removable once the bundled
  // extension is the sole compaction driver — track via the
  // `lessons-distiller` Stage 2 deletion pattern.
  try {
    const intervalHours = ((await getSetting("global:compactionIntervalHours")) as number) ?? 6;
    const intervalMs = intervalHours * 60 * 60 * 1000;
    intervals.push(setInterval(() => {
      runCompaction().catch((e: unknown) => {
        log.error("Compaction error", { error: String(e) });
      });
    }, intervalMs));
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

  // Cap-expiry Phase 3: HostMaintenanceDaemon — hourly capability-expiry
  // sweep. Sibling to ScheduleDaemon (host-scoped, not per-extension —
  // see locked design decision § 2.2). Gated by
  // `EZCORP_DISABLE_PERM_SWEEP=1` (strict — only the literal "1") for
  // emergency kill-switch + test environments. Failure-mode contract:
  // if the daemon fails to start (lockfile sibling, or any other
  // exception), log + drop the handle; do NOT block the rest of boot.
  // The per-tick sweep is itself crash-safe (see
  // `host-maintenance-daemon.ts:tickOnce`).
  try {
    permSweepDaemon = new HostMaintenanceDaemon();
    const ok = await permSweepDaemon.start();
    if (ok) {
      log.info("HostMaintenanceDaemon started");
    } else {
      // false-return covers both kill-switch and lockfile refusal;
      // both are already logged inside start() so we don't double-log.
      permSweepDaemon = undefined;
    }
  } catch (e) {
    log.warn("Failed to start HostMaintenanceDaemon", { error: String(e) });
    permSweepDaemon = undefined;
  }

  // Phase 64: EmbedWorker — background outbox drainer for message embeddings.
  // Gated by EZCORP_DISABLE_EMBED_WORKER=1 (handled inside start()). Same
  // fail-safe contract as HostMaintenanceDaemon: if it fails to start, log +
  // drop the handle; do NOT block the rest of boot.
  try {
    embedWorker = new EmbedWorker();
    const ok = await embedWorker.start();
    if (ok) {
      log.info("EmbedWorker started");
    } else {
      embedWorker = undefined;
    }
  } catch (e) {
    log.warn("Failed to start EmbedWorker", { error: String(e) });
    embedWorker = undefined;
  }

  // Phase 2 (Secure Preview): PreviewPortWatcher — auto-detection of dev
  // servers that start LISTENing inside a conversation's netns. Sibling to
  // the daemons above (lockfile, kill switch, interval). The enumeration
  // source is the capability-gated NetnsPortSource: on a host where dynamic
  // previews are fail-closed (D2 — the default posture today) it yields
  // nothing, so the watcher is a logged no-op. `onDetected` routes each
  // requester-scoped detection through decideOnDetection (always-expose
  // pref → auto-expose, else surface a consent card). Same fail-safe
  // contract as HostMaintenanceDaemon/EmbedWorker: log + drop the handle on
  // a failed start; never block boot. Gated by
  // EZCORP_DISABLE_PREVIEW_WATCHER=1 (handled inside start()).
  //
  // NOTE (Phase-3 seam): detection is NOT live yet. No conversation calls
  // `previewPortWatcher.watch(convId, userId)` here, and NetnsPortSource's
  // reader is the phase3StubReader (empty). Per-conversation `watch()`
  // registration (driven by shell-tool use) + live netns `/proc/net/tcp`
  // enumeration land in Phase 3 — until then the watcher polls an empty
  // set and never emits. The wiring below proves the daemon stands up;
  // it does not detect ports on this build.
  try {
    previewPortWatcher = new PreviewPortWatcher({
      source: new NetnsPortSource(),
      onDetected: (event) => {
        // Decision routing is fully testable in preview-consent.test.ts;
        // here we just drive it and swallow failures so a detection can
        // never crash the daemon tick. The live SSE-stream surfacing of
        // the card/URL is the host run-loop's job (Phase 2 frontend).
        void decideOnDetection(event).catch((e: unknown) =>
          log.warn("preview detection routing failed", { error: String(e) }),
        );
      },
    });
    const ok = await previewPortWatcher.start();
    if (ok) {
      log.info("PreviewPortWatcher started");
    } else {
      previewPortWatcher = undefined;
    }
  } catch (e) {
    log.warn("Failed to start PreviewPortWatcher", { error: String(e) });
    previewPortWatcher = undefined;
  }

  // Surface coverage audit (opt-in via global:auditIntervalHours,
  // default 0 = disabled — audits make LLM calls so we don't surprise
  // users with cost. On-demand runs via the surface-audit agent always
  // work regardless of this setting.)
  try {
    const intervalHours = ((await getSetting("global:auditIntervalHours")) as number) ?? 0;
    if (intervalHours > 0) {
      const intervalMs = intervalHours * 60 * 60 * 1000;
      intervals.push(setInterval(() => {
        runScheduledSurfaceAudit().catch((e: unknown) => {
          log.error("Surface audit error", { error: String(e) });
        });
      }, intervalMs));
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

/**
 * Stop every background timer + daemon registered by
 * `startBackgroundTimers()`. Called from the shutdown orchestrator
 * BEFORE PGlite close so no in-flight `setInterval` callback issues a
 * query against a closing DB handle.
 *
 * Order: daemons first (they hold lockfiles + their own intervals),
 * then the raw `setInterval` handles, then the `() => void` disposers
 * (currently only the decay timer's cleanup). Idempotent — repeated
 * calls clear an already-empty list.
 *
 * NB this clears the module-level `started` guard too, which is what
 * the test-only `_resetForTests` already did. Calling both
 * `stopBackgroundTimers()` then `_resetForTests()` is safe.
 */
export async function stopBackgroundTimers(): Promise<void> {
  if (scheduleDaemon) {
    try {
      scheduleDaemon.stop();
    } catch (e) {
      log.warn("ScheduleDaemon.stop() failed", { error: String(e) });
    }
    scheduleDaemon = undefined;
  }
  if (permSweepDaemon) {
    try {
      permSweepDaemon.stop();
    } catch (e) {
      log.warn("HostMaintenanceDaemon.stop() failed", { error: String(e) });
    }
    permSweepDaemon = undefined;
  }
  if (embedWorker) {
    try { embedWorker.stop(); } catch (e) { log.warn("EmbedWorker.stop() failed", { error: String(e) }); }
    embedWorker = undefined;
  }
  if (previewPortWatcher) {
    try { previewPortWatcher.stop(); } catch (e) { log.warn("PreviewPortWatcher.stop() failed", { error: String(e) }); }
    previewPortWatcher = undefined;
  }

  // Clear every recurring timer. clearInterval is idempotent — calling it
  // on a fired/cleared timer is a no-op, so we don't need to guard.
  for (const handle of intervals) clearInterval(handle);
  intervals.length = 0;

  for (const dispose of disposers) {
    try {
      dispose();
    } catch (e) {
      log.warn("Background timer disposer failed", { error: String(e) });
    }
  }
  disposers.length = 0;

  // Release the boot-once guard so a subsequent boot (test re-init, hot
  // restart in dev) can re-arm the timers cleanly. Without resetting,
  // the next `startBackgroundTimers()` would early-return and the host
  // would silently run without decay sweeps, retention cleanup, etc.
  started = false;
}

/** Test-only: reset the singleton flag so tests can re-invoke. */
export function _resetForTests(): void {
  started = false;
  if (scheduleDaemon) {
    scheduleDaemon.stop();
    scheduleDaemon = undefined;
  }
  if (permSweepDaemon) {
    permSweepDaemon.stop();
    permSweepDaemon = undefined;
  }
  if (embedWorker) {
    embedWorker.stop();
    embedWorker = undefined;
  }
  if (previewPortWatcher) {
    previewPortWatcher.stop();
    previewPortWatcher = undefined;
  }
  for (const handle of intervals) clearInterval(handle);
  intervals.length = 0;
  for (const dispose of disposers) {
    try { dispose(); } catch { /* swallow */ }
  }
  disposers.length = 0;
}
