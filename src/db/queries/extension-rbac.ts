import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../connection";
import { extensionRbacGrants } from "../schema";
import type { ExtensionRbacGrant } from "../schema";

/**
 * Raw CRUD over the `extension_rbac_grants` table. NO authorization lives
 * here — who may call these mutations is decided one level up by
 * `canManageGrant` in `src/auth/extension-rbac.ts`, and the effective-scope
 * semantics (admin bypass, NULL-covers-all matching, deny-by-default) live
 * in the same resolver module. This module only knows how to address a
 * single grant row by its (user, project, extension) tuple and read/write
 * the validated scope list.
 *
 * The COALESCE-unique scope index (see add-extension-rbac.ts) means a
 * plain Drizzle `.onConflictDoUpdate()` against the nullable scope columns
 * would NOT match the index — so `upsertGrant` is select-then-write,
 * mirroring `insertOrReplaceSecret` in queries/extension-secrets.ts.
 */

// Scope-name rules (core verbs, grammar, declaration validation) live in
// the PURE module `src/extensions/rbac-scopes.ts` — one source of truth
// shared with the manifest validator, which must not pull this module's
// Drizzle/connection chain. Re-exported here so the storage-side public
// API is unchanged (src/auth/extension-rbac.ts re-exports from HERE).
import {
  CORE_RBAC_SCOPES,
  RBAC_SCOPE_NAME_RE,
  isValidRbacScopeName,
} from "../../extensions/rbac-scopes";

export {
  CORE_RBAC_SCOPES,
  RBAC_SCOPE_NAME_RE,
  isValidRbacScopeName,
} from "../../extensions/rbac-scopes";
export { isValidCustomRbacScopeName } from "../../extensions/rbac-scopes";
export type { CoreRbacScope } from "../../extensions/rbac-scopes";

/** Thrown by {@link upsertGrant} when the scope list fails validation.
 *  Callers (the grants API, later wave) map this to a 400. */
export class InvalidRbacScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRbacScopeError";
  }
}

/** Validates + normalizes a scope list for storage: must be a non-empty
 *  array of grammar-valid names (an empty grant means "no access" — that
 *  state is `deleteGrant`, not an empty row). Returns the de-duplicated
 *  list; throws {@link InvalidRbacScopeError} otherwise. */
export function validateRbacScopes(scopes: string[]): string[] {
  if (scopes.length === 0) {
    throw new InvalidRbacScopeError("scopes must be a non-empty array (revoke by deleting the grant)");
  }
  for (const scope of scopes) {
    if (typeof scope !== "string" || !isValidRbacScopeName(scope)) {
      throw new InvalidRbacScopeError(
        `invalid scope name ${JSON.stringify(scope)} — expected a core verb (${CORE_RBAC_SCOPES.join(", ")}) or a custom name matching ${RBAC_SCOPE_NAME_RE}`,
      );
    }
  }
  return Array.from(new Set(scopes));
}

/** Fully-qualified address of one grant row. `projectId` / `extensionId`
 *  are `null` for all-projects / all-extensions grants (NOT `undefined`). */
export type RbacGrantAddress = {
  userId: string;
  projectId: string | null;
  extensionId: string | null;
};

export type RbacGrantInput = RbacGrantAddress & {
  scopes: string[];
  grantedByUserId: string | null;
};

/** Builds the exact-match WHERE for an address tuple. A `null`
 *  project/extension maps to `IS NULL` (not `= NULL`), so it addresses the
 *  same row the COALESCE-unique index pins. */
function addressWhere(address: RbacGrantAddress) {
  return and(
    eq(extensionRbacGrants.userId, address.userId),
    address.projectId === null
      ? isNull(extensionRbacGrants.projectId)
      : eq(extensionRbacGrants.projectId, address.projectId),
    address.extensionId === null
      ? isNull(extensionRbacGrants.extensionId)
      : eq(extensionRbacGrants.extensionId, address.extensionId),
  );
}

