import { json } from "@sveltejs/kit";
import { getExecutor } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const executor = getExecutor();
  const projectId = url.searchParams.get("projectId") ?? undefined;
  // Per-user run ownership: non-admins see only their own runs. Admins see all.
  // Without this scope an attacker could enumerate every tenant's run ids,
  // metadata, and input JSON (cross-tenant IDOR on the list endpoint).
  const ownerScope = user.role === "admin" ? undefined : user.id;
  return json(await executor.listRuns(projectId, ownerScope));
};
