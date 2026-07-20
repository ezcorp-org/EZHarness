import { eq, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { settings } from "../schema";

export type Setting = typeof settings.$inferSelect;

export async function getAllSettings(): Promise<Record<string, unknown>> {
  const rows = await getDb().select().from(settings);
  return Object.fromEntries(rows.map((r: Setting) => [r.key, r.value]));
}

export async function getSetting(key: string): Promise<unknown | undefined> {
  const rows = await getDb().select().from(settings).where(eq(settings.key, key));
  return rows[0]?.value;
}

export async function upsertSetting(key: string, value: unknown): Promise<void> {
  const db = getDb();
  // jsonb params must be EXPLICITLY encoded: the Bun.sql driver (external
  // Postgres) infers a wire type from the JS value, so a bare boolean/number
  // arrives typed boolean/numeric and the jsonb column rejects the insert
  // with a 500 ("Failed query: insert into settings…"). PGlite tolerates the
  // bare value, which is why unit tests never saw it — found live when the
  // composer-suggestions toggle PUT `false` on the dev (external-PG) stack.
  // The ::text hop is load-bearing: a param cast straight to ::jsonb makes
  // the driver JSON-encode the (already-encoded) string a second time, so
  // `false` lands as the jsonb STRING "false" (the classic double-encode).
  // text→jsonb parses the JSON exactly once on every driver.
  const encoded = sql`${JSON.stringify(value) ?? "null"}::text::jsonb`;
  // ON CONFLICT DO UPDATE against the real conflict target (settings.key is the
  // primary key) — a single race-free statement on BOTH drivers. The previous
  // select-then-insert branch had no 23505 retry, so on external Postgres
  // (Bun.sql, true concurrent connections) two simultaneous first-writes of a
  // not-yet-existing key both saw no row, both took the INSERT branch, and the
  // loser 500'd with an unhandled duplicate-key error. PGlite's single
  // connection masked it, which is why unit tests never caught it.
  await db
    .insert(settings)
    .values({ key, value: encoded, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: encoded, updatedAt: new Date() },
    });
}

export async function isListingInstalled(listingId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(settings)
    .where(sql`${settings.key} LIKE 'marketplace:installed:%' AND ${settings.value}->>'listingId' = ${listingId}`);
  return (row?.count ?? 0) > 0;
}

export async function deleteSetting(key: string): Promise<boolean> {
  const rows = await getDb().select().from(settings).where(eq(settings.key, key));
  if (!rows[0]) return false;
  await getDb().delete(settings).where(eq(settings.key, key));
  return true;
}
