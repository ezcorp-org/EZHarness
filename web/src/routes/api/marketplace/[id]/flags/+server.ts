import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireRole } from "$server/auth/middleware";
import { getFlagHistory, resolveFlag } from "$server/db/queries/marketplace-ratings";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

// Boundary validation. PATCH resolves a pending flag — `flagId` is a
// required non-empty string, `action` is a literal union. Both
// failures collapse to the same 400 message the existing test
// asserts on, so the contract is preserved verbatim.
const flagsPatchSchema = z.object({
  flagId: z.string().min(1),
  action: z.enum(["dismissed", "removed"]),
}).passthrough();

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
  const parsed = flagsPatchSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "flagId and action ('dismissed' | 'removed') are required");
  }
  const { flagId, action } = parsed.data;

  await resolveFlag(flagId, admin.id, action);
  await insertAuditEntry(admin.id, `marketplace:flag:${action}`, params.id, { flagId });

  return json({ ok: true });
};
