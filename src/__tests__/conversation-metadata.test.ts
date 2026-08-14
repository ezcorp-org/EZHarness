/**
 * `src/db/queries/conversation-metadata.ts` against a real Postgres engine.
 *
 * The point of the module is that a metadata write is ONE statement, so the
 * assertions here are all about what the ENGINE ends up holding — never about
 * what JS handed the driver. Two things it pins that a mock could not:
 *
 *   1. The column holds a jsonb OBJECT. `metadata->>'k'` resolving is the
 *      difference between a working merge and the double-encoded string scalar
 *      the `::text::jsonb` cast exists to prevent (see the dual-driver suite).
 *   2. The lost update is actually gone. `describe("the lost update is real")`
 *      re-runs the read-modify-write shape these helpers replaced, on the same
 *      engine, in the same interleave — and asserts it DESTROYS a key. Without
 *      that control the "both keys survive" test would pass just as happily
 *      against the old code, and prove nothing.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { mockDbConnection, setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mockDbConnection();

const { getDb } = await import("../db/connection");
const { conversations, projects } = await import("../db/schema");
const {
  mergeConversationMetadata,
  deleteCallerToolsMetadata,
  deleteGoalMetadata,
} = await import("../db/queries/conversation-metadata");
const { setConversationSpawnDepth, getConversationSpawnDepth, setConversationSpawnParentAuditId, getConversationSpawnParentAuditId } =
  await import("../db/queries/conversations");
const { writePersistedGoal, readPersistedGoal, deletePersistedGoal } = await import(
  "../runtime/goal-host"
);

const NUL = String.fromCharCode(0);
const FFFD = String.fromCharCode(0xfffd);
const CONV = "conv-meta";

beforeAll(async () => {
  await setupTestDb();
  await getDb()
    .insert(projects)
    .values({ id: "proj-meta", name: "proj-meta", path: "/tmp/proj-meta" } as never);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

/** Seed `metadata` from a SQL literal, so the seed itself cannot be the thing
 *  under test (an earlier spike seeded through a bind and every arm read FAIL
 *  for that reason alone). */
async function seed(metadataLiteral: string | null): Promise<void> {
  const pg = getTestPglite();
  await pg.query(`DELETE FROM conversations WHERE id = $1`, [CONV]);
  await pg.query(
    `INSERT INTO conversations (id, project_id, title, metadata) VALUES ($1, 'proj-meta', 'meta', ${
      metadataLiteral === null ? "NULL" : `'${metadataLiteral}'::jsonb`
    })`,
    [CONV],
  );
}

/** Read the row back THROUGH SQL, not through drizzle's row mapper — the
 *  mapper would happily parse a jsonb string scalar into an object and hide
 *  the exact corruption these tests exist to catch. */
async function readRaw(): Promise<{ typ: string | null; text: string | null; goal: string | null }> {
  const rows = await getTestPglite().query<{ typ: string | null; text: string | null; goal: string | null }>(
    `SELECT jsonb_typeof(metadata) AS typ, metadata::text AS text, metadata->>'goal' AS goal
       FROM conversations WHERE id = $1`,
    [CONV],
  );
  return rows.rows[0]!;
}

async function readMeta(): Promise<Record<string, unknown> | null> {
  const rows = await getDb().select().from(conversations).where(eq(conversations.id, CONV));
  return (rows[0]?.metadata ?? null) as Record<string, unknown> | null;
}

beforeEach(async () => {
  await seed(`{"spawnDepth": 3}`);
});

