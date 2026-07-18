import { eq, and, gt, isNull } from "drizzle-orm";
import { getDb } from "../connection";
import { invites } from "../schema";
import type { Invite } from "../schema";

export type { Invite };

export async function createInvite(data: {
  email?: string;
  role: "admin" | "member";
  createdBy: string;
  expiresInDays?: number;
}): Promise<Invite> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + (data.expiresInDays ?? 7));

  const rows = await getDb().insert(invites).values({
    email: data.email,
    token,
    role: data.role,
    createdBy: data.createdBy,
    expiresAt,
  }).returning();

  return rows[0]!;
}

export async function getInviteByToken(token: string): Promise<Invite | undefined> {
  const rows = await getDb()
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.token, token),
        gt(invites.expiresAt, new Date()),
        isNull(invites.usedAt)
      )
    );
  return rows[0];
}

/**
 * Atomically claim a single-use invite.
 *
 * The `isNull(invites.usedAt)` guard makes this a compare-and-set: the
 * UPDATE only flips a row that is still unclaimed, and `.returning()`
 * reports whether THIS call won the race. Two concurrent redemptions of
 * the same token therefore cannot both succeed — the loser gets zero
 * rows back and must abort. Mirrors `claimPasswordResetToken`
 * (src/db/queries/password-resets.ts). Callers MUST claim BEFORE
 * creating the account and treat a `false` return as "already used".
 */
export async function markInviteUsed(id: string): Promise<boolean> {
  const rows = await getDb()
    .update(invites)
    .set({ usedAt: new Date() })
    .where(and(eq(invites.id, id), isNull(invites.usedAt)))
    .returning();
  return rows.length > 0;
}

export async function listInvites(createdBy?: string): Promise<Invite[]> {
  if (createdBy) {
    return getDb().select().from(invites).where(eq(invites.createdBy, createdBy));
  }
  return getDb().select().from(invites);
}

export async function deleteInvite(id: string): Promise<boolean> {
  const rows = await getDb()
    .select()
    .from(invites)
    .where(eq(invites.id, id));
  if (rows.length === 0) return false;
  await getDb().delete(invites).where(eq(invites.id, id));
  return true;
}
