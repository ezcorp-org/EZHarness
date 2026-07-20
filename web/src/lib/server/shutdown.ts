/**
 * Graceful shutdown orchestrator.
 *
 * Background: On 2026-05-10, two `docker compose up -d --force-recreate`
 * invocations destroyed user data. The recreate flow sends SIGTERM, waits a
 * default 10s, then SIGKILL. Before this module, the Bun process exited
 * without closing PGlite — leaving `postmaster.pid` in the data dir. The next
 * boot's `openPglite()` aborted on the stale lock, and the catch-all in
 * `src/db/connection.ts:118-128` mis-classified the failure as data
 * corruption and renamed the dir aside.
 *
 * A safety-net cleanup landed in `e304cf8` to clear stale lock files BEFORE
 * `openPglite()` — that handles the SIGKILL/crash case. This module fixes
 * the **graceful** case at the source: on SIGTERM/SIGINT we drain the HTTP
 * server, cancel in-flight SSE clients, stop background daemons, and call
 * `pglite.close()` so no lock is ever written in the first place.
 *
 * Locked invariants:
 *
 *   • **Idempotent.** Repeated signals during a shutdown are no-ops; once
 *     `shutdown()` has started, additional triggers do not re-enter the
 *     teardown list.
 *
 *   • **Reverse boot order.** Teardowns run last-registered-first (LIFO) so
 *     dependencies are stopped before their dependees. `closeDb` MUST be
 *     registered first by `ensureInitialized()` so it runs last.
 *
 *   • **Failures are isolated.** A teardown that throws is logged; the
 *     remaining teardowns still run. Losing user data is worse than losing
 *     a daemon stop.
 *
 *   • **Hard timeout.** If teardown takes longer than `HARD_TIMEOUT_MS`
 *     (25s), the process force-exits with code 1. Docker's
 *     `stop_grace_period: 30s` in `compose.prod.yml` gives us 5s of
 *     headroom — clean exits land within Docker's window every time.
 *
 *   • **No process.exit during in-flight teardown from a re-signal.** The
 *     adapter's own SIGTERM handler may also call `server.stop()`; we
 *     coordinate by listening to `sveltekit:shutdown` (emitted by
 *     `svelte-adapter-bun` before its server.stop) as the canonical hook,
 *     with a direct SIGTERM/SIGINT fallback for non-adapter contexts
 *     (`bun test`, custom server entries).
 *
 * The adapter's entry (`svelte-adapter-bun/dist/files/index.js`):
 *
 *     async function graceful_shutdown(reason) {
 *       console.info("Stopping server...");
 *       process.emit("sveltekit:shutdown", reason);   // ← we hook here
 *       await server.stop(true);
 *       console.info("Stopped server");
 *     }
 *
 * The adapter emits `sveltekit:shutdown` BEFORE awaiting `server.stop` so
 * our hooks can begin teardown concurrently with the connection drain.
 * We `await` everything ourselves before the adapter's `await` resolves,
 * so the process doesn't exit early.
 */

import { logger } from "$server/logger";

const log = logger.child("shutdown");

/** Hard timeout: if shutdown takes more than this, force-exit with code 1.
 *  Stays below Docker's `stop_grace_period: 30s` by 5s of headroom so
 *  clean exits always beat the SIGKILL. */
export const HARD_TIMEOUT_MS = 25_000;

/** How long shutdown waits for in-flight (non-streaming) request handlers to
 *  finish before it starts tearing down the DB/daemons they depend on. Bounded
 *  well under `HARD_TIMEOUT_MS` so a stuck request never blows the whole
 *  budget. */
export const DRAIN_TIMEOUT_MS = 10_000;

// ── In-flight request drain barrier ────────────────────────────────────────
//
// Background: the adapter emits `sveltekit:shutdown` BEFORE awaiting
// `server.stop`, so teardown overlaps the connection drain. Aborting SSE
// streams (below) handles long-lived handlers, but nothing tracked ordinary
// request handlers — so `closeDb()` could run while a POST was still mid
// query-sequence (message finalize, session backfill's non-transactional
// appendEntry loop), 500-ing the client and leaving a partial write.
//
// `hooks.server.ts`'s `handle` brackets each non-streaming request with
// `beginRequest()` / its returned `done()`; `shutdown()` awaits
// `drainInFlightRequests()` before the teardown loop so the DB closes AFTER
// live requests finish (or a bounded timeout elapses).
let inFlightRequests = 0;
const drainWaiters: Array<() => void> = [];

