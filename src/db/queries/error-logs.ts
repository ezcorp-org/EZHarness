import { sql, desc, lt } from "drizzle-orm";
import { getDb } from "../connection";
import { errorLogs } from "../schema";
import type { ErrorLog } from "../schema";

export type { ErrorLog };

/**
 * Persist an error log entry. Fire-and-forget safe: silently ignores DB errors
 * to avoid circular dependency with logger.
 */
export async function persistError(opts: {
  level: string;
  message: string;
  stack?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await getDb()
      .insert(errorLogs)
      .values({
        level: opts.level,
        message: opts.message,
        stack: opts.stack ?? null,
        metadata: opts.metadata ?? null,
      });
  } catch {
    // Fire-and-forget: silently ignore DB errors
  }
}

/**
 * Return total count of error log entries.
 */
export async function countErrors(): Promise<number> {
  const result = await getDb()
    .select({ count: sql<number>`COUNT(*)`.as("count") })
    .from(errorLogs);
  return result[0]?.count ?? 0;
}

/**
 * List error logs with pagination, ordered by most recent first.
 */
export async function listErrors(opts?: {
  limit?: number;
  offset?: number;
}): Promise<ErrorLog[]> {
  const limit = opts?.limit ?? 100;
  const offset = opts?.offset ?? 0;

  return getDb()
    .select()
    .from(errorLogs)
    .orderBy(desc(errorLogs.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Delete error log entries older than the retention period.
 * @param retentionDays Number of days to keep (default 30)
 * @returns Number of deleted rows
 */
export async function cleanupOldErrors(retentionDays = 30): Promise<number> {
  const rows = await getDb()
    .delete(errorLogs)
    .where(lt(errorLogs.createdAt, sql`NOW() - INTERVAL '${sql.raw(String(retentionDays))} days'`))
    .returning({ id: errorLogs.id });
  return rows.length;
}
