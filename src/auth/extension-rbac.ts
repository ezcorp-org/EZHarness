/**
 * Extension RBAC — the SINGLE decision point for "may this user do X with
 * this extension?". Governs the USER→extension axis (use / configure /
 * secrets / approve-runs / manage + extension-declared custom scopes);
 * complementary to the PDP in src/extensions/permission-engine.ts, which
 * governs what the EXTENSION may do. Do not conflate the two.
 *
 * Deny-by-default (2026-07-03 user decision): non-admin members hold NO
 * extension scopes until an explicit `extension_rbac_grants` row says
 * otherwise, and admins implicitly hold EVERY scope. Rationale: the
 * instance has no users yet and solo installs are admin-only, so the
 * long-term-clean posture costs nothing today — there is deliberately no
 * legacy permissive mode to migrate off later.
 *
 * Grant matching is NULL-covers-all on both axes: a grant row with
 * `projectId === null` applies to every project, `extensionId === null` to
 * every extension. A query with a `null` coordinate (e.g. a global,
 * project-less surface) is therefore only satisfied by rows that are
 * themselves NULL on that axis — a narrower grant never covers a broader
 * context.
 */
import { listGrantsForUser } from "../db/queries/extension-rbac";
import { getUserById } from "../db/queries/users";

export {
  CORE_RBAC_SCOPES,
  RBAC_SCOPE_NAME_RE,
  InvalidRbacScopeError,
  isValidRbacScopeName,
  isValidCustomRbacScopeName,
  validateRbacScopes,
} from "../db/queries/extension-rbac";
export type { CoreRbacScope, RbacGrantAddress, RbacGrantInput } from "../db/queries/extension-rbac";

/** The minimal principal shape every check needs — structurally satisfied
 *  by `AuthUser` (src/auth/types.ts) and by a full `users` row. */
export type RbacUser = { id: string; role: "admin" | "member" };

/** The (project, extension) coordinates + scope of one check. `null` means
 *  the calling surface has no project / extension context — NOT "any". */
export type ExtensionScopeQuery = {
  projectId: string | null;
  extensionId: string | null;
  scope: string;
};

/** A grant row (existing or about-to-be-written) as seen by the delegation
 *  check. `userId` is the GRANTEE; `scopes` is the full scope list the
 *  mutation touches (for a revoke: the row's current scopes). */
export type RbacGrantTarget = {
  userId: string;
  projectId: string | null;
  extensionId: string | null;
  scopes: string[];
};

/** Admin sentinel: a `Set` whose `has()` is always true, so admin callers
 *  flow through the same `scopes.has(x)` code path as everyone else with
 *  zero DB hits. Identity-comparable via {@link RBAC_ALL_SCOPES}. Only
 *  `has()` is meaningful — the sentinel enumerates as empty (custom scopes
 *  are open-ended, so "all" is not a listable set). */
class AllScopesSet extends Set<string> {
  override has(_scope: string): boolean {
    return true;
  }
}

/** The singleton every admin resolution returns. */
export const RBAC_ALL_SCOPES: ReadonlySet<string> = new AllScopesSet();

/** True when a grant row covers the queried (project, extension) pair —
 *  NULL on a grant axis covers everything on that axis. */
function grantCovers(
  grant: { projectId: string | null; extensionId: string | null },
  projectId: string | null,
  extensionId: string | null,
): boolean {
  return (
    (grant.projectId === null || grant.projectId === projectId) &&
    (grant.extensionId === null || grant.extensionId === extensionId)
  );
}

/**
 * Resolves the user's effective scope set at (projectId, extensionId).
 *
 * - `role === 'admin'` → {@link RBAC_ALL_SCOPES} (every scope, no DB hit).
 * - else → the union of `scopes` across the user's grant rows whose
 *   (project, extension) covers the query (NULL-covers-all).
 * - no matching grants → empty set (deny-by-default).
 */
export async function resolveEffectiveScopes(
  user: RbacUser,
  projectId: string | null,
  extensionId: string | null,
): Promise<ReadonlySet<string>> {
  if (user.role === "admin") return RBAC_ALL_SCOPES;
  const effective = new Set<string>();
  for (const grant of await listGrantsForUser(user.id)) {
    if (!grantCovers(grant, projectId, extensionId)) continue;
    for (const scope of grant.scopes) effective.add(scope);
  }
  return effective;
}

/** One-scope convenience over {@link resolveEffectiveScopes}: true for
 *  admins without a DB hit (the sentinel path), else true iff the resolved
 *  union contains `scope`. Scope names are case-sensitive. */
export async function hasExtensionScope(user: RbacUser, query: ExtensionScopeQuery): Promise<boolean> {
  const scopes = await resolveEffectiveScopes(user, query.projectId, query.extensionId);
  return scopes.has(query.scope);
}

/**
 * Delegation rule — may `actor` create / edit / revoke `target`?
 *
 * - Admins: always.
 * - Otherwise the actor must hold `manage` at the target's exact
 *   (project, extension) coordinates (same NULL-covers-all matching as the
 *   resolver — so a project-scoped manager can never touch a NULL-project
 *   grant, and an extension-scoped manager never another extension's), AND
 *   - the target may NEVER contain `manage` (granting OR revoking it is
 *     admin-only — prevents self-propagating escalation), AND
 *   - the target's grantee may not be an admin user (fail-closed: an
 *     unknown grantee also denies).
 */
export async function canManageGrant(actor: RbacUser, target: RbacGrantTarget): Promise<boolean> {
  if (actor.role === "admin") return true;
  // Managers never grant/revoke `manage` — nor touch a row carrying it.
  if (target.scopes.includes("manage")) return false;
  // Coverage: `manage` resolved at the target's own coordinates. A broader
  // target (NULL where the actor's grant is specific) simply doesn't match.
  const actorScopes = await resolveEffectiveScopes(actor, target.projectId, target.extensionId);
  if (!actorScopes.has("manage")) return false;
  // Managers cannot touch grants belonging to admin users.
  const grantee = await getUserById(target.userId);
  if (!grantee || grantee.role === "admin") return false;
  return true;
}
