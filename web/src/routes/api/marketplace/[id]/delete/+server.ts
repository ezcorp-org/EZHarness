import { json } from "@sveltejs/kit";
import { checkRole } from "$server/auth/middleware";
import { deleteListing } from "$server/db/queries/marketplace";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  // checkRole RETURNS the 401/403 Response so non-admin callers see the
  // intended status (a thrown Response would 500 via SvelteKit).
  const admin = checkRole(locals, "admin");
  if (admin instanceof Response) return admin;
  const deleted = await deleteListing(params.id);

  if (!deleted) {
    return errorJson(404, "Listing not found");
  }

  await insertAuditEntry(admin.id, "marketplace:delete", params.id);

  return json({ ok: true });
};
