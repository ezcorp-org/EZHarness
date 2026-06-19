import { eq, desc, and, isNull, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { runs, runLogs } from "../schema";
import type { AgentRun, AgentLog, AgentResult } from "../../types";

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

export async function insertRun(run: AgentRun, projectId?: string, input?: Record<string, unknown>, conversationId?: string): Promise<void> {
  await getDb().insert(runs).values({
    id: run.id,
    agentName: run.agentName,
    projectId: projectId ?? null,
    conversationId: conversationId ?? null,
    status: run.status,
    input: input ?? null,
    startedAt: new Date(run.startedAt),
    createdAt: new Date(),
  });
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

export async function insertLog(runId: string, log: AgentLog): Promise<void> {
  await getDb().insert(runLogs).values({
    runId,
    timestamp: log.timestamp,
    level: log.level,
    message: log.message,
  });
}

export async function listRuns(projectId?: string): Promise<DbRun[]> {
  const db = getDb();
  if (projectId) {
    return db.select().from(runs).where(eq(runs.projectId, projectId)).orderBy(desc(runs.startedAt)) as Promise<DbRun[]>;
  }
  return db.select().from(runs).orderBy(desc(runs.startedAt)).limit(100) as Promise<DbRun[]>;
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
