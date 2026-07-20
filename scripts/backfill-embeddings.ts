#!/usr/bin/env bun
/**
 * Embedding backfill — manual operator CLI invocation.
 *
 * Phase 68 (Backfill + Operations). One resumable, idempotent script that
 * indexes an existing install's entire eligible chat history by ENQUEUING
 * embed jobs into `message_embed_outbox`; the existing EmbedWorker drains
 * them. This script writes NO embeddings itself (enqueue-only — never imports
 * generateEmbedding / chunkByTokens / EmbedWorker).
 *
 * Modeled on scripts/sweep-perm-expiry.ts: shebang, initDb/getDb, flag parse,
 * JSON summary on stdout, verbose/progress/warn lines on stderr, exit codes.
 *
 * Usage:
 *   bun run scripts/backfill-embeddings.ts                 # enqueue all true gaps
 *   bun run scripts/backfill-embeddings.ts --dry-run       # plan only, write nothing
 *   bun run scripts/backfill-embeddings.ts --status        # print progress JSON, enqueue nothing
 *   bun run scripts/backfill-embeddings.ts --refresh-stale # ALSO re-enqueue stale-model chunks
 *   bun run scripts/backfill-embeddings.ts --project <id>  # narrow to one project
 *   bun run scripts/backfill-embeddings.ts --batch-size 50 --sleep-ms 100
 *
 * Resolution order for batch-size / sleep-ms: flag > env > default
 *   (EZCORP_BACKFILL_BATCH_SIZE / EZCORP_BACKFILL_SLEEP_MS).
 *
 * The script honors the same `DATABASE_URL` / PGlite fallback as the server
 * (src/db/connection.ts), so it operates against whichever DB the server uses.
 *
 * Exit codes:
 *   0 — ran (apply OR dry-run OR status) without per-item errors
 *   1 — at least one per-item enqueue errored
 *   2 — invocation error (unknown flag, bad numeric arg, etc.)
 *
 * Output:
 *   - A single summary JSON doc on stdout.
 *   - Progress / verbose / worker-down warnings as lines on stderr (so stdout
 *     stays parseable as one JSON document — RESEARCH Pitfall 4).
 */

import { sql } from "drizzle-orm";
import { initDb, getDb } from "../src/db/connection";
import {
  enqueueEmbedJobIfAbsent,
  enqueueEmbedJob,
  getEmbedProgress,
  getBackfillBatchSize,
  getBackfillSleepMs,
  type EmbedProgress,
  type DrainDb,
  type EmbedJobTx,
  type EmbedJobInsertTx,
} from "../src/db/queries/message-embed-outbox";
import { EMBEDDING_MODEL_ID } from "../src/memory/embeddings";

/** Lockfile path mirrors embed-worker.ts DEFAULT_LOCKFILE_PATH. */
const EMBED_WORKER_LOCKFILE = ".ezcorp/embed-worker.pid";

export interface ParsedArgs {
  dryRun: boolean;
  verbose: boolean;
  status: boolean;
  refreshStale: boolean;
  projectId: string | null;
  /** Effective page size; undefined means "fall back to env/default". */
  batchSize?: number;
  /** Effective inter-batch pause (ms); undefined means env/default. */
  sleepMs?: number;
}

export interface BackfillOpts {
  dryRun: boolean;
  refreshStale: boolean;
  projectId: string | null;
  batchSize: number;
  sleepMs: number;
  /** Optional progress callback fired once per page (stderr lines, etc.). */
  onProgress?: (p: { enqueued: number; eligible: number; backlog: number }) => void;
}

export interface BackfillResult {
  /** Count of jobs enqueued (or, in dry-run, the count it WOULD enqueue). */
  enqueued: number;
  /** Count of true gaps the SUT scanned/considered. */
  eligibleScanned: number;
}

// The script paces enqueues outside any transaction, so it accepts the
// top-level drizzle/PGlite handle satisfying every structural sub-shape it
// needs (raw execute + the two enqueue insert chains).
type BackfillDb = DrainDb & EmbedJobTx & EmbedJobInsertTx;

