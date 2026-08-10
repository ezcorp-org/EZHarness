/**
 * `migrate()`'s answer to the binding question this feature had to decide:
 * what happens to projects that already exist when `project_members` lands?
 *
 * The rule, and each property asserted below:
 *
 *  1. A project with NO members gets ONE `owner` row for the FIRST admin.
 *     It grants nothing new — PR #82 had already made PUT/DELETE admin-only
 *     — and it is what stops a project being reachable ONLY through the
 *     instance-admin override.
 *  2. A project that already HAS a member is left alone. The guard is "this
 *     project has no members", not "this user has no row", so a project
 *     created after the table ships (whose creator `createProject` stamps)
 *     is never re-attributed to an admin.
 *  3. Re-running is a no-op. The backfilled id is derived from the project
 *     id, so a second pass collides with itself on the primary key.
 *  4. With no admin present it inserts nothing, and the NEXT run — once an
 *     admin exists — picks the same rows up. That self-healing re-run is
 *     what attributes the seeded `global` project on a fresh install, where
 *     `migrate()` runs before anyone has signed up.
 *
 * Driven against a real PGlite running the real `migrate()`, because every
 * one of those properties is a property of the SQL.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";

let pglite: PGlite;

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

type Db = ReturnType<typeof drizzle<typeof schema>>;

async function freshDb(): Promise<Db> {
  await pglite?.close().catch(() => {});
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  return drizzle(pglite, { schema });
}

/** Rows as `{project, user, role, id}`, ordered so assertions are stable. */
async function members(): Promise<
  Array<{ project_id: string; user_id: string; role: string; id: string }>
> {
  const res = await pglite.query<{
    project_id: string;
    user_id: string;
    role: string;
    id: string;
  }>("SELECT project_id, user_id, role, id FROM project_members ORDER BY project_id, user_id");
  return res.rows;
}

async function addUser(db: Db, id: string, role: "admin" | "member", createdAt: string) {
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, name, role, created_at)
    VALUES (${id}, ${`${id}@backfill.test`}, 'h', ${id}, ${role}, ${createdAt}::timestamptz)
  `);
}

async function addProject(db: Db, id: string) {
  await db.execute(
    sql`INSERT INTO projects (id, name, path) VALUES (${id}, ${id}, ${`/tmp/${id}`})`,
  );
}

describe("migrate() — ownerless project_members backfill", () => {
  test("an ownerless project is attributed to the FIRST admin, by created_at", async () => {
    const db = await freshDb();
    await migrate(db);

    // Two admins and a plain member. `ORDER BY created_at LIMIT 1` must pick
    // the earlier admin — not the earlier USER, and not an arbitrary row.
    await addUser(db, "member-early", "member", "2020-01-01");
    await addUser(db, "admin-second", "admin", "2024-01-01");
    await addUser(db, "admin-first", "admin", "2021-01-01");
    await addProject(db, "legacy-project");

    await migrate(db);

    const rows = await members();
    const legacy = rows.filter((r) => r.project_id === "legacy-project");
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.user_id).toBe("admin-first");
    expect(legacy[0]!.role).toBe("owner");
    // The id is derived, which is what makes the re-run below a no-op and
    // keeps a backfilled row greppable as one.
    expect(legacy[0]!.id).toBe("pm-backfill-legacy-project");
  });

  test("the seeded `global` project is picked up by the same pass", async () => {
    // `global` is inserted by `migrate()` itself, before `users` has any
    // rows on a fresh install — so it is ownerless until a signup happens
    // and the next boot runs the backfill. This is that second boot.
    const rows = await members();
    const global = rows.filter((r) => r.project_id === "global");
    expect(global).toHaveLength(1);
    expect(global[0]!.user_id).toBe("admin-first");
    expect(global[0]!.role).toBe("owner");
  });

  test("re-running migrate() writes no second row and re-attributes nothing", async () => {
    const before = await members();
    const db = drizzle(pglite, { schema });
    await migrate(db);
    await migrate(db);
    expect(await members()).toEqual(before);
  });

  test("a project that already has a member is NOT re-attributed to the admin", async () => {
    const db = await freshDb();
    await migrate(db);
    await addUser(db, "admin-1", "admin", "2021-01-01");
    await addUser(db, "member-1", "member", "2022-01-01");
    await addProject(db, "owned-project");
    // What `createProject(data, creatorId)` writes.
    await db.execute(sql`
      INSERT INTO project_members (id, project_id, user_id, role)
      VALUES ('pm-real', 'owned-project', 'member-1', 'owner')
    `);

    await migrate(db);

    const owned = (await members()).filter((r) => r.project_id === "owned-project");
    expect(owned).toHaveLength(1);
    expect(owned[0]!.user_id).toBe("member-1");
    expect(owned[0]!.id).toBe("pm-real");
  });

  test("with no admin at all the backfill inserts nothing, then self-heals", async () => {
    const db = await freshDb();
    await migrate(db);
    // A plain member exists but no admin. Attributing to them would invent
    // an owner; attributing to nobody is repairable on the next boot.
    await addUser(db, "just-a-member", "member", "2021-01-01");
    await addProject(db, "no-admin-yet");

    await migrate(db);
    expect(await members()).toEqual([]);

    // First signup promotes someone to admin; the next boot picks the rows up
    // — the guard is still true for them.
    await addUser(db, "the-admin", "admin", "2023-01-01");
    await migrate(db);

    const rows = await members();
    expect(rows.map((r) => r.project_id).sort()).toEqual(["global", "no-admin-yet"]);
    for (const row of rows) {
      expect(row.user_id).toBe("the-admin");
      expect(row.role).toBe("owner");
    }
  });

  test("the unique index refuses a duplicate (project, user) pair", async () => {
    // The DDL the query layer's `ON CONFLICT` upsert depends on. Asserted
    // here rather than trusted, because a missing index would make the
    // upsert silently insert instead of update.
    const db = drizzle(pglite, { schema });
    let rejected: unknown;
    try {
      // Driven through PGlite directly rather than drizzle's `execute`,
      // which wraps the driver error in a "Failed query" message and drops
      // the constraint name that is the whole point of this assertion.
      await pglite.query(
        "INSERT INTO project_members (id, project_id, user_id, role) VALUES ('dupe', 'no-admin-yet', 'the-admin', 'member')",
      );
    } catch (err) {
      rejected = err;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect(String(rejected)).toContain("idx_project_members_unique");
    // Discrimination: the row was refused for the PAIR, not because inserts
    // are broken — the same user in another project is accepted.
    await addProject(db, "another-project");
    await db.execute(sql`
      INSERT INTO project_members (id, project_id, user_id, role)
      VALUES ('ok', 'another-project', 'the-admin', 'member')
    `);
    expect((await members()).some((r) => r.id === "ok")).toBe(true);
  });
});
