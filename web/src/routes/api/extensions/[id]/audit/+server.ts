import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireAuth, requireRole } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { mergeAuditForExtension } from "$server/db/queries/audit-merge";
import { listAuditForExtension } from "$server/db/queries/audit-log";
import { getExtension } from "$server/db/queries/extensions";
import { errorJson } from "$lib/server/http-errors";

/**
 * GET /api/extensions/[id]/audit
 *
 * Phase 52.2 — unified audit timeline for a single extension. Fans in
 * three sources via `mergeAuditForExtension`:
 *   1. governance rows (audit_log, ext:* / extension:* actions)
 *   2. SDK capability calls (sdk_capability_calls)
 *   3. resource mutations (lessons_audit_log + memory_audit_log via
 *      `reason='ext:<id>'`)
 *
 * Admin-only — the rows include `actor` identifiers and reveal the
 * history of permission grants + every memory/lesson mutation the
 * extension performed.
 *
 * Filters (query string):
 *   ?capability=llm|memory|lessons|schedule|events  → narrow to one bucket
 *   ?status=denial                                  → governance + sdk denials
 *   ?since=<iso>                                    → lower bound
 *   ?until=<iso>                                    → upper bound
 *   ?cursor=<base64>                                → next page
 *   ?limit=<n>                                      → page size, clamp [1,200]
 *
 * Legacy ?limit/?offset are honoured by falling back to
 * `listAuditForExtension` (governance-only) when the caller passes
 * `?legacy=1`. The pre-merger handler shape is exposed for the
 * existing server-test suite + any tooling pinned to that contract.
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  requireRole(locals, "admin");

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  // Legacy governance-only endpoint preserved for the existing
  // server-test suite and any consumers that expected the prior
  // `{entries: AuditEntry[]}` shape.
  if (url.searchParams.get("legacy") === "1") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10), 500);
    const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10), 0);
    const entries = await listAuditForExtension(params.id, { limit, offset });
    return json({ entries });
  }

  const capability = url.searchParams.get("capability");
  const status = url.searchParams.get("status");
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const rawLimit = url.searchParams.get("limit");

  // Parse capability against the known bucket allowlist; reject silently
  // (treat as undefined) on unknown values so tampered query strings
  // don't surface as 500s — the empty-result page is the safe default.
  const KNOWN_CAPS = new Set(["llm", "memory", "lessons", "schedule", "events"]);
  const capabilityFilter = capability && KNOWN_CAPS.has(capability)
    ? (capability as "llm" | "memory" | "lessons" | "schedule" | "events")
    : undefined;
  const statusFilter = status === "denial" ? "denial" : undefined;
  const sinceDate = since ? new Date(since) : undefined;
  const untilDate = until ? new Date(until) : undefined;
  const limit = rawLimit ? parseInt(rawLimit, 10) : undefined;

  const { entries, nextCursor } = await mergeAuditForExtension(params.id, {
    capability: capabilityFilter,
    status: statusFilter,
    since: sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : undefined,
    until: untilDate && !Number.isNaN(untilDate.getTime()) ? untilDate : undefined,
    cursor,
    limit,
  });

  return json({ entries, nextCursor });
};