/**
 * Parse argv into a {@link ParsedArgs} or an `{error}` sentinel. `--help`/`-h`
 * → `{error:"help"}`; an unknown flag → `{error:"unknown flag: …"}`;
 * `--batch-size`/`--sleep-ms` consume + validate the next token as a positive
 * int (`--sleep-ms` allows 0); `--project` consumes the next token verbatim.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  const out: ParsedArgs = {
    dryRun: false,
    verbose: false,
    status: false,
    refreshStale: false,
    projectId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run" || arg === "-n") out.dryRun = true;
    else if (arg === "--verbose" || arg === "-v") out.verbose = true;
    else if (arg === "--status") out.status = true;
    else if (arg === "--refresh-stale") out.refreshStale = true;
    else if (arg === "--help" || arg === "-h") return { error: "help" };
    else if (arg === "--project") {
      const next = argv[++i];
      if (next === undefined) return { error: "--project requires a project id" };
      out.projectId = next;
    } else if (arg === "--batch-size") {
      const next = argv[++i];
      const n = Math.floor(Number(next));
      if (next === undefined || !Number.isFinite(n) || n <= 0) {
        return { error: `--batch-size requires a positive integer` };
      }
      out.batchSize = n;
    } else if (arg === "--sleep-ms") {
      const next = argv[++i];
      const n = Math.floor(Number(next));
      if (next === undefined || !Number.isFinite(n) || n < 0) {
        return { error: `--sleep-ms requires a non-negative integer` };
      }
      out.sleepMs = n;
    } else return { error: `unknown flag: ${arg}` };
  }
  return out;
}

function printHelp(): void {
  console.log(
    [
      "Usage: bun run scripts/backfill-embeddings.ts [flags]",
      "",
      "Enqueue embed jobs for every eligible message missing an embedding.",
      "Enqueue-only and idempotent: the EmbedWorker drains the queue; re-runs",
      "after a kill add zero duplicates.",
      "",
      "Flags:",
      "  --dry-run, -n        Plan only; report would-enqueue count, write nothing.",
      "  --status             Print the embed-index progress JSON and exit (no enqueue).",
      "  --refresh-stale      ALSO re-enqueue messages whose chunks use an old model.",
      "  --project <id>       Narrow the backfill to a single project.",
      "  --batch-size <n>     Enqueue in pages of n (flag > EZCORP_BACKFILL_BATCH_SIZE > default).",
      "  --sleep-ms <n>       Pause n ms between pages (flag > EZCORP_BACKFILL_SLEEP_MS > default).",
      "  --verbose, -v        Log each enqueued message id as a JSON line on stderr.",
      "  --help, -h           Show this help.",
    ].join("\n"),
  );
}

function rowsOf<T>(res: unknown): T[] {
  return ((res as { rows?: T[] }).rows ?? (res as T[])) as T[];
}

/**
 * Select the gaps-only page after `afterCreatedAt` (keyset by created_at ASC).
 * Mirrors message-search.ts eligibility/test predicates VERBATIM and excludes
 * any message that already has a chunk OR an outbox row.
 */
async function selectGapPage(
  db: BackfillDb,
  projectId: string | null,
  afterCreatedAt: string | null,
  limit: number,
): Promise<Array<{ id: string; conversation_id: string; created_at: string }>> {
  const projectClause = projectId ? sql`AND c.project_id = ${projectId}` : sql``;
  const keysetClause = afterCreatedAt ? sql`AND m.created_at > ${afterCreatedAt}` : sql``;
  const res = await db.execute(sql`
    SELECT m.id, m.conversation_id, m.created_at
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.role IN ('user', 'assistant')
      AND (c.test IS NULL OR c.test = false)
      AND length(trim(m.content)) > 0
      AND NOT EXISTS (SELECT 1 FROM message_chunks mc WHERE mc.message_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM message_embed_outbox o WHERE o.message_id = m.id)
      ${projectClause}
      ${keysetClause}
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT ${limit}
  `);
  return rowsOf<{ id: string; conversation_id: string; created_at: string }>(res);
}

/**
 * Select messages whose existing chunks were embedded with a DIFFERENT model
 * than the current {@link EMBEDDING_MODEL_ID}. These are re-enqueued via the
 * DO-UPDATE {@link enqueueEmbedJob} so the worker deletes stale chunks before
 * re-inserting (RESEARCH Pitfall 5). Still eligibility-gated + project-scoped.
 */
async function selectStaleModelPage(
  db: BackfillDb,
  projectId: string | null,
): Promise<Array<{ id: string; conversation_id: string }>> {
  const projectClause = projectId ? sql`AND c.project_id = ${projectId}` : sql``;
  const res = await db.execute(sql`
    SELECT DISTINCT m.id, m.conversation_id
    FROM message_chunks mc
    JOIN messages m ON m.id = mc.message_id
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.role IN ('user', 'assistant')
      AND (c.test IS NULL OR c.test = false)
      AND length(trim(m.content)) > 0
      AND mc.embedding_model_id != ${EMBEDDING_MODEL_ID}
      ${projectClause}
  `);
  return rowsOf<{ id: string; conversation_id: string }>(res);
}

/**
 * Page the gaps-only select and enqueue each via the DO-NOTHING
 * {@link enqueueEmbedJobIfAbsent}, pausing `sleepMs` between pages. When
 * `refreshStale` is set, ALSO run a stale-model pass via the DO-UPDATE
 * {@link enqueueEmbedJob}. `dryRun` writes nothing but still reports the count
 * it WOULD enqueue.
 */
