/**
 * EmbedWorker — background outbox drainer for message embeddings.
 *
 * Phase 64 Plan 02 deliverable. Mirrors HostMaintenanceDaemon shape:
 * PID lockfile, kill switch, interval-driven ticks, tick-safety (errors
 * swallowed), idempotent start/stop.
 *
 * Behavioral contracts (ING-01..05):
 *   - ING-01: tickOnce() claims a batch, chunks + embeds each message,
 *     writes message_chunks, marks done — entirely off the SSE path.
 *   - ING-02: when isEmbeddingReady()=false, tickOnce() returns
 *     {claimed:0,...,skipped:batchSize}. Logs ONCE on entering degraded
 *     mode. On first ready tick logs resume + resets pending attempts.
 *   - ING-03: on embed error, markFailed with newAttempts=row.attempts+1.
 *     If exhausted → nextAttemptAfter=null (status='failed'); else →
 *     computeNextAttemptAfter(newAttempts) (status='pending').
 *   - ING-04: start() calls runBacklogRecovery(db) BEFORE arming the
 *     interval. runBacklogRecovery resets all status='in_progress' rows
 *     to 'pending', returns count.
 *   - ING-05: EZCORP_DISABLE_EMBED_WORKER=1 → start() returns false
 *     WITHOUT acquiring the lockfile.
 *
 * Lockfile helpers are inlined (~30 LOC) following the same rationale as
 * host-maintenance-daemon.ts: a tiny scope, and the orchestrator brief
 * ruled out refactoring host-maintenance-daemon for a third daemon.
 * Extract when a fourth daemon appears.
 */

import { eq, sql } from "drizzle-orm";
import { logger } from "../logger";
import { getDb } from "../db/connection";
import {
  claimBatch,
  markDone,
  markFailed,
  resetAttemptsForPending,
  purgeFailedRows,
  type DrainDb,
} from "../db/queries/message-embed-outbox";
import {
  isEmbeddingReady,
  generateEmbedding,
  getTokenizer,
  EMBEDDING_MODEL_ID,
} from "../memory/embeddings";
import { isEmbedEligible, chunkByTokens } from "../memory/message-chunker";
import { messageChunks } from "../db/schema";
import { acquireLockfile, releaseLockfile, isProcessAlive } from "../startup/process-lockfile";

const log = logger.child("embed-worker");

// ── Defaults / env-var contract ──────────────────────────────────────

/** Default tick cadence — 3 seconds for responsive embedding. */
const DEFAULT_POLL_MS = 3_000;
/** Floor on the configured poll interval — 1s minimum. */
const MIN_POLL_MS = 1_000;
/** Default batch size per tick. */
const DEFAULT_BATCH_SIZE = 5;
/** Floor on batch size. */
const MIN_BATCH_SIZE = 1;
/** Default max attempts before marking status='failed'. */
const DEFAULT_MAX_ATTEMPTS = 3;
/** Floor on maxAttempts. */
const MIN_MAX_ATTEMPTS = 1;
/** Default lockfile path. */
const DEFAULT_LOCKFILE_PATH = ".ezcorp/embed-worker.pid";
/**
 * Boot-recovery staleness window. runBacklogRecovery only re-pends in_progress
 * rows whose updated_at is OLDER than this — a genuinely crashed prior worker's
 * jobs. A live sibling instance (multi-host external Postgres) refreshes its
 * claims' updated_at every claim/mark, so its rows stay inside the window and
 * are NOT clobbered. 10 minutes is far longer than any single embed pass.
 */
const DEFAULT_INPROGRESS_STALE_MS = 10 * 60_000;
/**
 * Terminal-failure retention window. Boot purges `status='failed'` rows older
 * than this so the outbox stays bounded on an instance with persistent embed
 * failures (see purgeFailedRows). 7 days keeps a useful forensic tail.
 */
