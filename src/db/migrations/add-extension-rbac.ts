/**
 * Extension RBAC grants migration.
 *
 * Adds the per-user, per-(project, extension) scope-grant table backing the
 * extension RBAC layer: what a USER may do WITH an extension (invoke it,
 * configure it, write its secrets, approve its runs, manage other users'
 * grants — plus extension-declared custom scopes). Complementary to the PDP
 * (src/extensions/permission-engine.ts), which governs what the EXTENSION
 * may do — do not conflate the two axes.
 *
 * Decision semantics (2026-07-03 user decision — see
 * src/auth/extension-rbac.ts): admins implicitly hold every scope and need
 * no rows here; non-admin members are deny-by-default. NULL `project_id`
 * means the grant covers ALL projects; NULL `extension_id` means ALL
 * extensions. `extension_id` stores the stable manifest SLUG (e.g.
 * 'github-projects', FK to extensions.name), NOT the UUID `extensions.id`
 * — the extension_secrets precedent.
 *
 * Schema deltas (idempotent, additive — no destructive changes):
 *   - extension_rbac_grants (id, user_id FK users(id) CASCADE,
 *     project_id FK projects(id) CASCADE, extension_id FK extensions(name)
 *     CASCADE, scopes JSONB NOT NULL, granted_by_user_id FK users(id)
 *     SET NULL, created_at, updated_at). Deleting the grantee / project /
 *     extension cascades the grant away; deleting the GRANTOR only
 *     un-attributes it.
 *   - UNIQUE INDEX on (user_id, COALESCE(project_id,''),
 *     COALESCE(extension_id,'')) — the COALESCE form is required because a
 *     plain UNIQUE over nullable columns treats every NULL as distinct,
 *     which would allow duplicate all-projects / all-extensions grant rows
 *     for the same user. Queries therefore use select-then-write with a
 *     retry-once race fallback, NOT ON CONFLICT against a partial target
 *     (see src/db/queries/extension-rbac.ts).
 *
 * Security invariants (enforced at the resolver/query layer, NOT the DB):
 *   - Scope names are validated before write (core verbs or
 *     `[a-z][a-z0-9-]*` custom names — src/db/queries/extension-rbac.ts).
 *   - Delegation (who may create/edit/revoke rows) is decided ONLY by
 *     `canManageGrant` in src/auth/extension-rbac.ts — managers can never
 *     grant/revoke `manage`, exceed their coverage, or touch admins' rows.
 *
 * This migration is applied automatically via src/db/migrate.ts. This file
 * exists for documentation and parallels add-extension-secrets.ts.
 */
import { sql } from "drizzle-orm";

export async function up(db: any): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS extension_rbac_grants (
      id TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,
      extension_id TEXT REFERENCES extensions(name) ON DELETE CASCADE,
      scopes JSONB NOT NULL,
      granted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_rbac_grants_scope ON extension_rbac_grants (user_id, COALESCE(project_id,''), COALESCE(extension_id,''))`,
  );
}
