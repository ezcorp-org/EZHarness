import { eq, and, gt, isNull, lt } from "drizzle-orm";
import { getDb } from "../connection";
import { passwordResetTokens } from "../schema";
import type { PasswordResetToken } from "../schema";
import { hashToken } from "./sessions";

export type { PasswordResetToken };

export async function createPasswordResetToken(data: {
  userId: string;
  token: string;
  expiresAt: Date;
}): Promise<PasswordResetToken> {
  const tokenHash = await hashToken(data.token);
  const rows = await getDb()
    .insert(passwordResetTokens)
    .values({
      userId: data.userId,
      token: tokenHash,
      expiresAt: data.expiresAt,
    })
    .returning();
  return rows[0]!;
}

export async function claimPasswordResetToken(token: string): Promise<PasswordResetToken | undefined> {
  const tokenHash = await hashToken(token);
  const rows = await getDb()
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(passwordResetTokens.token, tokenHash),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date())
      )
    )
    .returning();
  return rows[0];
}

export async function deleteExpiredResetTokens(): Promise<void> {
  await getDb()
    .delete(passwordResetTokens)
    .where(lt(passwordResetTokens.expiresAt, new Date()));
}
