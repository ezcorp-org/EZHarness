import { eq, and, sql, lt, like } from "drizzle-orm";
import { getDb } from "../connection";
import { extensionStorage } from "../schema";

type Scope = "global" | "conversation" | "user";

// ── Read ─────────────────────────────────────────────────────────────

export async function getStorageValue(
  extensionId: string,
  scope: Scope,
  scopeId: string | null,
  key: string,
): Promise<{ value: unknown; encrypted: boolean; sizeBytes: number } | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(extensionStorage)
    .where(
      and(
        eq(extensionStorage.extensionId, extensionId),
        eq(extensionStorage.scope, scope),
        scopeId === null
          ? sql`${extensionStorage.scopeId} IS NULL`
          : eq(extensionStorage.scopeId, scopeId),
        eq(extensionStorage.key, key),
      ),
    );

  const row = rows[0];
  if (!row) return null;

  // Lazy TTL expiry
  if (row.expiresAt && row.expiresAt < new Date()) {
    await db.delete(extensionStorage).where(eq(extensionStorage.id, row.id));
    return null;
  }

  return { value: row.value, encrypted: row.encrypted, sizeBytes: row.sizeBytes };
}

// ── Write (upsert) ──────────────────────────────────────────────────

export async function setStorageValue(
  extensionId: string,
  scope: Scope,
  scopeId: string | null,
  key: string,
  value: unknown,
  encrypted: boolean,
  sizeBytes: number,
  expiresAt?: Date,
): Promise<void> {
  const db = getDb();
  const now = new Date();

  await db
    .insert(extensionStorage)
    .values({
      extensionId,
      scope,
      scopeId,
      key,
      value,
      encrypted,
      sizeBytes,
      expiresAt: expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [extensionStorage.extensionId, extensionStorage.scope, extensionStorage.scopeId, extensionStorage.key],
      set: { value, encrypted, sizeBytes, expiresAt: expiresAt ?? null, updatedAt: now },
    });
}

// ── Delete ──────────────────────────────────────────────────────────

export async function deleteStorageValue(
  extensionId: string,
  scope: Scope,
  scopeId: string | null,
  key: string,
): Promise<boolean> {
  const db = getDb();
  const result = await db
    .delete(extensionStorage)
    .where(
      and(
        eq(extensionStorage.extensionId, extensionId),
        eq(extensionStorage.scope, scope),
        scopeId === null
          ? sql`${extensionStorage.scopeId} IS NULL`
          : eq(extensionStorage.scopeId, scopeId),
        eq(extensionStorage.key, key),
      ),
    )
    .returning({ id: extensionStorage.id });
  return result.length > 0;
}

// ── List keys ───────────────────────────────────────────────────────

export async function listStorageKeys(
  extensionId: string,
  scope: Scope,
  scopeId: string | null,
  prefix?: string,
  limit = 100,
): Promise<Array<{ key: string; sizeBytes: number; encrypted: boolean; expiresAt: Date | null }>> {
  const db = getDb();

  const conditions = [
    eq(extensionStorage.extensionId, extensionId),
    eq(extensionStorage.scope, scope),
    scopeId === null
      ? sql`${extensionStorage.scopeId} IS NULL`
      : eq(extensionStorage.scopeId, scopeId),
  ];

  if (prefix) {
    // Escape LIKE wildcards to prevent pattern injection
    const escaped = prefix.replace(/%/g, "\\%").replace(/_/g, "\\_");
    conditions.push(like(extensionStorage.key, `${escaped}%`));
  }

  const rows = await db
    .select({
      key: extensionStorage.key,
      sizeBytes: extensionStorage.sizeBytes,
      encrypted: extensionStorage.encrypted,
      expiresAt: extensionStorage.expiresAt,
    })
    .from(extensionStorage)
    .where(and(...conditions))
    .limit(Math.min(limit, 1000));

  return rows;
}

// ── Usage (for quota checks) ────────────────────────────────────────

export async function getStorageUsage(
  extensionId: string,
): Promise<{ totalBytes: number; keyCount: number }> {
  const db = getDb();
  const [row] = await db
    .select({
      totalBytes: sql<number>`COALESCE(SUM(${extensionStorage.sizeBytes}), 0)::int`,
      keyCount: sql<number>`COUNT(*)::int`,
    })
    .from(extensionStorage)
    .where(
      and(
        eq(extensionStorage.extensionId, extensionId),
        sql`(${extensionStorage.expiresAt} IS NULL OR ${extensionStorage.expiresAt} >= NOW())`,
      ),
    );

  return { totalBytes: row?.totalBytes ?? 0, keyCount: row?.keyCount ?? 0 };
}

// ── TTL cleanup ─────────────────────────────────────────────────────

export async function deleteExpiredStorage(): Promise<number> {
  const db = getDb();
  const result = await db
    .delete(extensionStorage)
    .where(lt(extensionStorage.expiresAt, new Date()))
    .returning({ id: extensionStorage.id });
  return result.length;
}
