/**
 * GET / POST /api/rbac/extension-grants
 *
 * The extension-RBAC grants API (spec §Enforcement point 4). One grant row
 * = (user, project|ALL, extension|ALL) → scope list; the decision semantics
 * live in ONE place — `src/auth/extension-rbac.ts` — and this route only
 * calls them, never re-implements them.
 *
 * GET  → the rows the caller may SEE:
 *          - admin:   every grant,
 *          - manager: their own rows + any row whose (project, extension)
 *                     coordinates fall under a `manage` grant they hold
 *                     (visibility is coverage-based and deliberately wider
 *                     than mutation — a manager can see, but not touch, an
 *                     admin's rows or rows carrying `manage`),
 *          - member:  only their own rows (read-only — every mutation below
 *                     requires `manage` coverage they don't have).
 * POST → create a grant or replace an existing row's scope list. Gated by
 *        `canManageGrant` (admin, or a covering `manage` grant; `manage`
 *        itself and admins' grants stay admin-only). Writes an
 *        RBAC_GRANTED audit row on success.
 *
 * Body (POST): `{ userId: string, projectId?: string|null,
 *                 extensionId?: string|null, scopes: string[] }`
 *   - `projectId` / `extensionId` null/absent = the covers-all coordinate.
 *   - `extensionId` is the manifest SLUG (`extensions.name` — the FK the
 *     grants table references), not the extensions-table UUID.
 *
 * SECURITY:
 *   - `requireAuth` (401) then the RBAC delegation check IS the runtime
 *     gate. There is deliberately NO admin-scope `requireScope` gate here:
 *     that helper is cookie-transparent and would need a role-gate pairing
 *     (route-contract admin-gate scan) which would lock out the managers
 *     and members this route intentionally serves. The api-registry entry
 *     documents the surface as scope "admin" for the docs/OpenAPI tier.
 *   - Delegation (403) is checked BEFORE entity-existence (404) so a
 *     non-privileged caller can't use this route as an existence oracle
 *     for users / projects / extensions.
 *   - Responses use the public view (`toPublicGrantView`) — explicit field
 *     copies, so `passwordHash` (or any other user column) can never leak.
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import {
  canManageGrant,
  resolveEffectiveScopes,
  validateRbacScopes,
  InvalidRbacScopeError,
} from "$server/auth/extension-rbac";
import { listGrants, getGrant, upsertGrant } from "$server/db/queries/extension-rbac";
import { getUserById } from "$server/db/queries/users";
import { getProject } from "$server/db/queries/projects";
import { getExtensionByName } from "$server/db/queries/extensions";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "$server/extensions/audit-actions";
import { toPublicGrantView } from "$lib/rbac-grants-logic";
import type { AuthUser } from "$server/auth/types";

/** App.Locals slice this route reads. */
type RbacRouteLocals = { user?: AuthUser };

interface GrantBody {
  userId?: unknown;
  projectId?: unknown;
  extensionId?: unknown;
  scopes?: unknown;
}

/** 401-or-user gate. Mirrors the secrets route's `authSecretsRoute` shape
 *  (requireAuth throws a Response — surface it as an early return). */
function authRbacRoute(locals: RbacRouteLocals): { user: AuthUser } | { error: Response } {
  try {
    return { user: requireAuth(locals) };
  } catch (resp) {
    return { error: resp as Response };
  }
}

/** Parse an optional grant coordinate: absent/null → null (covers-all);
 *  a supplied value must be a non-empty string. */
function parseNullableId(value: unknown, field: string): { id: string | null } | { error: Response } {
  if (value === undefined || value === null) return { id: null };
  if (typeof value !== "string" || value.length === 0) {
    return { error: errorJson(400, `${field} must be a non-empty string or null`) };
  }
  return { id: value };
}

/** The single 403 body for every delegation denial — one clear reason, no
 *  per-branch detail that would leak which sub-rule failed. */
