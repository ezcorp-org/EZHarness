import { eq, desc, and, isNull, sql, inArray } from "drizzle-orm";
import { getDb } from "../connection";
import { runs, runLogs } from "../schema";
import type { AgentRun, AgentLog, AgentResult } from "../../types";

/**
 * Resolve the ROOT conversation owner for a chat run.
 *
 * Chat sub-conversations carry `userId = null`; the real owner lives on the
 * top of the `parent_conversation_id` chain. A recursive CTE walks to the
 * root (depth-capped at 16 to defuse a corrupt cycle) and returns the root's
 * `user_id`. Returns undefined when the conversation is missing, the root is
 * ownerless, or the walk can't terminate — the caller then inserts a NULL
 * `user_id`, which the ownership check treats as admin-only (fail closed).
 *
 * This is the live-insert twin of the migration backfill: both attribute a
 * chat run to the same root owner, so a run inserted now and a run backfilled
 * later resolve identically.
 */
export async function resolveRootConversationOwner(
  conversationId: string,
): Promise<string | undefined> {
  const rows = (await getDb().execute(sql`
    WITH RECURSIVE chain AS (
      SELECT id AS conv_id, parent_conversation_id, user_id, 0 AS depth
        FROM conversations WHERE id = ${conversationId}
      UNION ALL
      SELECT p.id, p.parent_conversation_id, p.user_id, c.depth + 1
        FROM chain c
        JOIN conversations p ON p.id = c.parent_conversation_id
       WHERE c.depth < 16
    )
    SELECT user_id FROM chain
     WHERE parent_conversation_id IS NULL
     ORDER BY depth DESC
     LIMIT 1
  `)) as unknown as { rows?: Array<{ user_id: string | null }> } | Array<{ user_id: string | null }>;
  // getDb().execute returns a driver-shaped result; PGlite/Bun both expose
  // the row array either directly or under `.rows`.
  const arr = Array.isArray(rows) ? rows : rows.rows ?? [];
  return arr[0]?.user_id ?? undefined;
}

/**
 * Terminal `runs.status` values. Mirrors the abnormal subset of
 * {@link AgentStatus} (`error` | `cancelled`) — the `runs` row carries the
 * same discriminator the executor already sets in-memory on `run.status`,
 * so no new enum value is introduced (the column is free-text `text` and
 * `AgentStatus` is `running|success|error|cancelled`). Used by the shared
 * abnormal-termination finalize path so every kill route (watchdog,
 * cancel, setup error, host crash) writes a consistent terminal state.
 */
export type TerminalRunStatus = "error" | "cancelled";

export interface DbRun {
  id: string;
  agentName: string;
  projectId: string | null;
  status: string;
  input: Record<string, unknown> | null;
  startedAt: Date;
  finishedAt: Date | null;
  result: { success: boolean; output: unknown; error?: string | { code: string; message: string } } | null;
  createdAt: Date;
}

type DbRunLog = typeof runLogs.$inferSelect;

export async function insertRun(
  run: AgentRun,
  projectId?: string,
  input?: Record<string, unknown>,
  conversationId?: string,
  userId?: string,
): Promise<void> {
  // Attribute the run to the initiating user. For chat runs the caller may
  // not know the owner (sub-conversations are userId=null), so when a
  // conversationId is given without an explicit userId we resolve the ROOT
  // conversation owner here — keeping live inserts byte-identical to the
  // migration backfill. NULL means unattributable ⇒ admin-only downstream.
  const resolvedUserId =
    userId ?? (conversationId ? await resolveRootConversationOwner(conversationId) : undefined);
  await getDb().insert(runs).values({
    id: run.id,
    agentName: run.agentName,
    projectId: projectId ?? null,
    conversationId: conversationId ?? null,
    userId: resolvedUserId ?? null,
    status: run.status,
    input: input ?? null,
    startedAt: new Date(run.startedAt),
    createdAt: new Date(),
  });
}

/** Run-ownership attributes: the owning conversation id (null for agent/CLI
 *  runs) and the initiating user id (null when unattributable). Both feed the
 *  per-user ownership check on /api/runs/[id]. Returns undefined when the run
 *  row does not exist. */
export async function getRunOwnership(
  id: string,
): Promise<{ conversationId: string | null; userId: string | null } | undefined> {
  const rows = await getDb()
    .select({ conversationId: runs.conversationId, userId: runs.userId })
    .from(runs)
    .where(eq(runs.id, id));
  const row = rows[0];
  if (!row) return undefined;
  return { conversationId: row.conversationId ?? null, userId: row.userId ?? null };
}

/** Owning conversation id for a run (null for agent/CLI runs). Used to
 *  enforce per-user ownership on /api/runs/[id]. */
export async function getRunConversationId(id: string): Promise<string | undefined> {
  const rows = await getDb().select({ conversationId: runs.conversationId }).from(runs).where(eq(runs.id, id));
  return rows[0]?.conversationId ?? undefined;
}

export async function updateRun(run: AgentRun): Promise<void> {
  await getDb().update(runs).set({
    status: run.status,
    finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
    result: run.result ?? null,
  }).where(eq(runs.id, run.id));
}

