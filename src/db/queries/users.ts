import { eq, inArray } from "drizzle-orm";
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

/**
 * Batched variant of {@link getUserById}. Returns a Map keyed by user
 * id. Missing users map to `null` so callers can branch identically to
 * the per-call form (which returns `undefined`). Internally dedupes
 * `ids` to keep the SQL `IN (...)` list tight; the returned Map is
 * always keyed by every input id, even duplicates.
 */
export async function getUsersByIds(
  ids: string[],
): Promise<Map<string, User | null>> {
  const result = new Map<string, User | null>();
  if (ids.length === 0) return result;
  const uniqueIds = Array.from(new Set(ids));
  const rows = await getDb()
    .select()
    .from(users)
    .where(inArray(users.id, uniqueIds));
  const byId = new Map<string, User>();
  for (const row of rows) byId.set(row.id, row);
  for (const id of ids) {
    result.set(id, byId.get(id) ?? null);
  }
  return result;
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