const DEFAULT_FAILED_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * Read `EZCORP_EMBED_POLL_INTERVAL_MS` and return a sane poll interval.
 * Mirrors getSweepIntervalMs from host-maintenance-daemon.ts — same
 * defensive parsing contract. Surfaced for tests via
 * `_embedWorkerInternals` (mirrors the sibling's internals export) rather
 * than a lone module-level `export`, keeping it consistent with its
 * private peers getEmbedBatchSize / getEmbedMaxAttempts.
 */
function getEmbedPollIntervalMs(): number {
  const raw = process.env.EZCORP_EMBED_POLL_INTERVAL_MS;
  if (raw === undefined || raw === "") return DEFAULT_POLL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    log.warn("EZCORP_EMBED_POLL_INTERVAL_MS invalid — using default", {
      raw,
      defaultMs: DEFAULT_POLL_MS,
    });
    return DEFAULT_POLL_MS;
  }
  const intMs = Math.floor(n);
  if (intMs < MIN_POLL_MS) {
    log.warn("EZCORP_EMBED_POLL_INTERVAL_MS below floor — clamped", {
      raw,
      requestedMs: intMs,
      clampedMs: MIN_POLL_MS,
    });
    return MIN_POLL_MS;
  }
  return intMs;
}

function getEmbedBatchSize(): number {
  const raw = process.env.EZCORP_EMBED_BATCH_SIZE;
  if (raw === undefined || raw === "") return DEFAULT_BATCH_SIZE;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BATCH_SIZE;
  return Math.max(MIN_BATCH_SIZE, n);
}

function getEmbedMaxAttempts(): number {
  const raw = process.env.EZCORP_EMBED_MAX_ATTEMPTS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_ATTEMPTS;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_ATTEMPTS;
  return Math.max(MIN_MAX_ATTEMPTS, n);
}

function isDisabledByKillSwitch(): boolean {
  return process.env.EZCORP_DISABLE_EMBED_WORKER === "1";
}

// ── Backoff helper ────────────────────────────────────────────────────

/**
 * Floor on the exponent of the exponential backoff. Without it, an extreme
 * `EZCORP_EMBED_MAX_ATTEMPTS` misconfiguration could drive `attempts` high
 * enough that `5000 * 2^attempts` overflows the JS Date range, making
 * `new Date(...).toISOString()` throw `RangeError('Invalid Date')` inside
 * markFailed — which would escape the per-row catch, abort the rest of the
 * batch, and strand already-claimed rows as `in_progress` until restart.
 * 2^30 * 5s is already ~170 years, well beyond any real retry schedule, so
 * clamping here is purely defensive with no behavioral impact at sane counts.
 */
const MAX_BACKOFF_EXPONENT = 30;

function computeNextAttemptAfter(attempts: number, now: () => number): Date {
  const BASE_DELAY_MS = 5_000;
  const delay = BASE_DELAY_MS * 2 ** Math.min(attempts, MAX_BACKOFF_EXPONENT);
  const jitter = Math.random() * delay * 0.3;
  return new Date(now() + delay + jitter);
}

// ── Exported types ────────────────────────────────────────────────────

/** Outcome of one EmbedWorker tick — exposed for tests. */
export interface EmbedTickOutcome {
  /** Number of outbox rows claimed (transitioned to in_progress). */
  claimed: number;
  /** Number of messages successfully embedded and marked done. */
  embedded: number;
  /** Number of messages that failed this tick (marked failed or pending+backoff). */
  failed: number;
  /** Non-zero when degraded mode gated the entire tick (0 drain occurred). */
  skipped: number;
}

/** Options for EmbedWorker constructor. */
export interface EmbedWorkerOptions {
  /** Poll interval in ms. Default from env or 3000ms. Clamped ≥1000ms. */
  wakeIntervalMs?: number;
  /** Batch size per tick. Default from env or 5. */
  batchSize?: number;
  /** Max embed attempts per message before marking terminal. Default from env or 3. */
  maxAttempts?: number;
  /** Disable the PID lockfile (test-only). */
  skipLockfile?: boolean;
  /** Override the lockfile path for tests. */
  lockfilePath?: string;
  /** Clock injection for tests. Default `() => Date.now()`. */
  now?: () => number;
}

// ── Standalone export: runBacklogRecovery ─────────────────────────────