/** Bracket an in-flight request. Call the returned function exactly once when
 *  the handler completes (idempotent — extra calls are ignored). */
export function beginRequest(): () => void {
  inFlightRequests++;
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    inFlightRequests--;
    if (inFlightRequests <= 0) {
      inFlightRequests = 0;
      for (const w of drainWaiters.splice(0)) w();
    }
  };
}

/** Current count of bracketed in-flight requests (for tests/observability). */
export function inFlightRequestCount(): number {
  return inFlightRequests;
}

/** Resolve once every in-flight request has completed, or `timeoutMs` elapses
 *  — whichever comes first. Resolves immediately when nothing is in flight. */
export async function drainInFlightRequests(timeoutMs: number = DRAIN_TIMEOUT_MS): Promise<void> {
  if (inFlightRequests <= 0) return;
  log.info("draining in-flight requests before teardown", { inFlight: inFlightRequests, timeoutMs });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log.warn("in-flight drain timed out — proceeding with teardown", {
        stillInFlight: inFlightRequests,
      });
      resolve();
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    drainWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

interface Teardown {
  name: string;
  fn: () => Promise<void> | void;
}

const teardowns: Teardown[] = [];
let shuttingDown = false;
let installed = false;

/**
 * The AbortSignal exposed to long-lived request handlers (SSE, long-poll)
 * so they can cancel cleanly when shutdown begins. Endpoints subscribe via
 * `getShutdownSignal()` and abort their streams when `aborted` fires.
 */
const shutdownController = new AbortController();
export function getShutdownSignal(): AbortSignal {
  return shutdownController.signal;
}

/** True after `shutdown()` has been triggered. Useful for handlers that want
 *  to refuse new work without waiting for signal propagation. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Register a teardown to run during graceful shutdown. Order is LIFO: the
 * last-registered runs first. Boot code registers in dependency order, so
 * dependees tear down before their dependencies (e.g. dispatchers before
 * the bus before the DB). Re-registration with the same name replaces the
 * earlier entry — boot is idempotent and we don't want double-teardown.
 */
export function registerTeardown(name: string, fn: () => Promise<void> | void): void {
  const idx = teardowns.findIndex((t) => t.name === name);
  if (idx !== -1) teardowns.splice(idx, 1);
  teardowns.push({ name, fn });
}

/**
 * For tests only — clear the teardown list and reset state so a fresh
 * `installShutdownHandlers()` call in a new test can rewire signal
 * listeners. Production callers MUST NOT touch this; teardowns are
 * registered once at boot and only run on signal.
 */
export function __resetForTests(): void {
  teardowns.length = 0;
  shuttingDown = false;
  installed = false;
  inFlightRequests = 0;
  drainWaiters.length = 0;
}

/**
 * Run all registered teardowns under a hard timeout. Exposed so the
 * regression test can drive shutdown without sending real signals.
 *
 * The `reason` is logged to give operators something to grep for in the
 * production journal when chasing "why did this container exit".
 */
export async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) {
    log.info("shutdown already in progress — ignoring re-trigger", { reason });
    return;
  }
  shuttingDown = true;
  log.info("graceful shutdown begin", { reason, teardownCount: teardowns.length });

  // Signal long-lived requests to abort. Doing this BEFORE the per-teardown
  // loop gives streaming endpoints a head start to flush their cleanup
  // (clearInterval on heartbeats, unsub from event bus, close controllers)
  // before we tear down the bus or DB they depend on.
  try {
    shutdownController.abort("server shutting down");
  } catch (err) {
    log.warn("shutdown signal abort failed", { error: String(err) });
  }

  // Hard timeout. Wraps the whole teardown sequence — if any single
  // teardown hangs (e.g. PGlite stuck in a flush), we still beat
  // Docker's SIGKILL. `process.exit(1)` rather than throwing because the
  // adapter's `await server.stop(true)` would otherwise keep us alive.
  const timeout = setTimeout(() => {
    log.error("forced-exit — shutdown teardown exceeded hard timeout", {
      timeoutMs: HARD_TIMEOUT_MS,
      pending: teardowns.length,
    });
    process.exit(1);
  }, HARD_TIMEOUT_MS);
  // Don't let the timeout itself keep the event loop alive once all
  // teardowns finish — without unref(), the process would idle until
  // the timer fires even after everything is closed.
  if (typeof timeout.unref === "function") timeout.unref();

  // Drain in-flight non-streaming request handlers BEFORE any teardown so the
  // DB/daemons they depend on stay up until live requests finish. SSE/long-poll
  // handlers were already told to abort via the shutdown signal above; ordinary
  // handlers get a bounded window here. The hard timeout above still bounds the
  // whole sequence, so a wedged request can never exceed Docker's grace period.
  await drainInFlightRequests(DRAIN_TIMEOUT_MS);

  // Reverse-order: last-registered runs first. ensureInitialized()
  // registers closeDb FIRST so it runs LAST — every dependent (executor,
  // dispatchers, daemons) has already let go of their DB handles by then.
  const ordered = [...teardowns].reverse();
  for (const t of ordered) {
    try {
      const start = Date.now();
      await t.fn();
      log.info("teardown ok", { name: t.name, ms: Date.now() - start });
    } catch (err) {
      // Swallow + log. The whole point of the orchestrator is that one
      // failing teardown does NOT block PGlite close — that's the
      // incident-driver case.
      log.error("teardown failed", { name: t.name, error: String(err) });
    }
  }

  clearTimeout(timeout);
  log.info("graceful shutdown complete", { reason });
}

