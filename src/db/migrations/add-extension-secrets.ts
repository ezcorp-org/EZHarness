/**
 * Extension secrets migration.
 *
 * Adds the dedicated, scope-isolated, AEAD-bound credential store that
 * extensions use for third-party API tokens (replacing the bespoke
 * `settings`-table blobs the github-projects extension used). Each row's
 * `ciphertext` is AES-256-GCM with the `extensionId:projectId` scope bound
 * as Additional Authenticated Data (see `encryptWithAad` in
 * src/providers/encryption.ts), so a ciphertext copied into a different scope
 * fails to decrypt. Plaintext is reachable ONLY via the host-side store
 * (src/extensions/secrets-store.ts `getSecret`) — it is NEVER wired to the
 * extension sandbox.
 *
 * Schema deltas (idempotent, additive — no destructive changes):
 *   - extension_secrets (id, extension_id FK extensions(name) CASCADE,
 *     project_id FK projects(id) CASCADE, user_id FK users(id) CASCADE,
 *     name, ciphertext, created_at, last_used_at, rotated_at).
 *     `extension_id` stores the stable manifest SLUG (e.g. 'github-projects'),
 *     NOT the UUID `extensions.id`.
 *   - UNIQUE INDEX on (extension_id, COALESCE(project_id,''),
 *     COALESCE(user_id,''), name) — the COALESCE form is required because a
 *     plain UNIQUE over nullable columns treats every NULL as distinct, which
 *     would allow duplicate global / project-scoped secrets. Queries
 *     therefore use select-then-write, NOT ON CONFLICT against a partial
 *     target (see src/db/queries/extension-secrets.ts).
 *
 * Security invariants (enforced at the host/query layer, NOT the DB):
 *   - `getSecret()` returns plaintext and is host-only; it must never be
 *     exposed to the extension sandbox.
 *   - The AAD is NOT stored; it is reconstructed from the row's scope at
 *     decrypt time. A wrong AAD fails the GCM auth tag.
 *
 * This migration is applied automatically via src/db/migrate.ts. This file
 * exists for documentation and parallels add-github-projects.ts.
 */
import { sql } from "drizzle-orm";

export async function up(db: any): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS extension_secrets (
      id TEXT PRIMARY KEY,
      extension_id TEXT NOT NULL REFERENCES extensions(name) ON DELETE CASCADE,
      project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,
      user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      ciphertext   TEXT NOT NULL,
      created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMP WITH TIME ZONE,
      rotated_at   TIMESTAMP WITH TIME ZONE
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_secrets_scope ON extension_secrets (extension_id, COALESCE(project_id,''), COALESCE(user_id,''), name)`,
  );
}
