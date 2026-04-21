import { eq } from "drizzle-orm";
import { getDb } from "../connection";
import { users } from "../schema";
import type { User, NewUser } from "../schema";

export type { User, NewUser };

export async function createUser(data: NewUser): Promise<User> {
  const rows = await getDb().insert(users).values(data).returning();
  return rows[0]!;
}

export async function getUserByEmail(email: string): Promise<User | undefined> {
  const rows = await getDb().select().from(users).where(eq(users.email, email.toLowerCase()));
  return rows[0];
}

export async function getUserById(id: string): Promise<User | undefined> {
  const rows = await getDb().select().from(users).where(eq(users.id, id));
  return rows[0];
}

export async function listUsers(): Promise<User[]> {
  return getDb().select().from(users);
}

export async function updateUserStatus(id: string, status: "active" | "inactive"): Promise<boolean> {
  const rows = await getDb().update(users).set({ status }).where(eq(users.id, id)).returning();
  return rows.length > 0;
}

export async function getUserCount(): Promise<number> {
  const rows = await getDb().select().from(users);
  return rows.length;
}

export async function updateUserPassword(id: string, passwordHash: string): Promise<boolean> {
  const rows = await getDb().update(users).set({ passwordHash }).where(eq(users.id, id)).returning();
  return rows.length > 0;
}

export async function updateUserEmail(id: string, email: string): Promise<boolean> {
  const rows = await getDb().update(users).set({ email: email.toLowerCase() }).where(eq(users.id, id)).returning();
  return rows.length > 0;
}

export async function updateUserName(id: string, name: string): Promise<boolean> {
  const rows = await getDb().update(users).set({ name }).where(eq(users.id, id)).returning();
  return rows.length > 0;
}
