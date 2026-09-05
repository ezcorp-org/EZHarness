import { eq, desc, and, isNull, sql, inArray } from "drizzle-orm";
import { getDb, type DbTransaction } from "../connection";
import { runs, runLogs, activeRuns } from "../schema";
import type { AgentRun, AgentLog, AgentResult } from "../../types";
import { publishDomainEvent, type DomainExtensionEvent } from "../../extensions/domain-event-outbox";
import { canonicalJson } from "@ezcorp/extension-contract";

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

export async function updateRun(run: AgentRun, event?: DomainExtensionEvent): Promise<void> {
  const values = { status: run.status, finishedAt: run.finishedAt ? new Date(run.finishedAt) : null, result: run.result ?? null };
  if (!event) { await getDb().update(runs).set(values).where(and(eq(runs.id, run.id), eq(runs.status, "running"))); return; }
  await getDb().transaction(async (transaction: DbTransaction) => {
    const [current] = await transaction.select({ status: runs.status, conversationId: runs.conversationId, result: runs.result }).from(runs).where(eq(runs.id, run.id)).for("update");
    if (!current) { if (event) throw new Error("Terminal event has no stored run"); return; }
    const expectedType = run.status === "success" ? "run:complete" : run.status === "error" ? "run:error" : run.status === "cancelled" ? "run:cancel" : undefined;
    if (event && (event.type !== expectedType || event.conversationId !== current.conversationId || event.id !== `run:${run.id}:${run.status}`)) throw new Error("Terminal event does not match its stored run");
    if (event && current.status !== "running") {
      if (current.status !== run.status || canonicalJson(current.result) !== canonicalJson(run.result ?? null)) throw new Error("Terminal run event conflicts with its committed state");
      return;
    }
    await transaction.update(runs).set(values).where(eq(runs.id, run.id));
    const [active] = await transaction.select().from(activeRuns).where(eq(activeRuns.id, run.id));
    if (active && active.conversationId !== current.conversationId) throw new Error("Active run belongs to another conversation");
    await transaction.delete(activeRuns).where(eq(activeRuns.id, run.id));
    if (event && current.status === "running") await publishDomainEvent(transaction, event);
  });
}

/**
 * Atomically terminalize the `runs` mirror for an abnormal termination.
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
  event?: DomainExtensionEvent,
  recoverActiveOnly = false,
): Promise<number> {
  return getDb().transaction(async (transaction: DbTransaction) => {
    const eventRun = event?.payload.run as AgentRun | undefined;
    if (recoverActiveOnly) {
      if (!event || !eventRun || eventRun.id !== runId || eventRun.status !== status || event.payload.conversationId !== event.conversationId) throw new Error("Active-only recovery requires an exact terminal event");
      const [existing] = await transaction.select({ id: runs.id }).from(runs).where(eq(runs.id, runId));
      if (!existing) {
        const [active] = await transaction.select().from(activeRuns).where(eq(activeRuns.id, runId)).for("update");
        if (active?.status !== "running") return 0;
        if (active.conversationId !== event.conversationId) throw new Error("Active run belongs to another conversation");
        const [created] = await transaction.insert(runs).values({ id: runId, agentName: eventRun.agentName, conversationId: active.conversationId, status: "running", startedAt: active.startedAt }).onConflictDoNothing().returning({ id: runs.id });
        if (!created) return 0;
      }
    }
    const [row] = await transaction.update(runs).set({
      status, finishedAt: eventRun?.finishedAt ? new Date(eventRun.finishedAt) : sql`NOW()`,
      ...(eventRun?.result ? { result: eventRun.result } : error !== undefined ? { result: { success: false, output: null, error } } : {}),
    }).where(and(eq(runs.id, runId), eq(runs.status, "running"))).returning();
    if (!row) return 0;
    const type = status === "cancelled" ? "run:cancel" : "run:error";
    if (event && (event.id !== `run:${runId}:${status}` || event.type !== type || event.conversationId !== row.conversationId || event.payload.conversationId !== row.conversationId || eventRun?.id !== runId || eventRun.status !== status || event.payload.runId !== undefined && event.payload.runId !== runId)) throw new Error("Terminal event does not match its stored run");
    const [active] = await transaction.select().from(activeRuns).where(eq(activeRuns.id, runId));
    if (active && active.conversationId !== row.conversationId) throw new Error("Active run belongs to another conversation");
    await transaction.update(activeRuns).set({ status: "interrupted" }).where(and(eq(activeRuns.id, runId), eq(activeRuns.status, "running")));
    if (row.conversationId) {
      const run: AgentRun = { id: row.id, agentName: row.agentName, status, startedAt: row.startedAt.getTime(), finishedAt: row.finishedAt!.getTime(), logs: [], ...(row.result ? { result: row.result } : {}) };
      const payload = { run, runId, conversationId: row.conversationId, ...(status === "error" ? { error: error ?? "Run interrupted" } : {}) };
      await publishDomainEvent(transaction, event ?? { id: `run:${runId}:${status}`, type, conversationId: row.conversationId, payload });
    }
    return 1;
  });
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
  const rows = await getDb().select({ id: runs.id }).from(runs).where(and(eq(runs.status, "running"), isNull(runs.finishedAt)));
  let count = 0;
  for (const row of rows) count += await finalizeRunRow(row.id, "error", "Run orphaned: process restarted while run was active");
  return count;
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
