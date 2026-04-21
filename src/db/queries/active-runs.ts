import { eq, and, sql, lt } from "drizzle-orm";
import { getDb } from "../connection";
import { activeRuns } from "../schema";

export async function createActiveRun(id: string, conversationId: string) {
  const rows = await getDb()
    .insert(activeRuns)
    .values({ id, conversationId })
    .returning();
  return rows[0]!;
}

export async function getActiveRun(conversationId: string) {
  const rows = await getDb()
    .select()
    .from(activeRuns)
    .where(and(
      eq(activeRuns.conversationId, conversationId),
      eq(activeRuns.status, "running"),
    ));
  return rows[0] ?? null;
}

export async function updateHeartbeat(id: string) {
  const rows = await getDb()
    .update(activeRuns)
    .set({ lastHeartbeat: sql`NOW()` })
    .where(eq(activeRuns.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function updatePartialResponse(id: string, partialResponse: string) {
  const rows = await getDb()
    .update(activeRuns)
    .set({ partialResponse })
    .where(eq(activeRuns.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function markInterrupted(id: string) {
  const rows = await getDb()
    .update(activeRuns)
    .set({ status: "interrupted" })
    .where(eq(activeRuns.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function cleanupOrphanedRuns(timeoutMinutes: number): Promise<number> {
  const result = await getDb()
    .update(activeRuns)
    .set({ status: "interrupted" })
    .where(and(
      eq(activeRuns.status, "running"),
      lt(activeRuns.lastHeartbeat, sql`NOW() - INTERVAL '${sql.raw(String(timeoutMinutes))} minutes'`),
    ))
    .returning();
  return result.length;
}

/** Mark ALL running active_runs as interrupted. Called on startup since a fresh
 *  process has no in-memory runs — any "running" DB entry is orphaned. */
export async function interruptAllRuns(): Promise<number> {
  const result = await getDb()
    .update(activeRuns)
    .set({ status: "interrupted" })
    .where(eq(activeRuns.status, "running"))
    .returning();
  return result.length;
}

export async function deleteActiveRun(id: string): Promise<boolean> {
  const rows = await getDb()
    .delete(activeRuns)
    .where(eq(activeRuns.id, id))
    .returning({ id: activeRuns.id });
  return rows.length > 0;
}
