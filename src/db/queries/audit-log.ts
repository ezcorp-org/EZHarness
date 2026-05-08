import { desc, eq, and, like, or } from "drizzle-orm";
import { getDb } from "../connection";
import { auditLog } from "../schema";
import type { AuditEntry } from "../schema";
import { redactForAudit } from "../../extensions/audit-redaction";
import { persistError } from "./error-logs";

export type { AuditEntry };

/**
 * Insert a row into the shared `audit_log` table.
 *
 * The `metadata` argument is ALWAYS routed through `redactForAudit`
 * before persistence — this is the single chokepoint that every existing
 * call site (18+ across `bundled.ts`, `task-events-handler.ts`, the
 * permission grant/revoke endpoints, etc.) plus every future capability
 * handler relies on. No call site is permitted to bypass this wrapper
 * (i.e. there must be exactly one `getDb().insert(auditLog).values(...)`
 * invocation in the codebase, here).
 *
 * Pitfall #2 invariant (validator CR-4): an audit-write failure MUST
 * NEVER abort the caller. The DB insert is wrapped in try/catch and
 * routed to `persistError` (fire-and-forget) so the audit hiccup is
 * observable to admins without propagating up to the 18+ existing
 * call sites that currently `await insertAuditEntry(...)` mid-business
 * flow.
 *
 * Ref: tasks/v1.3-phase-50-audit-foundation.md § Phase 50.2.
 */
export async function insertAuditEntry(
  userId: string | null,
  action: string,
  target?: string,
  metadata?: Record<string, unknown>,
): Promise<string> {
  // Phase 4 §M2 — return the inserted row's id so callers chaining
  // audit rows (spawn-assignment seeding the child's parentAuditId)
  // don't need a follow-up SELECT. Existing void-return callers
  // simply ignore the returned id (back-compat: TS accepts ignoring
  // a non-void Promise).
  //
  // Phase 50 §M2 — metadata is ALWAYS routed through `redactForAudit`
  // and the insert is wrapped in try/catch so audit-write failures
  // never abort the caller. On failure the audit hiccup is logged
  // via `persistError` (fire-and-forget) and we return "" so callers
  // chaining on the id get a sentinel they can ignore.
  const safeMetadata = metadata
    ? (redactForAudit(metadata).redacted as Record<string, unknown> | null)
    : null;
  try {
    const inserted = await getDb()
      .insert(auditLog)
      .values({
        userId,
        action,
        target: target ?? null,
        metadata: safeMetadata,
      })
      .returning({ id: auditLog.id });
    return inserted[0]?.id ?? "";
  } catch (err) {
    await persistError({
      level: "warn",
      message: "audit-write-failed: audit_log",
      stack: err instanceof Error ? err.stack ?? null : null,
      metadata: {
        userId,
        action,
        target: target ?? null,
        error: String(err),
      },
    });
    return "";
  }
}

export async function listAuditLog(opts?: {
  limit?: number;
  offset?: number;
  action?: string;
  userId?: string;
}): Promise<AuditEntry[]> {
  const limit = opts?.limit ?? 100;
  const offset = opts?.offset ?? 0;

  const conditions = [];
  if (opts?.action) conditions.push(eq(auditLog.action, opts.action));
  if (opts?.userId) conditions.push(eq(auditLog.userId, opts.userId));

  const query = getDb().select().from(auditLog);
  const filtered = conditions.length > 0
    ? query.where(conditions.length === 1 ? conditions[0]! : and(...conditions))
    : query;

  return filtered
    .orderBy(desc(auditLog.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Fetch all extension-related audit rows for a single extension. Matches
 * both the new typed `ext:*` actions defined in
 * `src/extensions/audit-actions.ts` AND the pre-existing legacy
 * `extension:*` strings written by older grant/activate endpoints, so
 * the detail page shows a unified history without requiring a data
 * migration of historical rows.
 */
export async function listAuditForExtension(
  extensionId: string,
  opts?: { limit?: number; offset?: number },
): Promise<AuditEntry[]> {
  const limit = opts?.limit ?? 100;
  const offset = opts?.offset ?? 0;
  return getDb()
    .select()
    .from(auditLog)
    .where(and(
      eq(auditLog.target, extensionId),
      or(like(auditLog.action, "ext:%"), like(auditLog.action, "extension:%"))!,
    ))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit)
    .offset(offset);
}
