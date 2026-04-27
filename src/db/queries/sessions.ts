import { eq, and, sql, lt, desc } from "drizzle-orm";
import { getDb } from "../connection";
import { sessions, users } from "../schema";
import type { Session } from "../schema";

export type { Session };

/**
 * Hash a raw token string to SHA-256 hex for storage/lookup.
 */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function createSession(opts: {
  userId: string;
  tokenHash: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  expiresAt: Date;
}): Promise<Session> {
  const rows = await getDb()
    .insert(sessions)
    .values({
      userId: opts.userId,
      tokenHash: opts.tokenHash,
      userAgent: opts.userAgent ?? null,
      ipAddress: opts.ipAddress ?? null,
      expiresAt: opts.expiresAt,
    })
    .returning();
  return rows[0]!;
}

export async function getSessionByTokenHash(tokenHash: string): Promise<Session | null> {
  const rows = await getDb()
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash));
  return rows[0] ?? null;
}

export async function revokeSession(id: string): Promise<boolean> {
  const rows = await getDb()
    .delete(sessions)
    .where(eq(sessions.id, id))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

export async function revokeAllUserSessions(userId: string): Promise<number> {
  const rows = await getDb()
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id });
  return rows.length;
}

export async function listSessionsByUser(userId: string): Promise<Session[]> {
  return getDb()
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.createdAt));
}

export async function listAllSessions() {
  return getDb()
    .select({
      id: sessions.id,
      userId: sessions.userId,
      tokenHash: sessions.tokenHash,
      userAgent: sessions.userAgent,
      ipAddress: sessions.ipAddress,
      expiresAt: sessions.expiresAt,
      lastActiveAt: sessions.lastActiveAt,
      createdAt: sessions.createdAt,
      userName: users.name,
      userEmail: users.email,
    })
    .from(sessions)
    .leftJoin(users, eq(sessions.userId, users.id))
    .orderBy(desc(sessions.createdAt));
}

/**
 * Update last_active_at, throttled to avoid write amplification.
 * Only writes if last update was more than `throttleMs` ago.
 */
export async function touchSession(id: string, throttleMs = 60_000): Promise<Session | null> {
  const rows = await getDb()
    .update(sessions)
    .set({ lastActiveAt: sql`NOW()` })
    .where(
      and(
        eq(sessions.id, id),
        lt(sessions.lastActiveAt, sql`NOW() - make_interval(secs => ${throttleMs} / 1000.0)`),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Atomically rotate a session's token hash and extend its expiry.
 *
 * Used by the sliding-refresh path in hooks.server.ts: when a JWT crosses the
 * refresh threshold we re-issue it and want the DB row to point at the new
 * hash. The match on `oldTokenHash` is the CAS predicate — if a concurrent
 * request already rotated the row, we lose silently (returns null) and the
 * caller leaves the inbound cookie alone.
 */
export async function rotateSessionToken(opts: {
  id: string;
  oldTokenHash: string;
  newTokenHash: string;
  newExpiresAt: Date;
}): Promise<Session | null> {
  const rows = await getDb()
    .update(sessions)
    .set({ tokenHash: opts.newTokenHash, expiresAt: opts.newExpiresAt })
    .where(and(eq(sessions.id, opts.id), eq(sessions.tokenHash, opts.oldTokenHash)))
    .returning();
  return rows[0] ?? null;
}

export async function deleteExpiredSessions(): Promise<number> {
  const rows = await getDb()
    .delete(sessions)
    .where(lt(sessions.expiresAt, sql`NOW()`))
    .returning({ id: sessions.id });
  return rows.length;
}