describe("mergeConversationMetadata", () => {
  test("merges a key in and stores a jsonb OBJECT, not a string scalar", async () => {
    await mergeConversationMetadata(CONV, { goal: { condition: "ship it" } });

    const raw = await readRaw();
    expect(raw.typ).toBe("object");
    // `->>` resolving is the whole assertion: on a string scalar it is NULL.
    expect(raw.goal).toBe(`{"condition": "ship it"}`);
    expect(await readMeta()).toEqual({ spawnDepth: 3, goal: { condition: "ship it" } });
  });

  test("preserves every key it did not name", async () => {
    await seed(`{"spawnDepth": 3, "spawnParentAuditId": "aud-1", "other": "keep"}`);
    await mergeConversationMetadata(CONV, { goal: "g" });

    expect(await readMeta()).toEqual({
      spawnDepth: 3,
      spawnParentAuditId: "aud-1",
      other: "keep",
      goal: "g",
    });
  });

  test("replaces a key that is already present", async () => {
    await mergeConversationMetadata(CONV, { spawnDepth: 9 });
    expect(await readMeta()).toEqual({ spawnDepth: 9 });
  });

  test("merges onto a NULL metadata column (the COALESCE arm)", async () => {
    await seed(null);
    await mergeConversationMetadata(CONV, { goal: "g" });

    const raw = await readRaw();
    expect(raw.typ).toBe("object");
    expect(await readMeta()).toEqual({ goal: "g" });
  });

  test("nested objects and arrays survive the round trip", async () => {
    await mergeConversationMetadata(CONV, {
      callerTools: [{ name: "a", schema: { type: "object" } }, { name: "b" }],
    });
    expect(await readMeta()).toEqual({
      spawnDepth: 3,
      callerTools: [{ name: "a", schema: { type: "object" } }, { name: "b" }],
    });
  });

  test("an empty patch leaves the bag untouched", async () => {
    await mergeConversationMetadata(CONV, {});
    expect(await readMeta()).toEqual({ spawnDepth: 3 });
  });

  test("an unknown conversation id matches no row and does not throw", async () => {
    await mergeConversationMetadata("no-such-conversation", { goal: "g" });
    expect(await readMeta()).toEqual({ spawnDepth: 3 });
  });
});

describe("the NUL scrub is load-bearing, not decorative", () => {
  test("a NUL in a patch VALUE is scrubbed and the row lands", async () => {
    await mergeConversationMetadata(CONV, { description: `bad${NUL}text` });

    const meta = await readMeta();
    expect(meta).toEqual({ spawnDepth: 3, description: `bad${FFFD}text` });
    expect(String(meta!.description).includes(NUL)).toBe(false);
  });

  test("a NUL in a patch KEY is scrubbed too", async () => {
    await mergeConversationMetadata(CONV, { [`bad${NUL}key`]: 1 });
    expect(await readMeta()).toEqual({ spawnDepth: 3, [`bad${FFFD}key`]: 1 });
  });

  test("a NUL nested deep inside the patch is scrubbed", async () => {
    await mergeConversationMetadata(CONV, { goal: { condition: `do${NUL}x`, tags: [`t${NUL}`] } });
    expect(await readMeta()).toEqual({
      spawnDepth: 3,
      goal: { condition: `do${FFFD}x`, tags: [`t${FFFD}`] },
    });
  });

  test("WITHOUT the scrub the same statement is REFUSED by the engine", async () => {
    // The guard for the three tests above: it proves they assert a real
    // rescue, and that the raw `sql` fragment genuinely bypasses the column
    // prototype patch (which would otherwise have scrubbed this).
    await expect(
      getTestPglite().query(
        `UPDATE conversations SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::text::jsonb WHERE id = $2`,
        [JSON.stringify({ description: `bad${NUL}text` }), CONV],
      ),
    ).rejects.toThrow(/unsupported Unicode escape/i);
  });
});

describe("deleteCallerToolsMetadata / deleteGoalMetadata", () => {
  test("removes only the named key", async () => {
    await seed(`{"callerTools": {"a": 1}, "goal": "keep", "spawnDepth": 3}`);
    await deleteCallerToolsMetadata(CONV);

    expect(await readMeta()).toEqual({ goal: "keep", spawnDepth: 3 });
  });

  test("deleteGoalMetadata removes only `goal`", async () => {
    await seed(`{"callerTools": {"a": 1}, "goal": "drop", "spawnDepth": 3}`);
    await deleteGoalMetadata(CONV);

    expect(await readMeta()).toEqual({ callerTools: { a: 1 }, spawnDepth: 3 });
  });

  test("deleting an absent key is a no-op, not an error", async () => {
    await deleteCallerToolsMetadata(CONV);
    expect(await readMeta()).toEqual({ spawnDepth: 3 });
  });

  test("deleting on a NULL metadata column yields an empty bag", async () => {
    await seed(null);
    await deleteGoalMetadata(CONV);

    const raw = await readRaw();
    expect(raw.typ).toBe("object");
    expect(await readMeta()).toEqual({});
  });

  test("an unknown conversation id matches no row and does not throw", async () => {
    await deleteGoalMetadata("no-such-conversation");
    expect(await readMeta()).toEqual({ spawnDepth: 3 });
  });
});