/**
 * Atomically terminalize the `runs` mirror for an abnormal termination.
 *
 * Why this exists: the `runs` table and the `active_runs` table are two
 * representations of run state. The watchdog/cancel/setup-error paths
 * write `active_runs` directly (markInterrupted) but historically left
 * the `runs` row at `status='running', finished_at=NULL` whenever the
 * normal `streamChat` `finally → finalizeCleanup` path (the only caller
 * of `updateRun`) could not run — i.e. the textbook hung/leaked-promise
 * run the watchdog exists to kill. The two representations then diverge
 * permanently. This is the single shared "finalize the runs row" helper
 * every abnormal-termination path funnels through, alongside its
 * existing `active_runs` write.
 *
 * Idempotent + race-safe: the WHERE clause only matches a row that is
 * still non-terminal (`status='running'`). If `finalizeCleanup` already
 * persisted a terminal state for this run (the common, healthy path),
 * this is a zero-row no-op — it never clobbers a richer terminal result
 * (success/cancelled) the normal path may have recorded.
 *
 * Returns the number of rows transitioned (0 or 1).
 */
export async function finalizeRunRow(
  runId: string,
  status: TerminalRunStatus,
  error?: string,
): Promise<number> {
  const rows = await getDb()
    .update(runs)
    .set({
      status,
      finishedAt: sql`NOW()`,
      ...(error !== undefined
        ? { result: { success: false, output: null, error } }
        : {}),
    })
    .where(and(eq(runs.id, runId), eq(runs.status, "running")))
    .returning({ id: runs.id });
  return rows.length;
}

/**
 * Boot-time reconciliation: terminalize every `runs` row still stuck at
 * `status='running'` with `finished_at IS NULL`.
 *
 * A freshly-started process owns zero in-memory runs, so by definition
 * ANY `runs` row still marked `running` is orphaned — exactly the same
 * invariant `active-runs.ts:interruptAllRuns()` relies on for the
 * `active_runs` table. This is the `runs`-table counterpart: it both
 * (a) prevents orphan accumulation recurring after a crash/OOM kill that
 * skipped `finalizeCleanup`, and (b) drains the pre-existing backlog of
 * stale `running` rows on the next legitimate restart WITHOUT any manual
 * DB surgery.
 *
 * Marked `error` to match the discriminator the watchdog already sets
 * in-memory for a killed run (no new status value introduced).
 *
 * Returns the number of rows drained.
 */
export async function terminalizeOrphanedRuns(): Promise<number> {
  const rows = await getDb()
    .update(runs)
    .set({
      status: "error",
      finishedAt: sql`NOW()`,
      result: {
        success: false,
        output: null,
        error: "Run orphaned: process restarted while run was active",
      },
    })
    .where(and(eq(runs.status, "running"), isNull(runs.finishedAt)))
    .returning({ id: runs.id });
  return rows.length;
}

/**
 * Batch-resolve the persisted `status` of many runs by id in one query.
 * Returns a Map keyed by run id; an id with no `runs` row is simply absent
 * from the map (the caller decides how to treat a missing run).
 *
 * Used by the boot reconciliation of interrupted sub-agent assignments
 * (`src/runtime/boot-reconcile-assignments.ts`): after boot terminalization,
 * an assignment whose `agentRunId` maps to a run that is no longer `running`
 * (or is absent entirely) is dangling and gets failed.
 */
export async function getRunStatusesByIds(
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb()
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(inArray(runs.id, ids as string[]));
  return new Map(rows.map((r: { id: string; status: string }) => [r.id, r.status]));
}

export async function insertLog(runId: string, log: AgentLog): Promise<void> {
  await getDb().insert(runLogs).values({
    runId,
    timestamp: log.timestamp,
    level: log.level,
    message: log.message,
  });
}

// `userId`, when given, scopes the listing to that user's runs (the IDOR
// guard for the non-admin `GET /api/runs` list — without it the endpoint
// returns every tenant's run rows + input JSON). Admin callers pass undefined
// to see all runs.
/** Default page size for {@link listRuns}. Bounds BOTH the unscoped listing
 *  (historically capped at 100) AND the project-scoped path, which previously
 *  returned EVERY run for the project — `runs` grows one wide row (full `input`
 *  + `result` jsonb) per chat turn/agent invocation forever, so a long-lived
 *  project shipped tens of thousands of rows per page load. */
const DEFAULT_RUNS_LIMIT = 100;

export async function listRuns(
  projectId?: string,
  userId?: string,
  opts?: { limit?: number; offset?: number },
): Promise<DbRun[]> {
  const db = getDb();
  const conds = [];
  if (projectId) conds.push(eq(runs.projectId, projectId));
  if (userId) conds.push(eq(runs.userId, userId));
  const whereClause = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
  const limit = opts?.limit ?? DEFAULT_RUNS_LIMIT;
  const q = db
    .select()
    .from(runs)
    .where(whereClause)
    .orderBy(desc(runs.startedAt))
    .limit(limit)
    .$dynamic();
  if (opts?.offset !== undefined) q.offset(opts.offset);
  return q as Promise<DbRun[]>;
}

export async function getRunWithLogs(id: string): Promise<(DbRun & { logs: AgentLog[] }) | undefined> {
  const db = getDb();
  const rows = await db.select().from(runs).where(eq(runs.id, id));
  const run = rows[0] as DbRun | undefined;
  if (!run) return undefined;

  const logs = await db.select().from(runLogs).where(eq(runLogs.runId, id));
  return {
    ...run,
    logs: logs.map((l: DbRunLog) => ({ timestamp: l.timestamp, level: l.level as AgentLog["level"], message: l.message })),
  };
}

export function toAgentRun(dbRun: DbRun & { logs?: AgentLog[] }): AgentRun {
  return {
    id: dbRun.id,
    agentName: dbRun.agentName,
    projectId: dbRun.projectId ?? undefined,
    status: dbRun.status as AgentRun["status"],
    startedAt: dbRun.startedAt.getTime(),
    finishedAt: dbRun.finishedAt?.getTime(),
    logs: dbRun.logs ?? [],
    result: dbRun.result as AgentResult | undefined,
  };
}
