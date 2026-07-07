/**
 * Populated-data migration backfill coverage (audit gap HIGH-7).
 *
 * The forward-apply migration suites only prove the data-transforming
 * backfills in `src/db/migrate.ts` are correct against EMPTY tables. This
 * suite proves they ATTRIBUTE CORRECTLY against POPULATED old-schema data —
 * the realistic upgrade path where a mis-attribution is a cross-tenant hazard.
 *
 * Method (invokes the REAL migration SQL, not a reimplementation):
 *   1. `migrate(db)` once to build the schema (backfills no-op on empty tables).
 *   2. INSERT rows shaped like the PRE-backfill state (NULL user_id on runs and
 *      ownerless conversations, NULL parent_message_id on messages).
 *   3. `migrate(db)` AGAIN — migrate() is idempotent (CREATE/ADD COLUMN
 *      IF NOT EXISTS), so the second pass re-runs the very backfill statements
 *      an upgrade would run, now against the seeded populated rows.
 *   4. Assert the attribution outcome.
 * Because the second pass executes migrate.ts verbatim, any change to the real
 * backfill SQL semantics breaks this test — there is no copied SQL to drift.
 *
 * Backfills covered:
 *   - Run-ownership recursive-CTE walk (migrate.ts ~L432-456): every historical
 *     chat run inherits its ROOT conversation's owner, walking
 *     parent_conversation_id to the top. THE cross-tenant guard: a run in
 *     user-A's chain must NOT pick up user-B's ownership (and vice-versa), and
 *     must NOT inherit the ownerless child's admin-fallback owner — only the
 *     root's real owner.
 *   - parent_message_id LAG backfill (migrate.ts ~L118-127): each message links
 *     to its predecessor within the SAME conversation ordered by created_at; a
 *     pre-existing link is never overwritten.
 *   - Ownerless→first-admin backfill (migrate.ts ~L401-413): an ownerless row
 *     is assigned the FIRST admin by created_at; an already-owned row is left
 *     alone; with NO admin at all the row (and any run rooted on it) stays NULL
 *     (fail-closed / admin-only downstream).
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";

const EXTENSIONS = { vector, pg_trgm } as const;

type Db = ReturnType<typeof drizzle<typeof schema>>;

async function freshMigratedDb(): Promise<{ pglite: PGlite; db: Db }> {
  const pglite = new PGlite({ extensions: EXTENSIONS });
  await pglite.waitReady;
  const db = drizzle(pglite, { schema });
  // Pass 1: build the schema. Backfills run here but there is nothing to fill.
  await migrate(db);
  return { pglite, db };
}

// Convenience: single-column scalar read.
async function scalar<T = string | null>(pglite: PGlite, text: string, params: unknown[] = []): Promise<T> {
  const { rows } = await pglite.query<Record<string, T>>(text, params as (string | null)[]);
  const row = rows[0];
  if (!row) throw new Error(`no row for: ${text}`);
  return Object.values(row)[0] as T;
}

describe("migrate(): backfills against POPULATED old-schema data (admin present)", () => {
  let pglite: PGlite;
  let db: Db;

  // First admin (earliest created_at) is the ownerless-fallback target; the
  // later admin must never be chosen.
  const ADMIN_EARLY = "u-admin-early";
  const ADMIN_LATE = "u-admin-late";
  const USER_A = "u-alice";
  const USER_B = "u-bob";
  const PROJECT = "p-bf";

  beforeAll(async () => {
    ({ pglite, db } = await freshMigratedDb());

    await pglite.query("INSERT INTO projects (id, name, path) VALUES ($1, $2, $3)", [PROJECT, "BF", "/tmp/bf"]);

    // Two admins with distinct created_at → prove "first admin by created_at".
    const insUser =
      "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ($1, $2, 'x', $3, $4, $5)";
    await pglite.query(insUser, [ADMIN_EARLY, "ae@x.com", "AdminEarly", "admin", "2020-01-01T00:00:00Z"]);
    await pglite.query(insUser, [ADMIN_LATE, "al@x.com", "AdminLate", "admin", "2021-01-01T00:00:00Z"]);
    await pglite.query(insUser, [USER_A, "alice@x.com", "Alice", "member", "2022-01-01T00:00:00Z"]);
    await pglite.query(insUser, [USER_B, "bob@x.com", "Bob", "member", "2022-06-01T00:00:00Z"]);

    // Conversations. Roots inserted before children (parent_conversation_id FK).
    const insConv =
      "INSERT INTO conversations (id, project_id, user_id, parent_conversation_id) VALUES ($1, $2, $3, $4)";
    // Chain A — root owned by Alice; a 2-level ownerless descent below it.
    await pglite.query(insConv, ["convA-root", PROJECT, USER_A, null]);
    await pglite.query(insConv, ["convA-mid", PROJECT, null, "convA-root"]);
    await pglite.query(insConv, ["convA-leaf", PROJECT, null, "convA-mid"]);
    // Chain B — an INDEPENDENT chain rooted at Bob (cross-tenant control).
    await pglite.query(insConv, ["convB-root", PROJECT, USER_B, null]);
    await pglite.query(insConv, ["convB-leaf", PROJECT, null, "convB-root"]);
    // Chain C — ownerless ROOT: conversations backfill assigns it the first
    // admin, and the run walk must then inherit that admin.
    await pglite.query(insConv, ["convC-root", PROJECT, null, null]);
    await pglite.query(insConv, ["convC-leaf", PROJECT, null, "convC-root"]);
    // Standalone conversations for the ownerless→admin backfill assertions.
    await pglite.query(insConv, ["convD", PROJECT, null, null]); // ownerless → admin-early
    await pglite.query(insConv, ["convE", PROJECT, USER_B, null]); // owned → untouched
    await pglite.query(insConv, ["convF", PROJECT, USER_A, null]); // holds messages

    // Messages (parent_message_id all NULL unless noted). Distinct created_at so
    // LAG(id) OVER (ORDER BY created_at) is deterministic.
    const insMsg =
      "INSERT INTO messages (id, conversation_id, role, content, parent_message_id, created_at) VALUES ($1, $2, 'user', 'x', $3, $4)";
    // convA-root: linear m1 → m2 → m3.
    await pglite.query(insMsg, ["m1", "convA-root", null, "2026-01-01T10:00:00Z"]);
    await pglite.query(insMsg, ["m2", "convA-root", null, "2026-01-01T10:01:00Z"]);
    await pglite.query(insMsg, ["m3", "convA-root", null, "2026-01-01T10:02:00Z"]);
    // convB-root: mB1 → mB2 (partition control — must NOT link across to convA).
    await pglite.query(insMsg, ["mB1", "convB-root", null, "2026-01-01T10:00:00Z"]);
    await pglite.query(insMsg, ["mB2", "convB-root", null, "2026-01-01T10:01:00Z"]);
    // convF: mF2 carries a PRE-EXISTING (deliberately "wrong", forward) link to
    // mF3 that LAG would never produce → proves the `IS NULL` guard. Insert
    // mF1, mF3 before mF2 so the mF2→mF3 FK target exists at insert time.
    await pglite.query(insMsg, ["mF1", "convF", null, "2026-01-01T10:00:00Z"]);
    await pglite.query(insMsg, ["mF3", "convF", null, "2026-01-01T10:02:00Z"]);
    await pglite.query(insMsg, ["mF2", "convF", "mF3", "2026-01-01T10:01:00Z"]);

    // Runs — all pre-attribution (user_id NULL) except the pre-owned one.
    const insRun =
      "INSERT INTO runs (id, agent_name, status, started_at, conversation_id, user_id) VALUES ($1, 'chat', 'success', NOW(), $2, $3)";
    await pglite.query(insRun, ["runA", "convA-leaf", null]); // → Alice (root walk, 2 levels)
    await pglite.query(insRun, ["runA2", "convA-root", null]); // → Alice (root itself)
    await pglite.query(insRun, ["runB", "convB-leaf", null]); // → Bob
    await pglite.query(insRun, ["runC", "convC-leaf", null]); // → admin-early (ownerless root)
    await pglite.query(insRun, ["runNull", null, null]); // agent/CLI → stays NULL
    await pglite.query(insRun, ["runPreOwned", "convA-leaf", USER_B]); // already Bob → keep Bob

    // Pass 2: re-run migrate() → fires the REAL backfills over the seeded rows.
    await migrate(db);
  }, 30_000);

  afterAll(async () => {
    await pglite.close().catch(() => {});
  });

  const runOwner = (id: string) => scalar(pglite, "SELECT user_id FROM runs WHERE id = $1", [id]);
  const convOwner = (id: string) => scalar(pglite, "SELECT user_id FROM conversations WHERE id = $1", [id]);
  const msgParent = (id: string) => scalar(pglite, "SELECT parent_message_id FROM messages WHERE id = $1", [id]);

  // ── Run-ownership recursive-CTE walk ──────────────────────────────
  test("deep chain run inherits the ROOT owner, not the ownerless child's admin fallback", async () => {
    // The ownerless descent got the admin fallback from the conversations
    // backfill first…
    expect(await convOwner("convA-mid")).toBe(ADMIN_EARLY);
    expect(await convOwner("convA-leaf")).toBe(ADMIN_EARLY);
    // …but the run still walks past it to the real root owner (Alice).
    expect(await runOwner("runA")).toBe(USER_A);
  });

  test("run attached directly to an owned root is attributed to that owner", async () => {
    expect(await runOwner("runA2")).toBe(USER_A);
  });

  test("CROSS-TENANT: an independent chain keeps its own root owner (no bleed)", async () => {
    const a = await runOwner("runA");
    const b = await runOwner("runB");
    expect(a).toBe(USER_A);
    expect(b).toBe(USER_B);
    // The load-bearing negative: neither run leaked the other tenant's owner.
    expect(a).not.toBe(USER_B);
    expect(b).not.toBe(USER_A);
  });

  test("ownerless-root chain run inherits the admin fallback assigned to its root", async () => {
    expect(await convOwner("convC-root")).toBe(ADMIN_EARLY);
    expect(await runOwner("runC")).toBe(ADMIN_EARLY);
  });

  test("agent/CLI run (conversation_id NULL) stays NULL → admin-only downstream", async () => {
    expect(await runOwner("runNull")).toBeNull();
  });

  test("CROSS-TENANT idempotency: a run already owned by Bob is NOT reattributed to Alice's chain", async () => {
    // runPreOwned sits on Alice's chain but already carried Bob's id; the
    // `r.user_id IS NULL` guard must leave it as Bob's.
    expect(await runOwner("runPreOwned")).toBe(USER_B);
  });

  // ── parent_message_id LAG backfill ────────────────────────────────
  test("messages link to their in-conversation predecessor ordered by created_at", async () => {
    expect(await msgParent("m1")).toBeNull(); // first row has no predecessor
    expect(await msgParent("m2")).toBe("m1");
    expect(await msgParent("m3")).toBe("m2");
  });

  test("LAG partition is per-conversation — no cross-conversation link", async () => {
    expect(await msgParent("mB1")).toBeNull();
    const mB2Parent = await msgParent("mB2");
    expect(mB2Parent).toBe("mB1");
    // Negative: convB's second message did NOT link back into convA.
    expect(mB2Parent).not.toBe("m3");
  });

  test("pre-existing parent_message_id is never overwritten by the LAG backfill", async () => {
    // mF2's deliberately-wrong forward link survives (guard: only fills NULL)…
    expect(await msgParent("mF2")).toBe("mF3");
    // …while mF3 (was NULL) gets its true LAG predecessor mF2.
    expect(await msgParent("mF3")).toBe("mF2");
    expect(await msgParent("mF1")).toBeNull();
  });

  // ── Ownerless→first-admin backfill (conversations) ────────────────
  test("ownerless conversation is assigned the FIRST admin by created_at", async () => {
    const owner = await convOwner("convD");
    expect(owner).toBe(ADMIN_EARLY);
    expect(owner).not.toBe(ADMIN_LATE); // the later admin is never chosen
  });

  test("an already-owned conversation is left untouched by the admin backfill", async () => {
    expect(await convOwner("convE")).toBe(USER_B);
  });
});

describe("migrate(): backfills with NO admin present (fail-closed)", () => {
  let pglite: PGlite;
  let db: Db;
  const USER_M = "u-member-only";
  const PROJECT = "p-noadmin";

  beforeAll(async () => {
    ({ pglite, db } = await freshMigratedDb());

    await pglite.query("INSERT INTO projects (id, name, path) VALUES ($1, $2, $3)", [PROJECT, "NoAdmin", "/tmp/na"]);
    // Only a member — there is NO admin to fall back to.
    await pglite.query(
      "INSERT INTO users (id, email, password_hash, name, role) VALUES ($1, 'm@x.com', 'x', 'M', 'member')",
      [USER_M],
    );
    // Ownerless root + child, and a run on the child.
    const insConv =
      "INSERT INTO conversations (id, project_id, user_id, parent_conversation_id) VALUES ($1, $2, null, $3)";
    await pglite.query(insConv, ["convX-root", PROJECT, null]);
    await pglite.query(insConv, ["convX-leaf", PROJECT, "convX-root"]);
    await pglite.query(
      "INSERT INTO runs (id, agent_name, status, started_at, conversation_id, user_id) VALUES ('runX', 'chat', 'success', NOW(), 'convX-leaf', null)",
    );

    await migrate(db);
  }, 30_000);

  afterAll(async () => {
    await pglite.close().catch(() => {});
  });

  test("ownerless conversation stays NULL when no admin exists", async () => {
    expect(await scalar(pglite, "SELECT user_id FROM conversations WHERE id = 'convX-root'")).toBeNull();
  });

  test("run on an ownerless (no-admin) chain stays NULL → admin-only, fail-closed", async () => {
    // ro.user_id IS NULL means the run-ownership UPDATE skips the row entirely.
    expect(await scalar(pglite, "SELECT user_id FROM runs WHERE id = 'runX'")).toBeNull();
  });
});
