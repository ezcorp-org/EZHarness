import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireRole } from "$server/auth/middleware";
import { listAuditLog } from "$server/db/queries/audit-log";
import { requireScope } from "$lib/server/security/api-keys";

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  try {
    requireRole(locals, "admin");

    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const action = url.searchParams.get("action") ?? undefined;

    const entries = await listAuditLog({
      limit: Math.min(limit, 500),
      offset: Math.max(offset, 0),
      action,
    });

    return json({ entries });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