function delegationDenied(): Response {
  return errorJson(
    403,
    "Not allowed to manage this grant: requires admin, or a `manage` grant covering the target project and extension (`manage` itself and admins' grants are admin-only)",
  );
}

/** Join the grantee users onto a set of rows, memoizing per userId. */
async function toViews(rows: Awaited<ReturnType<typeof listGrants>>) {
  const usersById = new Map<string, { id: string; email: string; name: string } | null>();
  const views = [];
  for (const grant of rows) {
    if (!usersById.has(grant.userId)) {
      usersById.set(grant.userId, (await getUserById(grant.userId)) ?? null);
    }
    views.push(toPublicGrantView(grant, usersById.get(grant.userId)));
  }
  return views;
}

export const GET: RequestHandler = async ({ locals }) => {
  const auth = authRbacRoute(locals);
  if ("error" in auth) return auth.error;
  const { user } = auth;

  const all = await listGrants();
  const visible: typeof all = [];
  for (const grant of all) {
    if (user.role === "admin" || grant.userId === user.id) {
      visible.push(grant);
      continue;
    }
    // Manager visibility: coverage-based — the row's own coordinates run
    // through the ONE resolver, so NULL-covers-all matches exactly the
    // semantics `canManageGrant` uses for mutations.
    const scopes = await resolveEffectiveScopes(user, grant.projectId, grant.extensionId);
    if (scopes.has("manage")) visible.push(grant);
  }

  return json({ grants: await toViews(visible) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  const auth = authRbacRoute(locals);
  if ("error" in auth) return auth.error;
  const { user } = auth;

  const body = (await request.json().catch(() => null)) as GrantBody | null;
  if (!body || typeof body !== "object") return errorJson(400, "Invalid body");

  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!userId) return errorJson(400, "userId is required");

  const projectRes = parseNullableId(body.projectId, "projectId");
  if ("error" in projectRes) return projectRes.error;
  const extensionRes = parseNullableId(body.extensionId, "extensionId");
  if ("error" in extensionRes) return extensionRes.error;
  const projectId = projectRes.id;
  const extensionId = extensionRes.id;

  if (!Array.isArray(body.scopes)) return errorJson(400, "scopes must be an array");
  let scopes: string[];
  try {
    scopes = validateRbacScopes(body.scopes);
  } catch (err) {
    if (err instanceof InvalidRbacScopeError) return errorJson(400, err.message);
    throw err;
  }

  // Delegation target = the union of the scopes being written and any
  // existing row's scopes: replacing a row is also an implicit revoke of
  // the scopes it loses, so e.g. a manager can never strip `manage` off a
  // row by overwriting it (canManageGrant refuses any target carrying it).
  const existing = await getGrant(userId, projectId, extensionId);
  const touchedScopes = existing ? Array.from(new Set([...scopes, ...existing.scopes])) : scopes;
  const allowed = await canManageGrant(user, { userId, projectId, extensionId, scopes: touchedScopes });
  if (!allowed) return delegationDenied();

  // FK pre-flight (admin/manager-only reachable — delegation ran first):
  // a clean 404 instead of a 500 from the DB's FK constraint.
  const grantee = await getUserById(userId);
  if (!grantee) return errorJson(404, "User not found");
  if (projectId !== null && !(await getProject(projectId))) {
    return errorJson(404, "Project not found");
  }
  if (extensionId !== null && !(await getExtensionByName(extensionId))) {
    return errorJson(404, "Extension not found");
  }

  const row = await upsertGrant({ userId, projectId, extensionId, scopes, grantedByUserId: user.id });

  // Scope NAMES only — never secret material (RBAC_GRANTED contract).
  await insertAuditEntry(user.id, EXT_AUDIT_ACTIONS.RBAC_GRANTED, extensionId ?? undefined, {
    actor: user.id,
    targetUserId: userId,
    projectId,
    extensionId,
    scopes,
  });

  return json(toPublicGrantView(row, grantee));
};
