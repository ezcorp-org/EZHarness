import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireAuth, requireRole } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { listAuditForExtension } from "$server/db/queries/audit-log";
import { getExtension } from "$server/db/queries/extensions";
import { errorJson } from "$lib/server/http-errors";

/**
 * GET /api/extensions/[id]/audit
 *
 * Returns the permission-change audit trail for a single extension.
 * Admin-only — the rows include `actor` identifiers and reveal the
 * history of permission grants (a security-sensitive view).
 *
 * The underlying `listAuditForExtension` matches both the typed `ext:*`
 * actions (EXT_AUDIT_ACTIONS) and the legacy `extension:*` strings so
 * callers see a unified history without a data migration.
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  requireRole(locals, "admin");

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10), 500);
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10), 0);

  const entries = await listAuditForExtension(params.id, { limit, offset });
  return json({ entries });
};