/**
 * Install SIGTERM/SIGINT listeners and the `sveltekit:shutdown` hook.
 * Idempotent — repeated calls (e.g. dev-mode hot reload) are no-ops.
 *
 * The adapter's own SIGTERM handler emits `sveltekit:shutdown` BEFORE
 * `await server.stop(true)`, so we prefer that as the synchronisation
 * point — drain and teardown overlap. If the adapter isn't present (tests,
 * dev SSR via `vite dev`), we listen to the signals directly.
 */
export function installShutdownHandlers(): void {
  if (installed) return;
  installed = true;

  // Single-shot in-flight promise so multiple signal sources (SIGTERM
  // followed by SIGINT, or sveltekit:shutdown racing with SIGTERM) share
  // one teardown run.
  //
  // When the trigger originates from a real signal (SIGTERM/SIGINT), we
  // call `process.exit(0)` after teardowns complete — otherwise the
  // server may keep running on stray refs (the SSE heartbeat interval
  // re-arms before cancel() fires, an external library holds a timer
  // open). When the trigger is the adapter's `sveltekit:shutdown`
  // event, we DON'T exit ourselves — the adapter is awaiting
  // `server.stop(true)` and will let the process exit naturally; calling
  // process.exit in parallel would race that drain.
  let inFlight: Promise<void> | null = null;
  const trigger = (reason: string, exitOnComplete: boolean): Promise<void> => {
    if (!inFlight) {
      inFlight = shutdown(reason).then(() => {
        if (exitOnComplete) {
          // Use a 0-tick deferral so any post-shutdown microtasks
          // (final flush of stderr, log persistence promise chains)
          // get one tick to settle before the process tears down.
          setTimeout(() => process.exit(0), 0).unref();
        }
      });
    }
    return inFlight;
  };

  // Adapter path. svelte-adapter-bun emits this synchronously inside its
  // own SIGTERM/SIGINT handler. We register `once` because the adapter
  // removes its own listeners after the first signal. `exitOnComplete:
  // false` here — the adapter is awaiting its own `server.stop(true)`
  // and the process exits naturally when both finish.
  process.once("sveltekit:shutdown", (reason: string) => {
    void trigger(`sveltekit:shutdown:${reason ?? "unknown"}`, false);
  });

  // Direct signal path. Runs in `bun test`, in tests that spawn this
  // module as a subprocess, and in any non-adapter entry. Coexists with
  // the adapter's handler — both fire on SIGTERM, and `trigger()`
  // deduplicates so we don't double-tear-down. `exitOnComplete: true`
  // because no other supervisor will exit for us — without it, a child
  // that idles on `await new Promise(() => {})` would never exit even
  // after teardowns finished.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      void trigger(sig, true);
    });
  }
}
