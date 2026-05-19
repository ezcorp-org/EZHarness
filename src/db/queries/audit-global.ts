/**
 * Phase 52.4 — global admin audit feed.
 *
 * Cross-extension cursor-paginated read over `sdk_capability_calls`
 * + governance rows. The per-extension merger
 * (`mergeAuditForExtension`) is scoped to one extensionId; this
 * variant is the same shape but without the extensionId filter.
 *
 * Stats strip aggregates over the 24h window:
 *   - denialCount: SUM(success=false)
 *   - top-3 chattiest extensions by call count
 *   - top-3 LLM spenders by extension (cost_usd is approximate; the
 *     UI carries the same disclaimer the per-extension stats strip does)
 */
import { and, desc, eq, inArray, like, lt, or, sql } from "drizzle-orm";
// Note: `like` from drizzle-orm emits `LIKE <pattern>` without an
// `ESCAPE` clause, so backslash-escaped wildcards like `\%` are not
// interpreted as literals by Postgres. We strip wildcard / escape
// chars from user input before substring-matching to keep the user's
// `%` from acting as a wildcard. See `sanitizeSearchTerm` below.
import { getDb } from "../connection";
import {
  auditLog,
  extensions,
  sdkCapabilityCalls,
  type AuditEntry,
  type SdkCapabilityCall,
} from "../schema";
import { decodeCursor, encodeCursor, type AuditTimelineEntry } from "./audit-merge";

export interface GlobalAuditOpts {
  extensionId?: string;
  capability?: "llm" | "memory" | "lessons" | "schedule" | "events";
  action?: string;
  onBehalfOf?: string;
  denialOnly?: boolean;
  search?: string;
  cursor?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const DENIAL_GOVERNANCE_ACTIONS = [
  "ext:permission-rejected",
  "ext:capability-revoked",
  "ext:sdk-llm-rejected",
  "ext:sdk-memory-rejected",
  "ext:sdk-lessons-rejected",
  "ext:sdk-schedule-rejected",
  "ext:sdk-event-delivery-rejected",
  "ext:sdk-llm-denied-and-disabled",
  "ext:sdk-schedule-quota-exceeded",
  "ext:emit-event-rejected",
  "ext:event-subscription-denied",
];

function clampLimit(input?: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(input)));
}

/**
 * Strip LIKE wildcards (`%`, `_`) and the backslash escape from a
 * user-supplied search term before wrapping it in `%…%`. Without
 * this, a `?q=%` would expand to `LIKE '%%%'` and match every row.
 *
 * We deliberately strip rather than ESCAPE because:
 *   1. drizzle's `like()` doesn't emit `ESCAPE '\\'`, so a backslash
 *      escape is a no-op under Postgres.
 *   2. No admin user actually wants substring matching on a literal
 *      `%` in an audit search; the data we're matching against
 *      (resourceId / errorMessage / model) doesn't contain wildcards
 *      organically.
 */
function sanitizeSearchTerm(input: string): string {
  return input.replace(/[%_\\]/g, "");
}

