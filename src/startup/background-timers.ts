import { startDecayTimer } from "../memory/lifecycle";
import { runCompaction } from "../memory/compaction";
import { deleteExpiredSessions } from "../db/queries/sessions";
import { cleanupOldErrors } from "../db/queries/error-logs";
import { cleanupOldSdkCapabilityCalls, clampDays } from "../db/queries/sdk-capability-calls";
import { getSetting } from "../db/queries/settings";
import { ScheduleDaemon } from "../extensions/schedule-daemon";
import { BriefingDaemon } from "../runtime/briefing/daemon";
import { HostMaintenanceDaemon } from "../extensions/host-maintenance-daemon";
import { EmbedWorker } from "../extensions/embed-worker";
import { FileOrganizerDaemon, DEFAULT_SETTINGS, mergeFileOrganizerSettings, type FileOrganizerSettings } from "../extensions/file-organizer-daemon";
import { getGithubProjectsDaemon, reconcileOrphanedProposals } from "../integrations/github-projects/daemon";
import type { GithubProjectsDaemon } from "../integrations/github-projects/daemon";
import { PreviewPortWatcher } from "../runtime/preview/preview-port-watcher";
import { NetnsPortSource, ProcPortSource } from "../runtime/preview/preview-port-source";
import { previewCapabilities } from "../runtime/preview/preview-netns";
import { enforceDataDirLockdown } from "../runtime/preview/preview-uid-pool";
import { onPreviewDetected } from "../runtime/preview/preview-detection-bridge";
import { getRegisteredPreviewBus } from "../runtime/preview/preview-bus-registry";
import type { PreviewPortSource } from "../runtime/preview/preview-port-source";
import { logger } from "../logger";

const log = logger.child("startup.timers");

let started = false;
let scheduleDaemon: ScheduleDaemon | undefined;
let briefingDaemon: BriefingDaemon | undefined;
let permSweepDaemon: HostMaintenanceDaemon | undefined;
let embedWorker: EmbedWorker | undefined;
let previewPortWatcher: PreviewPortWatcher | undefined;
let fileOrganizerDaemon: FileOrganizerDaemon | undefined;
let githubProjectsDaemon: GithubProjectsDaemon | undefined;

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

/** Test-only handle to the briefing-daemon singleton — mirrors
 *  `_getScheduleDaemonForTests`. */
