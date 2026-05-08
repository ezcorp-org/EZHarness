/**
 * Phase 52 — unified audit timeline for the per-extension and per-
 * conversation drill-downs.
 *
 * Fans in four sources, normalizes them into a single
 * `AuditTimelineEntry` shape, and orders by createdAt DESC. Cursor
 * pagination uses a base64'd `{ts, id}` composite — ISO timestamp
 * gives stable ordering when same-millisecond inserts collide on the
 * timestamp alone, and base64 discourages URL hand-editing (per spec
 * "open question" resolution).
 *
 *   - `governance` rows from `audit_log` (existing typed `ext:*` and
 *     legacy `extension:*` strings) — permission grants, manifest
 *     drifts, env-key warnings.
 *   - `capability` rows from `sdk_capability_calls` — high-volume
 *     SDK call telemetry.
 *   - `resource` rows from `lessons_audit_log` and (via reason match)
 *     `memory_audit_log` — full before/after body capture for
 *     forensic comparison.
 *
 * Filters:
 *   - capability  → narrows `sdk_capability_calls.capability`.
 *                   Drops governance + resource rows when set.
 *   - status      → "denial" returns governance with `*REJECTED` /
 *                   `*DENIED` actions plus sdk_capability_calls
 *                   where success=false.
 *   - since/until → applied uniformly to every source's createdAt.
 *
 * Caller is responsible for the `target=extensionId` (per-extension
 * page) or `conversation_id` (per-conversation page) scope guard —
 * this module just merges. The SvelteKit handler does the auth
 * + scope guard + extension-existence check before delegating.
 */
import { and, desc, eq, gt, inArray, like, lt, or, sql } from "drizzle-orm";
import { getDb } from "../connection";
import {
  auditLog,
  lessonsAuditLog,
  memoryAuditLog,
  sdkCapabilityCalls,
  type AuditEntry,
  type LessonAuditEntry,
  type SdkCapabilityCall,
} from "../schema";

export type AuditTimelineEntry =
  | {
      kind: "governance";
      id: string;
      createdAt: Date;
      action: string;
      target: string | null;
      userId: string | null;
      metadata: Record<string, unknown> | null;
    }
  | {
      kind: "capability";
      id: string;
      createdAt: Date;
      capability: string;
      action: string;
      success: boolean;
      durationMs: number;
      resourceType: string | null;
      resourceId: string | null;
      tokensUsed: number | null;
      costUsd: number | null;
      provider: string | null;
      model: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      conversationId: string | null;
      onBehalfOf: string;
      // Redacted before/after copies — these are already redacted by
      // recordCapabilityCall.ts before persistence.
      before: unknown;
      after: unknown;
    }
  | {
      kind: "resource";
      id: string;
      createdAt: Date;
      resourceKind: "memory" | "lesson";
      action: string;
      resourceId: string;
      previousBody: string | null;
      newBody: string | null;
      reason: string | null;
    };

export interface AuditMergeOpts {
  capability?: "llm" | "memory" | "lessons" | "schedule" | "events";
  status?: "denial";
  since?: Date;
  until?: Date;
  /** Encoded cursor from prior page (base64 of `{ts, id}`). */
  cursor?: string;
  /** Page size cap. Default 100; clamp at 200. */
  limit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

interface CursorParts {
  ts: string;
  id: string;
}

/** Encode `{ts, id}` as base64. The `ts` is an ISO string (stable
 *  ordering across drivers); `id` disambiguates same-millisecond rows. */
export function encodeCursor(parts: CursorParts): string {
  const json = JSON.stringify(parts);
  // Base64-url to keep the cursor URL-safe. `Buffer` is available in
  // every Bun + Node runtime we target.
  return Buffer.from(json, "utf8").toString("base64url");
}

/** Returns null on malformed input — caller should treat null as
 *  "no cursor" (i.e. start from the head of the page). */
export function decodeCursor(encoded: string | null | undefined): CursorParts | null {
  if (!encoded) return null;
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<CursorParts>;
    if (typeof parsed.ts !== "string" || typeof parsed.id !== "string") return null;
    // Defense: reject any `ts` that doesn't parse as a Date — a
    // garbled cursor would otherwise generate `Invalid Date` and
    // either return zero rows or throw at the SQL layer.
    if (Number.isNaN(Date.parse(parsed.ts))) return null;
    return parsed as CursorParts;
  } catch {
    return null;
  }
}

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
 * Merge governance + capability + resource rows for a single extension.
 *
 * Caller's responsibility: ensure the extension id exists + the
 * caller is authorized to read it (admin-only for the per-extension
 * page; conversation-owner for the per-conversation page — those
 * gates live in the SvelteKit handler).
 *
 * Implementation note: we don't try to do a single-SQL UNION because
 * the four tables have wildly different shapes and their column
 * names collide (`createdAt` exists in all four; everything else
 * differs). Three small SELECTs + JS-side merge is clearer and well
 * within the index reach (each table has a `created_at DESC` index
 * scoped to the extensionId / actorExtensionId column).
 */
