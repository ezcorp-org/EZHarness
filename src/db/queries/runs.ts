import { eq, desc } from "drizzle-orm";
import { getDb } from "../connection";
import { runs, runLogs } from "../schema";
import type { AgentRun, AgentLog, AgentResult } from "../../types";

export interface DbRun {
  id: string;
  agentName: string;
  projectId: string | null;
  status: string;
  input: Record<string, unknown> | null;
  startedAt: Date;
  finishedAt: Date | null;
  result: { success: boolean; output: unknown; error?: string } | null;
  createdAt: Date;
}

type DbRunLog = typeof runLogs.$inferSelect;

export async function insertRun(run: AgentRun, projectId?: string, input?: Record<string, unknown>): Promise<void> {
  await getDb().insert(runs).values({
    id: run.id,
    agentName: run.agentName,
    projectId: projectId ?? null,
    status: run.status,
    input: input ?? null,
    startedAt: new Date(run.startedAt),
    createdAt: new Date(),
  });
}

export async function updateRun(run: AgentRun): Promise<void> {
  await getDb().update(runs).set({
    status: run.status,
    finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
    result: run.result ?? null,
  }).where(eq(runs.id, run.id));
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