export function _getBriefingDaemonForTests(): BriefingDaemon | undefined {
  return briefingDaemon;
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

/** Test-only handle to the file-organizer daemon singleton — mirrors
 *  `_getEmbedWorkerForTests`. */
export function _getFileOrganizerDaemonForTests(): FileOrganizerDaemon | undefined {
  return fileOrganizerDaemon;
}

/** Test-only handle to the github-projects daemon singleton — mirrors
 *  `_getFileOrganizerDaemonForTests`. */
export function _getGithubProjectsDaemonForTests(): GithubProjectsDaemon | undefined {
  return githubProjectsDaemon;
}

/** Test-only handle to the preview-port-watcher singleton — mirrors
 *  `_getEmbedWorkerForTests`. Lets the watcher's bootstrap wiring be
 *  asserted (construct + start + handle exposed) and the daemon torn
 *  down between cases. */
export function _getPreviewPortWatcherForTests(): PreviewPortWatcher | undefined {
  return previewPortWatcher;
}

/**
 * Production accessor for the live PreviewPortWatcher singleton (Phase 3b —
 * the shell-tool spawn trigger needs to register a conversation with the
 * watcher when it launches a dev server under a preview uid). Returns
 * undefined when the watcher didn't start (fail-closed host / kill switch);
 * the launch path then skips watcher registration but still spawns.
 */
export function getPreviewPortWatcher(): PreviewPortWatcher | undefined {
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

  // Embedding model warm-up: the in-process MiniLM embedder takes ~2 min to
  // initialize after a restart, and generateEmbedding() BLOCKS on that load.
  // Kick it at boot (fire-and-forget) so the first composer-suggest /
  // semantic-search request usually finds the model ready instead of ranking
  // lexical-only + degraded (or blocking the whole warm-up window). Lazy
  // import keeps @huggingface/transformers out of the startup static graph
  // (house style); warmupEmbeddings() is itself idempotent + self-catching.
  // Wrapped in the file's never-block-boot contract: a slow/broken model load
  // must never prevent the maintenance timers below from arming.
  try {
    const { warmupEmbeddings } = await import("../memory/embeddings");
    warmupEmbeddings();
    log.info("Embedding warmup kicked");
  } catch (e) {
    log.warn("Failed to kick embedding warmup", { error: String(e) });
  }

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

  // Daily Briefing Phase 1: BriefingDaemon — per-user scheduled briefing
  // driver. Sibling to ScheduleDaemon (claim-before-dispatch against
  // briefing_configs.next_fire_at, fire-once missed-run policy, 3-run
  // host-wide concurrency cap). Gated by EZCORP_DISABLE_BRIEFING_DAEMON=1
  // (strict — only the literal "1"). No PID lockfile: this module's
  // `started` flag is the single-process guard (spec §2). When the web
  // layer hasn't registered the briefing runtime (executor + bus), the
  // daemon's tick is a logged no-op that claims nothing — so wiring it
  // here is safe in every boot order. Same fail-safe contract as the
  // sibling daemons: log + drop the handle on a failed start; never
  // block boot.
  try {
    if (process.env.EZCORP_DISABLE_BRIEFING_DAEMON !== "1") {
      briefingDaemon = new BriefingDaemon();
      const ok = await briefingDaemon.start();
      if (ok) {
        log.info("BriefingDaemon started");
      } else {
        briefingDaemon = undefined;
      }
    } else {
      log.info("BriefingDaemon disabled via EZCORP_DISABLE_BRIEFING_DAEMON");
    }
  } catch (e) {
    log.warn("Failed to start BriefingDaemon", { error: String(e) });
    briefingDaemon = undefined;
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

  // file-organizer: FileOrganizerDaemon — host-side watcher for the
  // bundled file-organizer extension. Sibling to the daemons above
  // (PID-lockfile, kill-switch `EZCORP_DISABLE_FILE_ORGANIZER_DAEMON=1`,
  // interval clamp). Gated on the extension being installed+enabled AND
  // its `daemon_enabled` setting. Same fail-safe contract: log + drop the
  // handle on a failed start; never block boot. When the extension isn't
  // installed (or the DB layer isn't ready), construction is skipped and
  // this is a logged no-op.
  try {
    const { getExtensionByName } = await import("../db/queries/extensions");
    const ext = await getExtensionByName("file-organizer");
    if (ext?.enabled) {
      const settings = await resolveFileOrganizerSettings(ext.id);
      if (settings.daemonEnabled) {
        const { getProjectRoot } = await import("../extensions/bundled");
        const { join } = await import("node:path");
        const { getPermissionEngine } = await import("../extensions/permission-engine");
        const { getPageCache } = await import("../extensions/page-cache");
        const dataDir = join(
          getProjectRoot(),
          ".ezcorp",
          "extension-data",
          "file-organizer",
        );
        const pageCache = getPageCache();
        fileOrganizerDaemon = new FileOrganizerDaemon({
          dataDir,
          engine: getPermissionEngine(),
          extensionId: ext.id,
          getSettings: () => resolveFileOrganizerSettings(ext.id),
          invalidatePage: (pageId) => pageCache.invalidate(ext.id, pageId),
        });
        const ok = await fileOrganizerDaemon.start(settings);
        if (ok) {
          log.info("FileOrganizerDaemon started");
        } else {
          fileOrganizerDaemon = undefined;
        }
      } else {
        log.info("FileOrganizerDaemon disabled via daemon_enabled setting");
      }
    }
  } catch (e) {
    log.warn("Failed to start FileOrganizerDaemon", { error: String(e) });
    fileOrganizerDaemon = undefined;
  }

  // github-projects: GithubProjectsDaemon — host-side poller that turns
  // GitHub Projects board moves into proposals (+ optional auto-spawn). Sibling
  // to the daemons above (kill-switch EZCORP_DISABLE_GITHUB_PROJECTS_DAEMON=1,
  // handled inside start(); its own wake interval). `start()` is synchronous and
  // returns false when the kill-switch is set. Same fail-safe contract: log +
  // drop the handle on a false-return / throw; never block boot. The daemon's
  // tick is itself crash-safe — it polls only enabled links and degrades a
  // failing link instead of throwing out of the sweep, so wiring it here is safe
  // in every boot order (no links → empty sweep).
  try {
    // Use the MODULE SINGLETON (getGithubProjectsDaemon), not a private `new`:
    // the reverse-RPC poll-now path drives the same accessor, and the daemon's
    // non-reentrancy guard + per-link rate-limit back-off only work when both
    // paths share one instance. The singleton carries no `emit` — it falls back
    // to the registered bus emitter (getGithubProjectsEmit) at emit time, so
    // the Hub still live-refreshes once the web layer registers the bus.
    githubProjectsDaemon = getGithubProjectsDaemon();
    // Boot reconciliation BEFORE the poll loop arms: run-lifecycle
    // subscriptions are in-memory, so every proposal a previous process left
    // `spawned`/`running` is orphaned (the executor-watchdog interruptAllRuns
    // doctrine). The sweep flips them to `failed` and posts best-effort
    // ticket comments. reconcileOrphanedProposals never throws by contract;
    // the inline .catch is belt-and-braces so even a pathological rejection
    // cannot skip the daemon start below (the outer catch would otherwise
    // drop the handle and leave boards unpolled).
    await reconcileOrphanedProposals().catch((e: unknown) => {
      log.warn("github-projects boot reconciliation failed", { error: String(e) });
    });
    const ok = githubProjectsDaemon.start();
    if (ok) {
      log.info("GithubProjectsDaemon started");
    } else {
      githubProjectsDaemon = undefined;
    }
  } catch (e) {
    log.warn("Failed to start GithubProjectsDaemon", { error: String(e) });
    githubProjectsDaemon = undefined;
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
  // Phase 3a — make dynamic previews RUN. Two boot steps:
  //   1. KEYSTONE: chmod .ezcorp/data to 0700 so a preview uid (a distinct
  //      uid with no supplementary groups) can never read the PGlite DB /
  //      encrypted JWT secret. If this fails we still start the watcher but
  //      the uid-mode source will be fail-closed by capability detection.
  //   2. Pick the enumeration SOURCE by capability mode:
  //        - mode 'uid'   → ProcPortSource (reads /proc/net/tcp{,6}, maps
  //                         the uid column → conversation via the uid pool),
  //        - mode 'netns' → NetnsPortSource (hardened; unavailable here),
  //        - mode 'static'→ NetnsPortSource (yields nothing — logged no-op).
  //
  // onDetected routes each requester-scoped detection through
  // onPreviewDetected, which runs the consent decision (always-expose →
  // auto-expose, else a consent card) and PUSHES it onto the LIVE
  // conversation SSE stream via the registered bus (preview-bus-registry —
  // the web layer registers getBus() at init). Until a bus is registered it
  // is a logged no-op (fail-safe).
  //
  // SEAM (reported): no conversation calls `previewPortWatcher.watch(conv,
  // user)` from here — that registration is driven by shell/dev-server tool
  // use in the run loop, plus the spawn-as-preview-uid hook. Those are the
  // remaining integration points (see preview-spawn-orchestration.ts + the
  // SUMMARY). The watcher + source + bridge are fully wired and tested; the
  // per-conversation watch()/spawn trigger is the marked seam.
  try {
    const caps = previewCapabilities();
    const lockdown = enforceDataDirLockdown();
    if (!lockdown.ok) {
      log.warn("preview .ezcorp/data lockdown not enforced at boot", {
        path: lockdown.path,
        reason: lockdown.reason,
      });
    }
    const source: PreviewPortSource =
      caps.mode === "uid" ? new ProcPortSource() : new NetnsPortSource();
    log.info("PreviewPortWatcher source selected by capability mode", {
      mode: caps.mode,
      source: caps.mode === "uid" ? "ProcPortSource" : "NetnsPortSource",
      dataDirLocked: lockdown.ok,
    });
    // Idle reaping (Phase 3b): a conversation whose dev server has gone quiet
    // for IDLE_REAP_TICKS consecutive ticks is reaped (proc killed + preview
    // revoked + watch dropped). Default ~30 ticks ≈ 60s at the 2s cadence;
    // overridable via EZCORP_PREVIEW_IDLE_REAP_TICKS. 0 disables idle reaping.
    const idleReapTicks = (() => {
      const raw = process.env.EZCORP_PREVIEW_IDLE_REAP_TICKS;
      if (raw === undefined || raw === "") return 30;
      const n = Math.floor(Number(raw));
      return Number.isFinite(n) && n >= 0 ? n : 30;
    })();
    previewPortWatcher = new PreviewPortWatcher({
      source,
      onDetected: (event) => {
        // Route detection → consent decision → live SSE push. Failures are
        // swallowed inside onPreviewDetected so a detection can never crash
        // the daemon tick.
        void onPreviewDetected(event, {
          getBus: getRegisteredPreviewBus,
          appHost: () => process.env.EZCORP_PREVIEW_APP_HOST ?? null,
          secure: () => process.env.FORCE_SECURE_COOKIES === "true",
        });
      },
      idleReapTicks,
      onIdleReap: (conversationId) => {
        // Lazy-import the reaper so the watcher module stays free of the DB +
        // process-registry graph at construction time.
        void (async () => {
          const { reapPreviewConversation } = await import("../runtime/preview/preview-reaper");
          await reapPreviewConversation(conversationId);
        })().catch((e: unknown) => {
          log.warn("preview idle reap failed", { conversationId, error: String(e) });
        });
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
 * Resolve the file-organizer daemon's effective settings (single-operator
 * workspace model). Reads the manifest declared defaults, overlaid with
 * the first stored per-user settings row (the operator). Falls back to
 * the hardcoded DEFAULT_SETTINGS on any failure so the daemon's tick can
 * never crash on a settings read.
 */
async function resolveFileOrganizerSettings(extensionId: string): Promise<FileOrganizerSettings> {
  try {
    const [{ getDb }, { extensionSettingsUser, extensions }, { eq }] = await Promise.all([
      import("../db/connection"),
      import("../db/schema"),
      import("drizzle-orm"),
    ]);
    const db = getDb();
    const manifestRows = await db
      .select({ manifest: extensions.manifest })
      .from(extensions)
      .where(eq(extensions.id, extensionId));
    const schema = (manifestRows[0]?.manifest as { settings?: Record<string, { default?: unknown }> } | undefined)?.settings ?? {};
    const declared: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(schema)) if (f.default !== undefined) declared[k] = f.default;

    const userRows = await db
      .select({ values: extensionSettingsUser.values })
      .from(extensionSettingsUser)
      .where(eq(extensionSettingsUser.extensionId, extensionId))
      .limit(1);
    const stored = (userRows[0]?.values as Record<string, unknown> | undefined) ?? {};
    return mergeFileOrganizerSettings(declared, stored);
  } catch (e) {
    log.warn("resolveFileOrganizerSettings failed — using defaults", { error: String(e) });
    return DEFAULT_SETTINGS;
  }
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
  if (briefingDaemon) {
    try {
      briefingDaemon.stop();
    } catch (e) {
      log.warn("BriefingDaemon.stop() failed", { error: String(e) });
    }
    briefingDaemon = undefined;
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
  if (fileOrganizerDaemon) {
    try { fileOrganizerDaemon.stop(); } catch (e) { log.warn("FileOrganizerDaemon.stop() failed", { error: String(e) }); }
    fileOrganizerDaemon = undefined;
  }
  if (githubProjectsDaemon) {
    try { githubProjectsDaemon.stop(); } catch (e) { log.warn("GithubProjectsDaemon.stop() failed", { error: String(e) }); }
    githubProjectsDaemon = undefined;
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
  if (briefingDaemon) {
    briefingDaemon.stop();
    briefingDaemon = undefined;
  }
  if (permSweepDaemon) {
    permSweepDaemon.stop();
    permSweepDaemon = undefined;
  }
  if (embedWorker) {
    embedWorker.stop();
    embedWorker = undefined;
  }
  if (fileOrganizerDaemon) {
    fileOrganizerDaemon.stop();
    fileOrganizerDaemon = undefined;
  }
  if (githubProjectsDaemon) {
    githubProjectsDaemon.stop();
    githubProjectsDaemon = undefined;
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