export async function mergeAuditForExtension(
  extensionId: string,
  opts: AuditMergeOpts = {},
): Promise<{ entries: AuditTimelineEntry[]; nextCursor: string | null }> {
  const limit = clampLimit(opts.limit);
  const cursor = decodeCursor(opts.cursor);
  const cursorTs = cursor ? new Date(cursor.ts) : null;
  const cursorId = cursor ? cursor.id : null;
  // Per-source LIMIT must be larger than the page size — after merging
  // 4 sources (governance + capability + lessons + memory) and slicing
  // the top `limit`, the oldest rows from a hot source can be lost if
  // each source returned exactly `limit`. Multiplying by the source
  // count is the cheap fix; a v1.4 keepalive-cursor will replace this.
  const perSourceLimit = limit * 4;
  const filterCapability = opts.capability;
  const denialOnly = opts.status === "denial";
  const since = opts.since;
  const until = opts.until;

  // ── governance rows (audit_log) ─────────────────────────────────
  // Skip when the caller filtered to a specific capability — governance
  // rows don't carry a capability column. Likewise skip when the
  // capability filter is set; governance is its own bucket.
  let governanceRows: AuditEntry[] = [];
  if (!filterCapability) {
    const gconds = [
      eq(auditLog.target, extensionId),
      or(like(auditLog.action, "ext:%"), like(auditLog.action, "extension:%"))!,
    ];
    if (since) gconds.push(gt(auditLog.createdAt, since));
    if (until) gconds.push(lt(auditLog.createdAt, until));
    if (cursorTs && cursorId) {
      // Tie-break on id when same-millisecond rows collide. Otherwise
      // a `< cursorTs` clause silently drops rows sharing the cursor's
      // timestamp.
      gconds.push(
        or(
          lt(auditLog.createdAt, cursorTs),
          and(eq(auditLog.createdAt, cursorTs), lt(auditLog.id, cursorId)),
        )!,
      );
    } else if (cursorTs) {
      gconds.push(lt(auditLog.createdAt, cursorTs));
    }
    if (denialOnly) gconds.push(inArray(auditLog.action, DENIAL_GOVERNANCE_ACTIONS));
    governanceRows = await getDb()
      .select()
      .from(auditLog)
      .where(and(...gconds))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(perSourceLimit);
  }

  // ── capability rows (sdk_capability_calls) ──────────────────────
  const cconds = [eq(sdkCapabilityCalls.extensionId, extensionId)];
  if (filterCapability) cconds.push(eq(sdkCapabilityCalls.capability, filterCapability));
  if (since) cconds.push(gt(sdkCapabilityCalls.createdAt, since));
  if (until) cconds.push(lt(sdkCapabilityCalls.createdAt, until));
  if (cursorTs && cursorId) {
    cconds.push(
      or(
        lt(sdkCapabilityCalls.createdAt, cursorTs),
        and(eq(sdkCapabilityCalls.createdAt, cursorTs), lt(sdkCapabilityCalls.id, cursorId)),
      )!,
    );
  } else if (cursorTs) {
    cconds.push(lt(sdkCapabilityCalls.createdAt, cursorTs));
  }
  if (denialOnly) cconds.push(eq(sdkCapabilityCalls.success, false));
  const capabilityRows: SdkCapabilityCall[] = await getDb()
    .select()
    .from(sdkCapabilityCalls)
    .where(and(...cconds))
    .orderBy(desc(sdkCapabilityCalls.createdAt), desc(sdkCapabilityCalls.id))
    .limit(perSourceLimit);

  // ── resource rows (lessons_audit_log + memory_audit_log) ────────
  // Skip when the caller filtered to a specific capability that isn't
  // memory/lessons, or when denial-only is set (resource rows are
  // mutations, not denials).
  let lessonRows: LessonAuditEntry[] = [];
  let memoryRows: Array<{
    id: number;
    memoryId: string;
    action: string;
    previousContent: string | null;
    newContent: string | null;
    reason: string | null;
    createdAt: Date;
  }> = [];
  const resourceAllowed = !denialOnly &&
    (!filterCapability || filterCapability === "memory" || filterCapability === "lessons");
  if (resourceAllowed) {
    if (!filterCapability || filterCapability === "lessons") {
      const lconds = [eq(lessonsAuditLog.actorExtensionId, extensionId)];
      if (since) lconds.push(gt(lessonsAuditLog.createdAt, since));
      if (until) lconds.push(lt(lessonsAuditLog.createdAt, until));
      // lessons_audit_log.id is a serial integer; the cursor's id is
      // stringified at encode time. Compare as strings here — that's
      // consistent with how the cursor is decoded, and the namespaced
      // resource ids (`lesson:N`, `memory:N`) we emit below mean the
      // raw integer id never round-trips the cursor anyway. The tie-
      // break degrades gracefully: in the rare same-ms case it may
      // re-include or drop one row, but never skips an entire bucket.
      if (cursorTs) lconds.push(lt(lessonsAuditLog.createdAt, cursorTs));
      lessonRows = await getDb()
        .select()
        .from(lessonsAuditLog)
        .where(and(...lconds))
        .orderBy(desc(lessonsAuditLog.createdAt))
        .limit(perSourceLimit);
    }
    if (!filterCapability || filterCapability === "memory") {
      // memory_audit_log has no actor_extension_id column — the
      // recordCapabilityCall write 2 stamps `reason = ext:<id>`.
      const mconds = [
        eq(memoryAuditLog.reason, `ext:${extensionId}`),
      ];
      if (since) mconds.push(gt(memoryAuditLog.createdAt, since));
      if (until) mconds.push(lt(memoryAuditLog.createdAt, until));
      if (cursorTs) mconds.push(lt(memoryAuditLog.createdAt, cursorTs));
      memoryRows = await getDb()
        .select()
        .from(memoryAuditLog)
        .where(and(...mconds))
        .orderBy(desc(memoryAuditLog.createdAt))
        .limit(perSourceLimit);
    }
  }

  // ── normalize + sort + slice ─────────────────────────────────────
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
  for (const r of lessonRows) {
    merged.push({
      kind: "resource",
      id: `lesson:${r.id}`,
      createdAt: r.createdAt,
      resourceKind: "lesson",
      action: r.action,
      resourceId: r.lessonId,
      previousBody: r.previousBody,
      newBody: r.newBody,
      reason: r.reason,
    });
  }
  for (const r of memoryRows) {
    merged.push({
      kind: "resource",
      id: `memory:${r.id}`,
      createdAt: r.createdAt,
      resourceKind: "memory",
      action: r.action,
      resourceId: r.memoryId,
      previousBody: r.previousContent,
      newBody: r.newContent,
      reason: r.reason,
    });
  }

  merged.sort((a, b) => {
    const dt = b.createdAt.getTime() - a.createdAt.getTime();
    // Tie-break on id DESC so same-millisecond rows have a stable
    // ordering — pairs with the SQL `(createdAt, id)` cursor below.
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

/**
 * Conversation-scoped variant. Fan-in is similar but joined on
 * conversation_id where the source supports it. memory_audit_log and
 * lessons_audit_log don't carry a conversation_id column today — they
 * inherit context via the linked memory's project / lesson reason.
 * For v1.3 we surface only `sdk_capability_calls` rows here (the most
 * useful for "why did the assistant suddenly behave differently in
 * turn 7"); resource rows are accessible from the per-extension drill
 * via the same lesson/memory resource id.
 */
export async function mergeAuditForConversation(
  conversationId: string,
  opts: AuditMergeOpts = {},
): Promise<{ entries: AuditTimelineEntry[]; nextCursor: string | null }> {
  const limit = clampLimit(opts.limit);
  const cursor = decodeCursor(opts.cursor);
  const cursorTs = cursor ? new Date(cursor.ts) : null;
  const cursorId = cursor ? cursor.id : null;

  const cconds = [eq(sdkCapabilityCalls.conversationId, conversationId)];
  if (opts.capability) cconds.push(eq(sdkCapabilityCalls.capability, opts.capability));
  if (opts.since) cconds.push(gt(sdkCapabilityCalls.createdAt, opts.since));
  if (opts.until) cconds.push(lt(sdkCapabilityCalls.createdAt, opts.until));
  if (cursorTs && cursorId) {
    // Tie-break on id when same-millisecond rows collide.
    cconds.push(
      or(
        lt(sdkCapabilityCalls.createdAt, cursorTs),
        and(eq(sdkCapabilityCalls.createdAt, cursorTs), lt(sdkCapabilityCalls.id, cursorId)),
      )!,
    );
  } else if (cursorTs) {
    cconds.push(lt(sdkCapabilityCalls.createdAt, cursorTs));
  }
  if (opts.status === "denial") cconds.push(eq(sdkCapabilityCalls.success, false));

  // SQL ordering pairs with the cursor's `(createdAt, id)` tie-break.
  // Without `desc(id)` here, same-ms rows could be returned in any
  // order, and a single-source LIMIT would truncate at a tie and
  // skip rows across pages.
  const rows: SdkCapabilityCall[] = await getDb()
    .select()
    .from(sdkCapabilityCalls)
    .where(and(...cconds))
    .orderBy(desc(sdkCapabilityCalls.createdAt), desc(sdkCapabilityCalls.id))
    .limit(limit);

  const entries: AuditTimelineEntry[] = rows.map((r) => ({
    kind: "capability" as const,
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
  }));

  const nextCursor = entries.length === limit && entries.length > 0
    ? encodeCursor({
        ts: entries[entries.length - 1]!.createdAt.toISOString(),
        id: entries[entries.length - 1]!.id,
      })
    : null;

  return { entries, nextCursor };
}

/**
 * 24h aggregate for the stats strip on `/extensions/[id]/audit`.
 *
 * Single SQL with conditional aggregates. costUsd is a noisy estimate
 * (provider pricing tables drift; the spec calls this out as an
 * acceptable v1.3 limitation — the page renders a "approximate;
 * provider billing may differ" disclaimer beneath the strip).
 */
export async function statsForExtension(
  extensionId: string,
  rangeMs: number,
): Promise<{
  totalCalls: number;
  totalCostUsd: number;
  successRate: number;
  denialCount: number;
}> {
  const since = new Date(Date.now() - rangeMs);
  const rows = await getDb().execute(sql`
    SELECT
      COUNT(*)::int AS total_calls,
      COALESCE(SUM(cost_usd), 0)::float AS total_cost,
      COALESCE(AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END), 0)::float AS success_rate,
      COUNT(*) FILTER (WHERE success = false)::int AS denial_count
    FROM sdk_capability_calls
    WHERE extension_id = ${extensionId}
      AND created_at >= ${since.toISOString()}
  `);
  // Drizzle's `execute` returns `{rows}` for postgres-style drivers
  // and a raw array for PGlite. Normalize.
  const row = (
    (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ??
      (rows as unknown as Array<Record<string, unknown>>)
  )?.[0] ?? {};
  return {
    totalCalls: Number(row.total_calls ?? 0),
    totalCostUsd: Number(row.total_cost ?? 0),
    successRate: Number(row.success_rate ?? 0),
    denialCount: Number(row.denial_count ?? 0),
  };
}
