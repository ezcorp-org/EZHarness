import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../connection";
import { extensionSecrets } from "../schema";
import type { ExtensionSecret } from "../schema";

/**
 * Raw CRUD over the `extension_secrets` table. NO crypto lives here — the
 * `ciphertext` column is opaque to this layer; encryption / decryption /
 * audit / debounce all live one level up in
 * `src/extensions/secrets-store.ts`. This module only knows how to address a
 * single secret by its scope and read/write the opaque ciphertext.
 *
 * The COALESCE-unique scope index (see add-extension-secrets.ts) means a
 * plain Drizzle `.onConflictDoUpdate()` against the nullable scope columns
 * would NOT match the index — so `insertOrReplaceSecret` is select-then-write,
 * mirroring `getSetting`/`upsertSetting` in queries/settings.ts.
 */

/** Fully-qualified address of one secret row. `projectId` / `userId` are
 *  `null` for global / non-user-scoped secrets (NOT `undefined`). */
export type SecretScope = {
  extensionId: string;
  projectId: string | null;
  userId: string | null;
  name: string;
};

/** Metadata-only projection — NEVER includes the ciphertext. */
export type SecretMeta = {
  name: string;
  projectId: string | null;
  userId: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  rotatedAt: Date | null;
};

/** Builds the exact-match WHERE for a scope tuple. A `null` project/user maps
 *  to `IS NULL` (not `= NULL`), so it addresses the same row the
 *  COALESCE-unique index pins. */
function scopeWhere(scope: SecretScope) {
  return and(
    eq(extensionSecrets.extensionId, scope.extensionId),
    scope.projectId === null
      ? isNull(extensionSecrets.projectId)
      : eq(extensionSecrets.projectId, scope.projectId),
    scope.userId === null
      ? isNull(extensionSecrets.userId)
      : eq(extensionSecrets.userId, scope.userId),
    eq(extensionSecrets.name, scope.name),
  );
}

export async function getSecretRow(scope: SecretScope): Promise<ExtensionSecret | undefined> {
  const rows = await getDb().select().from(extensionSecrets).where(scopeWhere(scope));
  return rows[0];
}

/** Rotation write: replace the row's ciphertext and stamp `rotatedAt`. */
async function replaceCiphertext(id: string, ciphertext: string): Promise<void> {
  await getDb()
    .update(extensionSecrets)
    .set({ ciphertext, rotatedAt: new Date() })
    .where(eq(extensionSecrets.id, id));
}

/** Inserts a new secret, or replaces an existing one's ciphertext (stamping
 *  `rotatedAt`). Select-then-write because the COALESCE-unique index can't be
 *  an onConflict target. Two concurrent first-writes can both pass the select
 *  and race the INSERT — the loser hits the COALESCE-unique index, so on an
 *  insert failure we retry ONCE: re-select the winner's row and convert this
 *  write into the rotation update. Any other insert error re-selects nothing
 *  and rethrows unchanged. */
export async function insertOrReplaceSecret(scope: SecretScope, ciphertext: string): Promise<void> {
  const existing = await getSecretRow(scope);
  if (existing) {
    await replaceCiphertext(existing.id, ciphertext);
    return;
  }
  try {
    await getDb().insert(extensionSecrets).values({
      extensionId: scope.extensionId,
      projectId: scope.projectId,
      userId: scope.userId,
      name: scope.name,
      ciphertext,
    });
  } catch (err) {
    const winner = await getSecretRow(scope);
    if (!winner) throw err; // not the unique-violation race — surface it
    await replaceCiphertext(winner.id, ciphertext);
  }
}

export async function deleteSecret(scope: SecretScope): Promise<boolean> {
  const existing = await getSecretRow(scope);
  if (!existing) return false;
  await getDb().delete(extensionSecrets).where(eq(extensionSecrets.id, existing.id));
  return true;
}

/** Stamps `lastUsedAt = now` for the addressed secret. No-op if missing. */
export async function touchLastUsed(scope: SecretScope): Promise<void> {
  await getDb()
    .update(extensionSecrets)
    .set({ lastUsedAt: new Date() })
    .where(scopeWhere(scope));
}

/** Lists secret METADATA for an extension (optionally scoped to a project).
 *  NEVER returns the ciphertext. */
export async function listSecretMeta(
  filter: { extensionId: string; projectId?: string | null },
): Promise<SecretMeta[]> {
  const conditions = [eq(extensionSecrets.extensionId, filter.extensionId)];
  if (filter.projectId !== undefined) {
    conditions.push(
      filter.projectId === null
        ? isNull(extensionSecrets.projectId)
        : eq(extensionSecrets.projectId, filter.projectId),
    );
  }
  return getDb()
    .select({
      name: extensionSecrets.name,
      projectId: extensionSecrets.projectId,
      userId: extensionSecrets.userId,
      createdAt: extensionSecrets.createdAt,
      lastUsedAt: extensionSecrets.lastUsedAt,
      rotatedAt: extensionSecrets.rotatedAt,
    })
    .from(extensionSecrets)
    .where(conditions.length === 1 ? conditions[0]! : and(...conditions));
}