/**
 * Boot recovery: reset GENUINELY STALE status='in_progress' rows to 'pending'.
 *
 * Called by EmbedWorker.start() BEFORE arming the interval so that rows stuck as
 * in_progress from a CRASHED prior worker become claimable again. Scoped to rows
 * whose `updated_at` is older than `staleBeforeMs` (default 10 min): a LIVE
 * sibling instance sharing DATABASE_URL refreshes its claims' updated_at on
 * every claim/mark, so its in-flight rows stay INSIDE the window and are never
 * clobbered. An unconditional reset would re-pend a live sibling's claims —
 * both instances would then embed the same messages and stomp each other's mark
 * state (a distinct bug from the claimBatch SKIP LOCKED gap).
 *
 * `now` is injectable for tests. Exported standalone so tests can call it
 * without standing up a daemon instance. Returns the number of rows reset.
 */
export async function runBacklogRecovery(
  db: DrainDb,
  staleBeforeMs: number = DEFAULT_INPROGRESS_STALE_MS,
  now: () => number = () => Date.now(),
): Promise<number> {
  const cutoff = new Date(now() - staleBeforeMs).toISOString();
  const result = await db.execute(sql`
    UPDATE message_embed_outbox
    SET status = 'pending', updated_at = NOW()
    WHERE status = 'in_progress' AND updated_at < ${cutoff}
    RETURNING message_id
  `);
  const rows = (result as { rows: { message_id: string }[] }).rows
    ?? (result as { message_id: string }[]);
  const recovered = rows.length;
  if (recovered > 0) {
    log.info("embed-worker: boot recovery — reset stale in-flight jobs", { recovered });
  }
  return recovered;
}

// ── EmbedWorker class ─────────────────────────────────────────────────

export class EmbedWorker {
  private readonly opts: {
    wakeIntervalMs: number;
    batchSize: number;
    maxAttempts: number;
    skipLockfile: boolean;
    lockfilePath: string;
    now: () => number;
  };
  private timer?: ReturnType<typeof setInterval>;
  private lockfileOwned = false;
  private _inDegradedMode = false;
  /**
   * Re-entrancy guard. The interval fires every wakeIntervalMs (3s default),
   * but a single drain pass (Transformers.js CPU embedding of a multi-chunk
   * batch) can exceed that. Without this gate setInterval would launch a
   * second concurrent tickOnce() while the prior one is still pending,
   * spawning overlapping drain loops — violating the "sequential drain loop"
   * contract below and wasting claim/getDb queries. Set on entry, cleared in
   * finally; an overlapping fire early-returns the empty outcome.
   */
  private _ticking = false;

  constructor(options?: EmbedWorkerOptions) {
    const requestedInterval = options?.wakeIntervalMs ?? getEmbedPollIntervalMs();
    this.opts = {
      wakeIntervalMs: Math.max(MIN_POLL_MS, requestedInterval),
      batchSize: Math.max(MIN_BATCH_SIZE, options?.batchSize ?? getEmbedBatchSize()),
      maxAttempts: Math.max(MIN_MAX_ATTEMPTS, options?.maxAttempts ?? getEmbedMaxAttempts()),
      skipLockfile: options?.skipLockfile ?? false,
      lockfilePath: options?.lockfilePath ?? DEFAULT_LOCKFILE_PATH,
      now: options?.now ?? (() => Date.now()),
    };
  }

  /**
   * Start the EmbedWorker daemon.
   *
   * Returns true on successful start, false when refused (kill switch or
   * lockfile sibling). Idempotent — a second call while already-started
   * returns true without rearming.
   *
   * Side-effects (in order):
   *   1. Kill switch check — bail BEFORE touching lockfile if disabled.
   *   2. Acquire PID lockfile.
   *   3. runBacklogRecovery — reset in_progress rows to pending.
   *   4. Arm the interval.
   */
  async start(): Promise<boolean> {
    if (this.timer) return true;

    if (isDisabledByKillSwitch()) {
      log.warn("EmbedWorker disabled by EZCORP_DISABLE_EMBED_WORKER=1");
      return false;
    }

    if (!this.opts.skipLockfile) {
      const acquired = await acquireLockfile(this.opts.lockfilePath);
      if (!acquired) {
        log.warn("EmbedWorker refused to start (sibling alive)", {
          lockfile: this.opts.lockfilePath,
        });
        return false;
      }
      this.lockfileOwned = true;
    }

    // Boot recovery before first tick (ING-04). Stale-scoped so a live sibling's
    // claims survive; uses the worker's injected clock.
    try {
      await runBacklogRecovery(getDb(), DEFAULT_INPROGRESS_STALE_MS, this.opts.now);
    } catch (err) {
      log.warn("embed-worker: boot recovery failed — continuing", {
        error: String((err as Error)?.message ?? err),
      });
    }

    // Retention sweep: bound the outbox by purging terminal failures older than
    // the retention window. Best-effort — a purge hiccup never blocks start.
    try {
      const cutoff = new Date(this.opts.now() - DEFAULT_FAILED_RETENTION_MS);
      const purged = await purgeFailedRows(getDb(), cutoff);
      if (purged > 0) log.info("embed-worker: purged aged terminal failures", { purged });
    } catch (err) {
      log.warn("embed-worker: failed-row retention sweep failed — continuing", {
        error: String((err as Error)?.message ?? err),
      });
    }

    this.timer = setInterval(() => {
      void this.runTickGuarded();
    }, this.opts.wakeIntervalMs);
    if (typeof this.timer === "object" && this.timer !== null && "unref" in this.timer) {
      (this.timer as unknown as { unref: () => void }).unref();
    }
    return true;
  }