export async function getGrant(
  userId: string,
  projectId: string | null,
  extensionId: string | null,
): Promise<ExtensionRbacGrant | undefined> {
  const rows = await getDb()
    .select()
    .from(extensionRbacGrants)
    .where(addressWhere({ userId, projectId, extensionId }));
  return rows[0];
}

/** Lists grant rows, optionally filtered. `undefined` = no filter on that
 *  column; `null` = only the NULL (all-projects / all-extensions) rows. */
export async function listGrants(
  filter: { userId?: string; projectId?: string | null; extensionId?: string | null } = {},
): Promise<ExtensionRbacGrant[]> {
  const conditions = [];
  if (filter.userId !== undefined) {
    conditions.push(eq(extensionRbacGrants.userId, filter.userId));
  }
  if (filter.projectId !== undefined) {
    conditions.push(
      filter.projectId === null
        ? isNull(extensionRbacGrants.projectId)
        : eq(extensionRbacGrants.projectId, filter.projectId),
    );
  }
  if (filter.extensionId !== undefined) {
    conditions.push(
      filter.extensionId === null
        ? isNull(extensionRbacGrants.extensionId)
        : eq(extensionRbacGrants.extensionId, filter.extensionId),
    );
  }
  const query = getDb().select().from(extensionRbacGrants);
  if (conditions.length === 0) return query;
  return query.where(conditions.length === 1 ? conditions[0]! : and(...conditions));
}

/** Every grant row for one user — the resolver's single DB hit. */
export async function listGrantsForUser(userId: string): Promise<ExtensionRbacGrant[]> {
  return listGrants({ userId });
}

/** Replace-write: swap the row's scope list, re-attribute the grantor and
 *  stamp `updatedAt`. */
async function replaceScopes(
  id: string,
  scopes: string[],
  grantedByUserId: string | null,
): Promise<ExtensionRbacGrant> {
  const rows = await getDb()
    .update(extensionRbacGrants)
    .set({ scopes, grantedByUserId, updatedAt: new Date() })
    .where(eq(extensionRbacGrants.id, id))
    .returning();
  return rows[0]!;
}

/** Inserts a new grant, or replaces an existing row's scope list (stamping
 *  `updatedAt`). Scope names are validated (and de-duplicated) before any
 *  write. Select-then-write because the COALESCE-unique index can't be an
 *  onConflict target. Two concurrent first-writes can both pass the select
 *  and race the INSERT — the loser hits the COALESCE-unique index, so on an
 *  insert failure we retry ONCE: re-select the winner's row and convert this
 *  write into the replace update. Any other insert error re-selects nothing
 *  and rethrows unchanged. */
export async function upsertGrant(input: RbacGrantInput): Promise<ExtensionRbacGrant> {
  const scopes = validateRbacScopes(input.scopes);
  const address: RbacGrantAddress = {
    userId: input.userId,
    projectId: input.projectId,
    extensionId: input.extensionId,
  };
  const existing = await getGrant(address.userId, address.projectId, address.extensionId);
  if (existing) {
    return replaceScopes(existing.id, scopes, input.grantedByUserId);
  }
  try {
    const rows = await getDb()
      .insert(extensionRbacGrants)
      .values({
        userId: input.userId,
        projectId: input.projectId,
        extensionId: input.extensionId,
        scopes,
        grantedByUserId: input.grantedByUserId,
      })
      .returning();
    return rows[0]!;
  } catch (err) {
    const winner = await getGrant(address.userId, address.projectId, address.extensionId);
    if (!winner) throw err; // not the unique-violation race — surface it
    return replaceScopes(winner.id, scopes, input.grantedByUserId);
  }
}

export async function deleteGrant(id: string): Promise<boolean> {
  const rows = await getDb()
    .delete(extensionRbacGrants)
    .where(eq(extensionRbacGrants.id, id))
    .returning({ id: extensionRbacGrants.id });
  return rows.length > 0;
}
