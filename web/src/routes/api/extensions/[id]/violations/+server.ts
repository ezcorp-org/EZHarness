import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { getSecurityViolations, clearSecurityViolations } from "$server/extensions/security";

// GET: List security violations for an extension
export const GET = async ({ params, locals }: { params: { id: string }; locals: App.Locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  if (locals.user?.role !== "admin") {
    return errorJson(403, "Admin access required");
  }
  const violations = await getSecurityViolations(params.id);
  return json({ violations });
};

// DELETE: Clear security violations (admin only, allows re-enabling)
export const DELETE = async ({ params, locals }: { params: { id: string }; locals: App.Locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  if (locals.user?.role !== "admin") {
    return errorJson(403, "Admin access required");
  }
  await clearSecurityViolations(params.id);
  return json({ cleared: true });
};
