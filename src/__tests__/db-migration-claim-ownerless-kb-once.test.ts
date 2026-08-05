/**
 * Migration replay for the ONE-SHOT ownerless-KB adoption.
 *
 * `migrate()` runs on EVERY database open (`src/db/connection.ts`), and this
 * statement used to run with it — so the knowledge base's only sharing
 * mechanism (`user_id IS NULL`, see `kb-ownerless-rows-are-shared.test.ts`)
 * lasted exactly until the next restart. The fix is a marker row in `settings`
 * that makes the adoption fire once, ever.
 *
 * Everything below runs against a REAL PGlite, replaying real boots, because
 * the whole defect was a *repetition* bug: a mock that calls `up()` once can
 * only ever agree with itself. The specific properties pinned:
 *
 *   (1) FIRST boot still adopts — the migration has not been neutered.
 *   (2) SECOND (and Nth) boot does NOT — a row made ownerless after the first
 *       boot survives every later restart. This is the regression.
 *   (3) A FAILED run leaves the slot unclaimed, so the next boot retries.
 *       Load-bearing for the migration circuit breaker in `connection.ts`,
 *       which skips `migrate()` wholesale after a bad boot: "skipped" must
 *       never be recorded as "done".
 *   (4) The adoption never re-attributes a row that already has an owner.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  up,
  KB_OWNERLESS_CLAIM_MARKER_KEY,
} from "../db/migrations/claim-ownerless-kb-files-once";

let pglite: PGlite | null = null;
let db: ReturnType<typeof drizzle>;

const FIRST_ADMIN = "user-admin-first";
const LATER_ADMIN = "user-admin-later";
const MEMBER = "user-member";

/** The three real tables this migration touches, trimmed to the columns it reads. */
async function makeDb() {
  pglite = new PGlite();
  await pglite.waitReady;
  db = drizzle(pglite);
  await db.execute(sql`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE TABLE knowledge_base_files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL
    )
  `);
  // Ordered `created_at` so "first admin" is deterministic rather than
  // insertion-order luck — the migration's ORDER BY is what picks the winner.
  await db.execute(sql`
    INSERT INTO users (id, role, created_at) VALUES
      (${FIRST_ADMIN}, 'admin', '2020-01-01T00:00:00Z'),
      (${LATER_ADMIN}, 'admin', '2024-01-01T00:00:00Z'),
      (${MEMBER}, 'member', '2019-01-01T00:00:00Z')
  `);
}

async function addFile(id: string, userId: string | null): Promise<void> {
  await db.execute(sql`
    INSERT INTO knowledge_base_files (id, project_id, filename, user_id)
    VALUES (${id}, 'proj-1', ${`${id}.md`}, ${userId})
  `);
}

async function ownerOf(id: string): Promise<string | null> {
  const rows = (await db.execute(
    sql`SELECT user_id FROM knowledge_base_files WHERE id = ${id}`,
  )) as { rows: { user_id: string | null }[] };
  return rows.rows[0]?.user_id ?? null;
}

async function markerExists(): Promise<boolean> {
  const rows = (await db.execute(
    sql`SELECT 1 AS hit FROM settings WHERE key = ${KB_OWNERLESS_CLAIM_MARKER_KEY}`,
  )) as { rows: unknown[] };
  return rows.rows.length === 1;
}

beforeEach(async () => {
  await makeDb();
});

afterEach(async () => {
  await pglite?.close();
  pglite = null;
});

