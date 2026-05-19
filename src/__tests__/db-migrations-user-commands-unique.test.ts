import { test, expect, describe, afterAll } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { up } from "../db/migrations/add-user-commands-unique-name";

/**
 * Migration replay test for the `user_commands` UNIQUE(user_id, name)
 * pre-flight rename.
 *
 * Strategy: simulate a legacy database where `user_commands` was
 * created WITHOUT the unique constraint (older deployments), seed
 * duplicate rows, then run the pre-flight rename + idempotent unique
 * index from the migration. Confirm:
 *   - Every seeded row survives (no DROP).
 *   - Duplicates are renamed `name`, `name-2`, `name-3`, … in
 *     created_at order.
 *   - The unique index exists post-migration (a second INSERT of a
 *     duplicate now raises 23505).
 *
 * This isolates the migration logic from migrate.ts's full graph so
 * we can drive specific seed states without the whole boot-time
 * dependency chain (users / projects / pgvector / pg_trgm /
 * agent_configs / extensions / ...).
 */

const { vector } = await import("@electric-sql/pglite/vector");

let pglite: PGlite | null = null;

async function makeLegacyDb() {
  pglite = new PGlite({ extensions: { vector } });
  await pglite.waitReady;
  const db = drizzle(pglite);

  // Create the table WITHOUT the unique constraint — mirrors legacy
  // deployments. We use a lightweight users table (TEXT id only) so
  // the FK in user_commands resolves.
  await db.execute(sql`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT
    )
  `);
  await db.execute(sql`
    CREATE TABLE user_commands (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      frontmatter JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  return db;
}

// Apply the PUBLISHED migration `up()` from
// src/db/migrations/add-user-commands-unique-name.ts. Re-implementing
// the SQL inline here would silently drift from the migration the
// production deploy actually runs, so we import the real thing and
// the test fails if either side of that contract changes.
async function applyPreFlight(db: ReturnType<typeof drizzle>) {
  await up(db);
}

async function seedRow(
  db: ReturnType<typeof drizzle>,
  id: string,
  userId: string,
  name: string,
  createdAt: Date,
) {
  await db.execute(sql`
    INSERT INTO user_commands (id, user_id, name, created_at, updated_at)
    VALUES (${id}, ${userId}, ${name}, ${createdAt.toISOString()}, ${createdAt.toISOString()})
  `);
}

describe("user_commands UNIQUE(user_id, name) migration", () => {
  afterAll(async () => {
    if (pglite) await pglite.close().catch(() => {});
  });

  test("pre-flight rename: 2 duplicate names → name + name-2 (oldest keeps original)", async () => {
    const db = await makeLegacyDb();
    await db.execute(sql`INSERT INTO users (id) VALUES ('u_x')`);
    // Seed 2 rows both named `review`, different created_at so the
    // ordering is deterministic.
    await seedRow(db, "row-1", "u_x", "review", new Date("2025-01-01T00:00:00Z"));
    await seedRow(db, "row-2", "u_x", "review", new Date("2025-01-02T00:00:00Z"));

    await applyPreFlight(db);

    const rows = (await db.execute(
      sql`SELECT id, name FROM user_commands WHERE user_id = 'u_x' ORDER BY id`,
    )) as { rows: { id: string; name: string }[] };
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.find((r) => r.id === "row-1")?.name).toBe("review");
    expect(rows.rows.find((r) => r.id === "row-2")?.name).toBe("review-2");
  });

  test("pre-flight rename: 3 duplicates → name, name-2, name-3", async () => {
    const db = await makeLegacyDb();
    await db.execute(sql`INSERT INTO users (id) VALUES ('u_y')`);
    await seedRow(db, "a1", "u_y", "review", new Date("2025-01-01T00:00:00Z"));
    await seedRow(db, "a2", "u_y", "review", new Date("2025-01-02T00:00:00Z"));
    await seedRow(db, "a3", "u_y", "review", new Date("2025-01-03T00:00:00Z"));

    await applyPreFlight(db);

    const rows = (await db.execute(
      sql`SELECT id, name FROM user_commands WHERE user_id = 'u_y' ORDER BY created_at`,
    )) as { rows: { id: string; name: string }[] };
    expect(rows.rows.map((r) => r.name)).toEqual([
      "review",
      "review-2",
      "review-3",
    ]);
  });

  test("pre-flight is per-user — two users with the same name keep their unsuffixed names", async () => {
    const db = await makeLegacyDb();
    await db.execute(sql`INSERT INTO users (id) VALUES ('u_a'), ('u_b')`);
    await seedRow(db, "p1", "u_a", "share", new Date("2025-01-01T00:00:00Z"));
    await seedRow(db, "p2", "u_b", "share", new Date("2025-01-01T00:00:00Z"));

    await applyPreFlight(db);

    const rows = (await db.execute(
      sql`SELECT user_id, name FROM user_commands ORDER BY user_id`,
    )) as { rows: { user_id: string; name: string }[] };
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.find((r) => r.user_id === "u_a")?.name).toBe("share");
    expect(rows.rows.find((r) => r.user_id === "u_b")?.name).toBe("share");
  });

  test("unique index is in place post-migration (duplicate INSERT now fails)", async () => {
    const db = await makeLegacyDb();
    await db.execute(sql`INSERT INTO users (id) VALUES ('u_z')`);
    await seedRow(db, "z1", "u_z", "lonely", new Date("2025-01-01T00:00:00Z"));

    await applyPreFlight(db);

    let failed = false;
    try {
      await seedRow(db, "z2", "u_z", "lonely", new Date("2025-01-02T00:00:00Z"));
    } catch (e) {
      failed = true;
      // The unique violation surfaces from PGlite via the wrapper's
      // `cause` (or, if that's empty, in `message`). Accept either —
      // both stringifications include the constraint name we want to
      // see in the diagnostic.
      const text = [
        (e as { message?: string }).message ?? "",
        String((e as { cause?: unknown }).cause ?? ""),
      ].join(" | ");
      expect(text).toMatch(/unique|duplicate|uq_user_commands_user_name/i);
    }
    expect(failed).toBe(true);
  });

  test("pre-flight is idempotent — re-running on a clean DB is a no-op", async () => {
    const db = await makeLegacyDb();
    await db.execute(sql`INSERT INTO users (id) VALUES ('u_idem')`);
    await seedRow(db, "i1", "u_idem", "alpha", new Date("2025-01-01T00:00:00Z"));
    await seedRow(db, "i2", "u_idem", "beta", new Date("2025-01-02T00:00:00Z"));

    await applyPreFlight(db);
    await applyPreFlight(db); // second run

    const rows = (await db.execute(
      sql`SELECT name FROM user_commands WHERE user_id = 'u_idem' ORDER BY created_at`,
    )) as { rows: { name: string }[] };
    expect(rows.rows.map((r) => r.name)).toEqual(["alpha", "beta"]);
  });
});
