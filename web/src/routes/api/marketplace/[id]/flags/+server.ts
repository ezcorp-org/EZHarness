import { json } from "@sveltejs/kit";
import { requireRole } from "$server/auth/middleware";
import { getFlagHistory, resolveFlag } from "$server/db/queries/marketplace-ratings";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  requireRole(locals, "admin");
  const flags = await getFlagHistory(params.id);
  return json({ flags });
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  const admin = requireRole(locals, "admin");
  const body = await request.json();
  const { flagId, action } = body as { flagId: string; action: "dismissed" | "removed" };

  if (!flagId || !["dismissed", "removed"].includes(action)) {
    return json({ error: "flagId and action ('dismissed' | 'removed') are required" }, { status: 400 });
  }

  await resolveFlag(flagId, admin.id, action);
  await insertAuditEntry(admin.id, `marketplace:flag:${action}`, params.id, { flagId });

  return json({ ok: true });
};