describe("(1) the first boot still performs the adoption", () => {
  test("an ownerless row present at first boot is adopted by the FIRST admin", async () => {
    await addFile("kb-legacy", null);
    expect(await markerExists()).toBe(false);

    await up(db);

    expect(await ownerOf("kb-legacy")).toBe(FIRST_ADMIN);
    expect(await markerExists()).toBe(true);
  });

  test("…and it is the OLDEST admin, not the oldest user", async () => {
    // `MEMBER` predates both admins; picking it would be a privilege mix-up,
    // and picking LATER_ADMIN would mean the ORDER BY was dropped.
    await addFile("kb-legacy", null);
    await up(db);
    expect(await ownerOf("kb-legacy")).toBe(FIRST_ADMIN);
  });

  test("an instance with no admin at all is a clean no-op, not a crash", async () => {
    await db.execute(sql`DELETE FROM users WHERE role = 'admin'`);
    await addFile("kb-legacy", null);

    await up(db);

    expect(await ownerOf("kb-legacy")).toBeNull();
    // Still claimed: the adoption ran and correctly found nothing to adopt.
    // Re-running later must not retroactively hand this row to whichever admin
    // gets created next — that is the every-boot behaviour being removed.
    expect(await markerExists()).toBe(true);
  });
});

describe("(2) THE REGRESSION: later boots must not re-claim", () => {
  test("a row made ownerless AFTER the first boot survives the second boot", async () => {
    // The operator's workflow: boot, then deliberately share a file by nulling
    // its owner. Before the fix, the next restart silently un-shared it.
    await up(db);

    await addFile("kb-shared", null);
    await up(db);

    expect(await ownerOf("kb-shared")).toBeNull();
  });

  test("…and survives a 5-restart cycle", async () => {
    await up(db);
    await addFile("kb-shared", null);

    for (let i = 0; i < 5; i++) await up(db);

    expect(await ownerOf("kb-shared")).toBeNull();
  });

  test("the marker is written exactly once — re-runs do not duplicate or churn it", async () => {
    await up(db);
    const first = (await db.execute(
      sql`SELECT value FROM settings WHERE key = ${KB_OWNERLESS_CLAIM_MARKER_KEY}`,
    )) as { rows: { value: unknown }[] };

    await up(db);
    const second = (await db.execute(
      sql`SELECT value FROM settings WHERE key = ${KB_OWNERLESS_CLAIM_MARKER_KEY}`,
    )) as { rows: { value: unknown }[] };

    expect(second.rows).toHaveLength(1);
    // ON CONFLICT DO NOTHING, so the original timestamp is preserved — the
    // marker records when the adoption happened, not when we last booted.
    expect(second.rows[0]!.value).toEqual(first.rows[0]!.value);
  });
});

describe("(3) a failed run leaves the work PENDING, never falsely done", () => {
  test("an executor that throws on the UPDATE writes no marker", async () => {
    // Mirrors what `connection.ts` does around migrate(): a run that did not
    // complete must not be recorded as complete. The circuit breaker skips
    // migrate() entirely on a bad boot, which is the same shape one level up —
    // no call, no marker.
    const statements: string[] = [];
    const throwing = {
      execute: async (q: any) => {
        const text = String(q?.queryChunks?.map((c: any) => c?.value ?? "").join("") ?? "");
        statements.push(text);
        throw new Error("simulated migrate failure");
      },
    };

    await up(throwing);

    // It attempted the adoption and swallowed the failure rather than bricking
    // the boot (the pre-existing contract for this statement).
    expect(statements).toHaveLength(1);
    // Crucially it did NOT go on to write the marker.
    expect(await markerExists()).toBe(false);
  });

  test("after a failed run, the NEXT boot still performs the adoption", async () => {
    await addFile("kb-legacy", null);
    await up({ execute: async () => { throw new Error("simulated migrate failure"); } });
    expect(await ownerOf("kb-legacy")).toBeNull();

    await up(db);

    expect(await ownerOf("kb-legacy")).toBe(FIRST_ADMIN);
  });
});

describe("(4) the adoption never touches a row that already has an owner", () => {
  test("an owned row keeps its owner through the first boot and every later one", async () => {
    await addFile("kb-owned", MEMBER);
    await addFile("kb-legacy", null);

    await up(db);
    await up(db);

    expect(await ownerOf("kb-owned")).toBe(MEMBER);
    expect(await ownerOf("kb-legacy")).toBe(FIRST_ADMIN);
  });
});