export async function runBackfill(db: BackfillDb, opts: BackfillOpts): Promise<BackfillResult> {
  const limit = Math.max(1, Math.floor(opts.batchSize));
  let enqueued = 0;
  let eligibleScanned = 0;
  let afterCreatedAt: string | null = null;

  // ── gaps-only pass (OPS-01) ──────────────────────────────────────────────
  for (;;) {
    const page = await selectGapPage(db, opts.projectId, afterCreatedAt, limit);
    if (page.length === 0) break;
    for (const row of page) {
      eligibleScanned++;
      if (!opts.dryRun) {
        await enqueueEmbedJobIfAbsent(db, row.id, row.conversation_id);
      }
      enqueued++;
    }
    afterCreatedAt = page[page.length - 1]!.created_at;
    opts.onProgress?.({ enqueued, eligible: eligibleScanned, backlog: enqueued });
    // If the page was short, we've exhausted the gaps — no need to pause.
    if (page.length < limit) break;
    if (opts.sleepMs > 0) await Bun.sleep(opts.sleepMs);
  }

  // ── stale-model pass (--refresh-stale only) ──────────────────────────────
  if (opts.refreshStale) {
    const stale = await selectStaleModelPage(db, opts.projectId);
    for (const row of stale) {
      eligibleScanned++;
      if (!opts.dryRun) {
        await enqueueEmbedJob(db, row.id, row.conversation_id);
      }
      enqueued++;
    }
    opts.onProgress?.({ enqueued, eligible: eligibleScanned, backlog: enqueued });
  }

  return { enqueued, eligibleScanned };
}

/** Liveness probe — mirrors embed-worker.ts isProcessAlive (L457-466). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "EPERM"; // process exists but owned by another user
  }
}

/**
 * Detect whether the EmbedWorker is DOWN from this separate process's vantage
 * (RESEARCH Pitfall 3): the kill-switch env, or an absent/dead PID lockfile.
 */
export async function isWorkerDown(): Promise<boolean> {
  if (process.env.EZCORP_DISABLE_EMBED_WORKER === "1") return true;
  const file = Bun.file(EMBED_WORKER_LOCKFILE);
  if (!(await file.exists())) return true;
  const pid = parseInt((await file.text()).trim(), 10);
  return !isProcessAlive(pid);
}

export async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    if (parsed.error === "help") {
      printHelp();
      return 0;
    }
    process.stderr.write(`error: ${parsed.error}\n\n`);
    printHelp();
    return 2;
  }

  await initDb();
  const db = getDb() as unknown as BackfillDb;

  // --status: print progress JSON and exit, enqueuing nothing.
  if (parsed.status) {
    const progress: EmbedProgress = await getEmbedProgress(db);
    process.stdout.write(`${JSON.stringify(progress, null, 2)}\n`);
    return 0;
  }

  const batchSize = parsed.batchSize ?? getBackfillBatchSize();
  const sleepMs = parsed.sleepMs ?? getBackfillSleepMs();

  // Worker-down detection — warn LOUDLY then proceed (enqueue is resumable;
  // the queue simply waits for a worker — CONTEXT lock).
  if (await isWorkerDown()) {
    process.stderr.write(
      "WARNING: the EmbedWorker appears to be DOWN (kill-switch set or no live " +
        `lockfile at ${EMBED_WORKER_LOCKFILE}). Jobs will be enqueued but will NOT ` +
        "drain until the worker runs. Start the server / clear EZCORP_DISABLE_EMBED_WORKER " +
        "to process the backlog.\n",
    );
  }

  const errors: string[] = [];
  const onProgress = (p: { enqueued: number; eligible: number; backlog: number }) => {
    process.stderr.write(
      `${JSON.stringify({ progress: true, enqueued: p.enqueued, eligibleScanned: p.eligible })}\n`,
    );
  };

  let result: BackfillResult = { enqueued: 0, eligibleScanned: 0 };
  try {
    result = await runBackfill(db, {
      dryRun: parsed.dryRun,
      refreshStale: parsed.refreshStale,
      projectId: parsed.projectId,
      batchSize,
      sleepMs,
      onProgress,
    });
  } catch (err) {
    errors.push(String((err as Error)?.message ?? err));
  }

  if (parsed.verbose) {
    process.stderr.write(`${JSON.stringify({ done: true, ...result })}\n`);
  }

  // Fetch the final progress snapshot for backlog/coverage in the summary.
  const finalProgress = await getEmbedProgress(db);
  process.stdout.write(
    `${JSON.stringify(
      {
        dryRun: parsed.dryRun,
        enqueued: result.enqueued,
        eligibleScanned: result.eligibleScanned,
        backlog: finalProgress.backlog,
        coverage: finalProgress.coverage,
        errors,
      },
      null,
      2,
    )}\n`,
  );

  return errors.length === 0 ? 0 : 1;
}

// Single-line guard so it is covered on import; the body only runs when the
// script is invoked directly (`bun backfill-embeddings.ts`), never in-process.
if (import.meta.main) process.exit(await main());