export async function listGlobalAudit(
  opts: GlobalAuditOpts = {},
): Promise<{ entries: AuditTimelineEntry[]; nextCursor: string | null }> {
  const limit = clampLimit(opts.limit);
  const cursor = decodeCursor(opts.cursor);
  const cursorTs = cursor ? new Date(cursor.ts) : null;
  const cursorId = cursor ? cursor.id : null;

  // Capability rows
  const cconds = [];
  if (opts.extensionId) cconds.push(eq(sdkCapabilityCalls.extensionId, opts.extensionId));
  if (opts.capability) cconds.push(eq(sdkCapabilityCalls.capability, opts.capability));
  if (opts.action) cconds.push(eq(sdkCapabilityCalls.action, opts.action));
  if (opts.onBehalfOf) cconds.push(eq(sdkCapabilityCalls.onBehalfOf, opts.onBehalfOf));
  if (opts.denialOnly) cconds.push(eq(sdkCapabilityCalls.success, false));
  if (cursorTs && cursorId) {
    // Tie-break on id when same-millisecond rows collide. The plain
    // `<` clause silently drops every row sharing the cursor's ts.
    cconds.push(
      or(
        lt(sdkCapabilityCalls.createdAt, cursorTs),
        and(eq(sdkCapabilityCalls.createdAt, cursorTs), lt(sdkCapabilityCalls.id, cursorId)),
      )!,
    );
  } else if (cursorTs) {
    cconds.push(lt(sdkCapabilityCalls.createdAt, cursorTs));
  }
  // search: substring against resourceId / errorMessage / model. Strip
  // wildcard chars from user input — see `sanitizeSearchTerm`.
  if (opts.search) {
    const sanitized = sanitizeSearchTerm(opts.search);
    if (sanitized.length > 0) {
      const term = `%${sanitized}%`;
      cconds.push(
        or(
          like(sdkCapabilityCalls.resourceId, term),
          like(sdkCapabilityCalls.errorMessage, term),
          like(sdkCapabilityCalls.model, term),
        )!,
      );
    }
  }
  // Order by `(createdAt DESC, id DESC)` so same-millisecond rows
  // have a deterministic position — the JS-side merger below applies
  // the same composite ordering. Without the id tie-break in SQL the
  // LIMIT below could truncate AT a tie and skip a row across pages.
  // Per-source LIMIT bumped to `limit * 2` to give the JS merger
  // headroom when governance + capability sources share a hot ts.
  const capQuery = getDb()
    .select()
    .from(sdkCapabilityCalls)
    .orderBy(desc(sdkCapabilityCalls.createdAt), desc(sdkCapabilityCalls.id))
    .limit(limit * 2);
  const capabilityRows: SdkCapabilityCall[] = cconds.length > 0
    ? await capQuery.where(and(...cconds))
    : await capQuery;

  // Governance rows — only when the caller didn't specify a
  // capability filter (governance has no capability column).
  let governanceRows: AuditEntry[] = [];
  if (!opts.capability && !opts.onBehalfOf) {
    const gconds = [
      or(like(auditLog.action, "ext:%"), like(auditLog.action, "extension:%"))!,
    ];
    if (opts.extensionId) gconds.push(eq(auditLog.target, opts.extensionId));
    if (opts.action) gconds.push(eq(auditLog.action, opts.action));
    if (cursorTs && cursorId) {
      gconds.push(
        or(
          lt(auditLog.createdAt, cursorTs),
          and(eq(auditLog.createdAt, cursorTs), lt(auditLog.id, cursorId)),
        )!,
      );
    } else if (cursorTs) {
      gconds.push(lt(auditLog.createdAt, cursorTs));
    }
    if (opts.denialOnly) gconds.push(inArray(auditLog.action, DENIAL_GOVERNANCE_ACTIONS));
    governanceRows = await getDb()
      .select()
      .from(auditLog)
      .where(and(...gconds))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit * 2);
  }

  const merged: AuditTimelineEntry[] = [];
  for (const r of governanceRows) {
    merged.push({
      kind: "governance",
      id: r.id,
      createdAt: r.createdAt,
      action: r.action,
      target: r.target,
      userId: r.userId,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    });
  }
  for (const r of capabilityRows) {
    merged.push({
      kind: "capability",
      id: r.id,
      createdAt: r.createdAt,
      capability: r.capability,
      action: r.action,
      success: r.success,
      durationMs: r.durationMs,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      tokensUsed: r.tokensUsed,
      costUsd: r.costUsd,
      provider: r.provider,
      model: r.model,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      conversationId: r.conversationId,
      onBehalfOf: r.onBehalfOf,
      before: r.before,
      after: r.after,
    });
  }

  merged.sort((a, b) => {
    const dt = b.createdAt.getTime() - a.createdAt.getTime();
    // Tie-break on id DESC — pairs with the SQL `(createdAt, id)`
    // cursor so same-millisecond rows have stable cross-page ordering.
    if (dt !== 0) return dt;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  const page = merged.slice(0, limit);
  const nextCursor = page.length === limit && page.length > 0
    ? encodeCursor({
        ts: page[page.length - 1]!.createdAt.toISOString(),
        id: page[page.length - 1]!.id,
      })
    : null;

  return { entries: page, nextCursor };
}

export interface GlobalStats {
  windowMs: number;
  denialCount: number;
  totalCalls: number;
  totalCostUsd: number;
  topChattiest: Array<{ extensionId: string; name: string; calls: number }>;
  topLlmSpenders: Array<{ extensionId: string; name: string; costUsd: number }>;
}

/** 24h global stats strip aggregate. */
export async function globalStats(rangeMs: number): Promise<GlobalStats> {
  const since = new Date(Date.now() - rangeMs);
  // Single roll-up for headline numbers.
  const headlineRows = await getDb().execute(sql`
    SELECT
      COUNT(*)::int AS total_calls,
      COUNT(*) FILTER (WHERE success = false)::int AS denial_count,
      COALESCE(SUM(cost_usd), 0)::float AS total_cost
    FROM sdk_capability_calls
    WHERE created_at >= ${since.toISOString()}
  `);
  const headline = pickFirstRow(headlineRows);

  // Top-3 chattiest by call count (any capability).
  const chattiestRows = await getDb().execute(sql`
    SELECT s.extension_id AS extension_id,
           e.name AS name,
           COUNT(*)::int AS calls
    FROM sdk_capability_calls s
    LEFT JOIN extensions e ON e.id = s.extension_id
    WHERE s.created_at >= ${since.toISOString()}
    GROUP BY s.extension_id, e.name
    ORDER BY calls DESC
    LIMIT 3
  `);

  // Top-3 LLM spenders (only the LLM bucket carries cost_usd).
  const spendersRows = await getDb().execute(sql`
    SELECT s.extension_id AS extension_id,
           e.name AS name,
           COALESCE(SUM(s.cost_usd), 0)::float AS cost_usd
    FROM sdk_capability_calls s
    LEFT JOIN extensions e ON e.id = s.extension_id
    WHERE s.created_at >= ${since.toISOString()}
      AND s.capability = 'llm'
    GROUP BY s.extension_id, e.name
    ORDER BY cost_usd DESC
    LIMIT 3
  `);

  return {
    windowMs: rangeMs,
    denialCount: Number(headline.denial_count ?? 0),
    totalCalls: Number(headline.total_calls ?? 0),
    totalCostUsd: Number(headline.total_cost ?? 0),
    topChattiest: pickRows(chattiestRows).map((r) => ({
      extensionId: String(r.extension_id ?? ""),
      name: String(r.name ?? "(unknown)"),
      calls: Number(r.calls ?? 0),
    })),
    topLlmSpenders: pickRows(spendersRows).map((r) => ({
      extensionId: String(r.extension_id ?? ""),
      name: String(r.name ?? "(unknown)"),
      costUsd: Number(r.cost_usd ?? 0),
    })),
  };
}

function pickRows(result: unknown): Array<Record<string, unknown>> {
  return (
    (result as { rows?: Array<Record<string, unknown>> }).rows ??
      (result as Array<Record<string, unknown>>)
  ) ?? [];
}

function pickFirstRow(result: unknown): Record<string, unknown> {
  return pickRows(result)[0] ?? {};
}

/** Re-export unused so the page can render extension picker chips
 *  with the friendly extension name. Trivial — already a one-liner
 *  in queries/extensions.ts but the path import is one less import
 *  for the audit page. */
export async function listExtensionsForFacets(): Promise<Array<{ id: string; name: string; isBundled: boolean }>> {
  const rows: Array<{ id: string; name: string; isBundled: boolean }> = await getDb().select({
    id: extensions.id,
    name: extensions.name,
    isBundled: extensions.isBundled,
  }).from(extensions);
  return rows.map((r) => ({ id: r.id, name: r.name, isBundled: r.isBundled }));
}

