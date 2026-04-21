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

export async function markInviteUsed(id: string): Promise<boolean> {
  const rows = await getDb()
    .update(invites)
    .set({ usedAt: new Date() })
    .where(eq(invites.id, id))
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
