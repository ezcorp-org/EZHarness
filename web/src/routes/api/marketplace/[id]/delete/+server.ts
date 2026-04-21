import { json } from "@sveltejs/kit";
import { requireRole } from "$server/auth/middleware";
import { deleteListing } from "$server/db/queries/marketplace";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  const admin = requireRole(locals, "admin");
  const deleted = await deleteListing(params.id);

  if (!deleted) {
    return json({ error: "Listing not found" }, { status: 404 });
  }

  await insertAuditEntry(admin.id, "marketplace:delete", params.id);

  return json({ ok: true });
};
