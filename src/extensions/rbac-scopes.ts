/**
 * Extension-RBAC scope-name rules — the single PURE source of truth for
 * the core verbs, the scope-name grammar, and the manifest-declaration
 * validator (`permissions.rbacScopes`).
 *
 * Why this module exists (and lives here, not in `src/db/queries/`):
 * the grammar is shared by TWO consumers with very different import
 * budgets —
 *
 *   1. the STORAGE side (`src/db/queries/extension-rbac.ts` validates
 *      grant rows before writing), which re-exports these symbols so
 *      its public API is unchanged, and
 *   2. the MANIFEST side (`src/extensions/manifest.ts` validates
 *      `permissions.rbacScopes` declarations at admit time), which must
 *      stay pure — it is loaded by `scripts/regenerate-manifest-lock.ts`
 *      and dozens of validator test shards that must NOT transitively
 *      pull the Drizzle/PGlite connection chain.
 *
 * IMPORTANT: declarations are NOT privileges. `permissions.rbacScopes`
 * only NAMES per-extension scopes that (a) appear as grantable options
 * in the admin grant UI and (b) extension code may query via
 * `ctx.rbac.check(name)`. Holding a scope always requires an explicit
 * `extension_rbac_grants` row (or the admin role) — see
 * `src/auth/extension-rbac.ts` for the decision semantics.
 */

/** The five core verbs every extension supports. Custom scopes come from
 *  an extension's manifest (`permissions.rbacScopes`) and are implicitly
 *  namespaced per-extension; they must match {@link RBAC_SCOPE_NAME_RE}
 *  and must NOT collide with these verbs. */
export const CORE_RBAC_SCOPES = ["use", "configure", "secrets", "approve-runs", "manage"] as const;

export type CoreRbacScope = (typeof CORE_RBAC_SCOPES)[number];

/** Grammar for every storable scope name (the core verbs satisfy it too):
 *  lowercase alphanumeric + hyphen, starting with a letter. */
export const RBAC_SCOPE_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Hard cap on `permissions.rbacScopes` declarations per extension. The
 *  list feeds a grant-UI picker and the `ezcorp/rbac-check` allowlist —
 *  a bound keeps both surfaces reviewable and unspammable. */
export const MAX_RBAC_SCOPE_DECLARATIONS = 16;

/** One manifest-declared custom scope. Mirrors the SDK's
 *  `permissions.rbacScopes` entry shape (`@ezcorp/sdk` types.ts). */
export interface RbacScopeDeclaration {
  name: string;
  description: string;
}

/** True iff `name` is a storable scope name — a core verb or a
 *  grammar-valid custom scope. */
export function isValidRbacScopeName(name: string): boolean {
  return RBAC_SCOPE_NAME_RE.test(name);
}

/** True iff `name` is valid as an extension-DECLARED custom scope: it must
 *  satisfy the grammar AND must not collide with a core verb (a manifest
 *  declaring `use` would silently shadow the built-in semantics). */
export function isValidCustomRbacScopeName(name: string): boolean {
  return isValidRbacScopeName(name) && !(CORE_RBAC_SCOPES as readonly string[]).includes(name);
}

/**
 * Validate a manifest's `permissions.rbacScopes` declaration list.
 * Hand-rolled error-array style, matching `validateManifestV2`'s
 * component validators (NOT zod) — called from
 * `validatePermissionsBlock` in `src/extensions/manifest.ts`.
 *
 * Rules (reject-at-admit-time; declarations are inert so there is no
 * clamp-to-subset fallback — a bad declaration is an authoring bug):
 *   - must be an array of `{name, description}` objects
 *   - `name` matches {@link RBAC_SCOPE_NAME_RE}
 *   - `name` must not collide with a core verb ({@link CORE_RBAC_SCOPES})
 *   - `name` must be unique within the list
 *   - `description` is required (non-empty, non-blank string — it is
 *     the only text the grant UI can show an admin)
 *   - at most {@link MAX_RBAC_SCOPE_DECLARATIONS} entries
 */
export function validateRbacScopeDeclarations(
  value: unknown,
  errors: string[],
  path = "permissions.rbacScopes",
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array of {name, description} objects`);
    return;
  }
  if (value.length > MAX_RBAC_SCOPE_DECLARATIONS) {
    errors.push(
      `${path} declares ${value.length} scopes — max ${MAX_RBAC_SCOPE_DECLARATIONS}`,
    );
  }
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const entryPath = `${path}[${i}]`;
    const raw = value[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${entryPath} must be an object`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const name = entry.name;
    if (typeof name !== "string" || !RBAC_SCOPE_NAME_RE.test(name)) {
      errors.push(
        `${entryPath}.name must match ${RBAC_SCOPE_NAME_RE} (lowercase alphanumeric + hyphen, starting with a letter)`,
      );
    } else if ((CORE_RBAC_SCOPES as readonly string[]).includes(name)) {
      errors.push(
        `${entryPath}.name "${name}" collides with a core RBAC verb (${CORE_RBAC_SCOPES.join(", ")})`,
      );
    } else if (seen.has(name)) {
      errors.push(`${entryPath}.name "${name}" is declared more than once`);
    } else {
      seen.add(name);
    }
    if (typeof entry.description !== "string" || entry.description.trim().length === 0) {
      errors.push(`${entryPath}.description is required and must be a non-empty string`);
    }
  }
}
