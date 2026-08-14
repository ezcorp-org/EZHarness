import { desc, eq, and, inArray, like, lt, or } from "drizzle-orm";
import { getDb } from "../connection";
import { nowMinusInterval, safeIntervalCount } from "./sql-interval";
import { auditLog } from "../schema";
import type { AuditEntry } from "../schema";
import { redactForAudit } from "../../extensions/audit-redaction";
import { persistError } from "./error-logs";

export type { AuditEntry };

/**
 * Default `audit_log` retention window, in days.
 *
 * 180 was chosen against the retention windows this repo already ships:
 * `error_logs` keeps 30 days (transient diagnostics), and the longest
 * existing window is 90 (`global:sdkLlmRetentionDays`,
 * `…ScheduleRetentionDays`). `audit_log` is the governance record — the
 * table a permission review, an incident reconstruction or a SIEM export
 * reads — so it earns a longer window than the telemetry beside it, and
 * double the longest existing one is the conservative step. It stays far
 * inside the shared `safeIntervalCount` ceiling of 3650 days, so an
 * operator who needs a compliance-mandated year (or ten) just sets the
 * env var.
 *
 * Before #206 there was no sweep at all and the table grew for the life
 * of the instance.
 */
export const DEFAULT_AUDIT_RETENTION_DAYS = 180;

/** Env var an operator sets to change the window. */
export const AUDIT_RETENTION_ENV = "EZCORP_AUDIT_RETENTION_DAYS";

/**
 * Resolve the effective retention window from a raw env string.
 *
 * Fail-safe direction: anything unparseable, or a value below one day,
 * falls back to {@link DEFAULT_AUDIT_RETENTION_DAYS} rather than clamping
 * to `1`. `EZCORP_AUDIT_RETENTION_DAYS=0` is the shape an operator writes
 * meaning "keep forever"; clamping that to 1 would purge all but today's
 * governance record, which is the one outcome this knob must never be
 * able to produce by accident. (Disabling the sweep is deliberately NOT
 * offered — the pre-#206 unbounded growth is the bug, not the feature.)
 *
 * The upper bound is `safeIntervalCount`'s own 3650, so the number here
 * always means the same thing the SQL interval will mean.
 */
export function resolveAuditRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_AUDIT_RETENTION_DAYS;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_AUDIT_RETENTION_DAYS;
  return safeIntervalCount(n, DEFAULT_AUDIT_RETENTION_DAYS);
}

/** Rows deleted per statement. Bounds both the transaction and the id
 *  array held in memory on a first sweep over a long-lived instance. */
const AUDIT_CLEANUP_BATCH_LIMIT = 5000;

/** Batch ceiling per tick (5000 × 200 = 1M rows), so a pathological
 *  backlog cannot hold the sweep — or PGlite — for an unbounded time.
 *  The next hourly tick continues where this one stopped. */
const AUDIT_CLEANUP_MAX_BATCHES = 200;

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
 * Delete `audit_log` rows older than the retention window (#206).
 *
 * Runs hourly from `src/startup/background-timers.ts`, alongside the
 * `error_logs` sweep it is modelled on. Batched — unlike
 * `cleanupOldErrors`, which deletes in one statement — because this table
 * has never been swept: the FIRST tick on an instance that has been up for
 * a year is the large one, and a single unbounded `DELETE … RETURNING`
 * would both lock the table and materialise every deleted id at once.
 *
 * Select-then-delete rather than a `DELETE … LIMIT` subselect so the count
 * is exact on every driver (PGlite and `Bun.sql` report affected rows
 * differently — see the shape-probing in
 * `sdk-capability-calls.ts:cleanupOldSdkCapabilityCalls`).
 *
 * @param retentionDays Days to keep. Resolved through
 *   {@link resolveAuditRetentionDays}, so a nonsense value keeps the
 *   default window rather than purging.
 * @returns Number of rows deleted.
 */
export async function cleanupOldAuditLog(
  retentionDays: number = DEFAULT_AUDIT_RETENTION_DAYS,
): Promise<number> {
  const days = resolveAuditRetentionDays(String(retentionDays));
  let deleted = 0;
  for (let batch = 0; batch < AUDIT_CLEANUP_MAX_BATCHES; batch++) {
    const stale: Array<{ id: string }> = await getDb()
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(lt(auditLog.createdAt, nowMinusInterval(days, "days", DEFAULT_AUDIT_RETENTION_DAYS)))
      .limit(AUDIT_CLEANUP_BATCH_LIMIT);
    if (stale.length === 0) break;
    const ids = stale.map((row) => row.id);
    await getDb().delete(auditLog).where(inArray(auditLog.id, ids));
    deleted += stale.length;
    if (stale.length < AUDIT_CLEANUP_BATCH_LIMIT) break;
  }
  return deleted;
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