// ── The bug this module exists to fix ───────────────────────────────────────

/**
 * The read-modify-write these helpers replaced, reproduced verbatim so the
 * "both keys survive" test below has something to be measured against. Any
 * two of these interleaving lose one side: both SELECT the same bag, then both
 * UPDATE the WHOLE column, and the second write erases the first one's key.
 */
async function legacyReadModifyWrite(key: string, value: unknown): Promise<void> {
  const rows = await getDb().select().from(conversations).where(eq(conversations.id, CONV));
  const conv = rows[0];
  if (!conv) return;
  const meta = { ...((conv.metadata ?? {}) as Record<string, unknown>), [key]: value };
  await getDb().update(conversations).set({ metadata: meta }).where(eq(conversations.id, CONV));
}

describe("the lost update is real (guards every assertion below it)", () => {
  test("two interleaved read-modify-writes destroy one side", async () => {
    await seed(`{}`);
    await Promise.all([
      legacyReadModifyWrite("goal", { condition: "ship it" }),
      legacyReadModifyWrite("spawnDepth", 5),
    ]);

    const meta = (await readMeta())!;
    // Exactly one survivor — which one depends on scheduling, that a key is
    // LOST does not. This is the user-visible bug: a `/goal` silently vanishes.
    expect(Object.keys(meta).length).toBe(1);
  });
});

describe("the lost update is fixed", () => {
  test("two interleaved atomic merges both survive", async () => {
    await seed(`{}`);
    await Promise.all([
      mergeConversationMetadata(CONV, { goal: { condition: "ship it" } }),
      mergeConversationMetadata(CONV, { spawnDepth: 5 }),
    ]);

    expect(await readMeta()).toEqual({ goal: { condition: "ship it" }, spawnDepth: 5 });
  });

  test("the REAL writers interleave without losing a key", async () => {
    // The live production pair: the goal evaluator's per-cycle write racing a
    // spawn-depth write. Same interleave as the control above.
    await seed(`{}`);
    await Promise.all([
      writePersistedGoal(CONV, { condition: "ship it", lastReason: null, createdAt: "2026" }),
      setConversationSpawnDepth(CONV, 5),
      setConversationSpawnParentAuditId(CONV, "aud-9"),
    ]);

    expect(await readPersistedGoal(CONV)).toEqual({
      condition: "ship it",
      lastReason: null,
      createdAt: "2026",
    });
    expect(await getConversationSpawnDepth(CONV)).toBe(5);
    expect(await getConversationSpawnParentAuditId(CONV)).toBe("aud-9");
  });

  test("a delete racing a merge leaves the merge's key intact", async () => {
    await seed(`{"goal": "old", "spawnDepth": 1}`);
    await Promise.all([
      deletePersistedGoal(CONV),
      setConversationSpawnDepth(CONV, 7),
    ]);

    expect(await readPersistedGoal(CONV)).toBeUndefined();
    expect(await getConversationSpawnDepth(CONV)).toBe(7);
  });

  test("a goal carrying a NUL still round-trips through the live writer", async () => {
    await writePersistedGoal(CONV, {
      condition: `finish the${NUL} task`,
      lastReason: null,
      createdAt: "2026",
    });
    expect((await readPersistedGoal(CONV))!.condition).toBe(`finish the${FFFD} task`);
    expect(await getConversationSpawnDepth(CONV)).toBe(3);
  });
});
