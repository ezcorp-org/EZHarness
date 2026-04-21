import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { listAuditLog } from "$server/db/queries/audit-log";
import { requireScope } from "$lib/server/security/api-keys";

export const GET: RequestHandler = async ({ locals }) => {
  try {
    const scopeErr = requireScope(locals, "read");
    if (scopeErr) return scopeErr;
    const user = requireAuth(locals);
    const entries = await listAuditLog({
      action: "auth:login",
      userId: user.id,
      limit: 10,
    });
    return json({ entries });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