  /**
   * Interval body: run one tick, swallowing + logging any rejection.
   * `tickOnce()` has its own try/catch/finally so it never rejects in
   * practice; this outer catch is the defense-in-depth net that keeps the
   * daemon alive if a future change ever lets a tick throw before that guard.
   * Extracted from the `setInterval` callback so the net is directly testable.
   */
  async runTickGuarded(): Promise<void> {
    await this.tickOnce().catch((err: unknown) =>
      log.warn("embed-worker: tick-failed", { error: String(err) }),
    );
  }

  /** Stop the daemon — clears the interval and releases the lockfile. Idempotent. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.lockfileOwned) {
      void releaseLockfile(this.opts.lockfilePath).catch(() => {});
      this.lockfileOwned = false;
    }
  }

  /**
   * Single drain pass. Public for tests — production code should let the
   * interval drive ticks.
   *
   * Tick errors are caught and logged. "Next tick still fires" contract:
   * the setInterval callback also wraps in catch (see start()), but we
   * duplicate the safety net so direct test calls also see quiet failure.
   */
  async tickOnce(): Promise<EmbedTickOutcome> {
    const empty: EmbedTickOutcome = {
      claimed: 0,
      embedded: 0,
      failed: 0,
      skipped: 0,
    };

    // Re-entrancy guard: a prior tick is still draining — skip this fire.
    if (this._ticking) return empty;
    this._ticking = true;

    try {
      const db = getDb();

      // ING-02: Degraded-mode gate
      if (!isEmbeddingReady()) {
        if (!this._inDegradedMode) {
          this._inDegradedMode = true;
          log.warn("embed-worker: embedding not ready — entering degraded mode");
        }
        return { ...empty, skipped: this.opts.batchSize };
      }

      // First ready tick after degraded: log resume + reset pending attempts
      if (this._inDegradedMode) {
        this._inDegradedMode = false;
        log.info("embed-worker: embedding ready — resuming drain, resetting pending attempts");
        await resetAttemptsForPending(db);
      }

      // ING-01: Claim batch
      const rows = await claimBatch(db, this.opts.batchSize);
      if (rows.length === 0) {
        return { ...empty };
      }

      let embedded = 0;
      let failed = 0;

      // Sequential drain loop (Transformers.js singleton — no concurrent embed calls)
      for (const row of rows) {
        try {
          // Fetch message from messages table
          const msgResult = await db.execute(sql`
            SELECT id, role, content FROM messages WHERE id = ${row.messageId}
          `);
          const msgRows = (msgResult as { rows: { id: string; role: string; content: string }[] }).rows
            ?? (msgResult as { id: string; role: string; content: string }[]);
          const msg = msgRows[0];

          // If message not found or not embed-eligible, mark done and skip
          if (!msg || !isEmbedEligible(msg.role, msg.content)) {
            await markDone(db, row.messageId);
            continue;
          }

          // Chunk + embed sequentially
          const tokenizer = await getTokenizer();
          const chunks = chunkByTokens(tokenizer, msg.content);
          const embeddings: number[][] = [];
          for (const chunk of chunks) {
            embeddings.push(await generateEmbedding(chunk));
          }

          // Delete stale chunks before inserting new ones (re-embed on edit)
          await db.delete(messageChunks).where(eq(messageChunks.messageId, row.messageId));

          // Insert new chunk rows
          for (let i = 0; i < chunks.length; i++) {
            await db.insert(messageChunks).values({
              messageId: row.messageId,
              conversationId: row.conversationId,
              content: chunks[i]!,
              chunkIndex: i,
              embedding: embeddings[i]!,
              embeddingModelId: EMBEDDING_MODEL_ID,
            });
          }

          await markDone(db, row.messageId);
          embedded++;
        } catch (rowErr) {
          // ING-03: Record failure with backoff
          const newAttempts = row.attempts + 1;
          const nextAfter =
            newAttempts >= this.opts.maxAttempts
              ? null
              : computeNextAttemptAfter(newAttempts, this.opts.now);
          await markFailed(db, row.messageId, newAttempts, nextAfter);
          failed++;
          log.warn("embed-worker: row embed failed", {
            messageId: row.messageId,
            newAttempts,
            exhausted: newAttempts >= this.opts.maxAttempts,
            error: String((rowErr as Error)?.message ?? rowErr),
          });
        }
      }

      // OPS-03: post-backlog-clear planner maintenance.
      // PGlite has no autovacuum, so after a big backfill drains the planner
      // stats on message_chunks go stale (degrading HNSW/FTS plans). We only
      // reach here when rows.length > 0 (the empty-tick path early-returned at
      // :337 and degraded ticks bailed above), so probe the *remaining*
      // claimable-pending backlog with the SAME predicate claimBatch uses. If
      // this non-empty drain cleared the backlog to zero, run ANALYZE exactly
      // once. The probe re-uses claimBatch's `result.rows ?? result` unwrap
      // idiom; ANALYZE is wrapped in its own try/catch so a stats-refresh
      // failure can never crash a tick or fail the drain (mirrors the
      // tick-level catch discipline below).
      const backlogResult = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM message_embed_outbox
        WHERE status = 'pending'
          AND (next_attempt_after IS NULL OR next_attempt_after <= NOW())
      `);
      const backlogRows = (backlogResult as { rows: { n: number }[] }).rows
        ?? (backlogResult as { n: number }[]);
      const remaining = backlogRows[0]?.n ?? 0;
      if (remaining === 0) {
        try {
          await db.execute(sql`ANALYZE message_chunks`);
        } catch (analyzeErr) {
          log.warn("embed-worker: ANALYZE message_chunks failed — continuing", {
            error: String((analyzeErr as Error)?.message ?? analyzeErr),
          });
        }
      }

      return { claimed: rows.length, embedded, failed, skipped: 0 };
    } catch (err) {
      log.warn("embed-worker: tick crashed — daemon continues", {
        error: String((err as Error)?.message ?? err),
      });
      return empty;
    } finally {
      this._ticking = false;
    }
  }
}

// ── PID lockfile helpers ──────────────────────────────────────────────
//
// Shared, PID-reuse-safe primitive — see src/startup/process-lockfile.ts
// for the boot-token / self-PID reclaim semantics that fix the
// cross-restart self-deadlock.

/**
 * Test-only export: lets tests drive the lockfile primitives, env-var
 * resolution, and backoff math directly without standing up a real daemon
 * — mirrors `_hostMaintenanceDaemonInternals` in host-maintenance-daemon.ts.
 */
export const _embedWorkerInternals = {
  acquireLockfile,
  releaseLockfile,
  isProcessAlive,
  isDisabledByKillSwitch,
  computeNextAttemptAfter,
  getEmbedPollIntervalMs,
  getEmbedBatchSize,
  getEmbedMaxAttempts,
  DEFAULT_POLL_MS,
  MIN_POLL_MS,
  DEFAULT_BATCH_SIZE,
  MIN_BATCH_SIZE,
  DEFAULT_MAX_ATTEMPTS,
  MIN_MAX_ATTEMPTS,
  DEFAULT_LOCKFILE_PATH,
  MAX_BACKOFF_EXPONENT,
  DEFAULT_INPROGRESS_STALE_MS,
  DEFAULT_FAILED_RETENTION_MS,
};
