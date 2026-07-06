/**
 * DELETE /api/rbac/extension-grants/:id — revoke one extension-RBAC grant.
 *
 * Same delegation gate as create (`canManageGrant`, called with the row's
 * CURRENT scopes — a revoke "touches" exactly what the row carries, so a
 * manager can never revoke a `manage` row or an admin's row). Writes an
 * RBAC_REVOKED audit row carrying the PRE-delete scope list (forensic
 * trail contract in src/extensions/audit-actions.ts).
 *
 * SECURITY: `requireAuth` + the delegation check IS the runtime gate — see
 * the collection route (`../+server.ts`) header for why there is no
 * admin-scope `requireScope` gate here. A missing row is 404; an existing
 * row the caller may not manage is 403 (grant ids are UUIDv4 — the
 * existence signal is not an enumeration risk, and the clear reason is the
 * repo norm for delegation denials on this surface).
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { canManageGrant } from "$server/auth/extension-rbac";
import { listGrants, deleteGrant } from "$server/db/queries/extension-rbac";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "$server/extensions/audit-actions";
import type { AuthUser } from "$server/auth/types";

/** App.Locals slice this route reads. */
type RbacRouteLocals = { user?: AuthUser };

/** 401-or-user gate (mirrors the collection route — SvelteKit forbids
 *  non-handler exports from +server.ts, so the 6 lines are duplicated). */
function authRbacRoute(locals: RbacRouteLocals): { user: AuthUser } | { error: Response } {
  try {
    return { user: requireAuth(locals) };
  } catch (resp) {
    return { error: resp as Response };
  }
}

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const auth = authRbacRoute(locals);
  if ("error" in auth) return auth.error;
  const { user } = auth;

  // The landed query module addresses rows by (user, project, extension)
  // tuple only — no by-id getter. Resolve via the full list: the grants
  // table is tiny (one row per user × project × extension actually
  // granted), and adding a core query helper mid-parallel-wave isn't worth
  // the contention. Swap to a `getGrantById` if/when core grows one.
  const grant = (await listGrants()).find((g) => g.id === params.id);
  if (!grant) return errorJson(404, "Grant not found");

  const allowed = await canManageGrant(user, {
    userId: grant.userId,
    projectId: grant.projectId,
    extensionId: grant.extensionId,
    scopes: grant.scopes,
  });
  if (!allowed) {
    return errorJson(
      403,
      "Not allowed to manage this grant: requires admin, or a `manage` grant covering the target project and extension (`manage` itself and admins' grants are admin-only)",
    );
  }

  const deleted = await deleteGrant(grant.id);
  if (deleted) {
    // `scopes` = the PRE-delete list (RBAC_REVOKED forensic contract);
    // skipped when a concurrent revoke won the race (nothing was removed).
    await insertAuditEntry(user.id, EXT_AUDIT_ACTIONS.RBAC_REVOKED, grant.extensionId ?? undefined, {
      actor: user.id,
      targetUserId: grant.userId,
      projectId: grant.projectId,
      extensionId: grant.extensionId,
      scopes: grant.scopes,
    });
  }
  return json({ deleted });
};
