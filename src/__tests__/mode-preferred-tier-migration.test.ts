/**
 * WS3b — `modes.preferred_tier` migration
 * (`src/db/migrations/add-mode-preferred-tier.ts`, inlined by `migrate()`).
 *
 * The column is the mode → routing-TIER task binding. What has to hold:
 *
 *  1. `migrate()` creates it, as plain nullable TEXT with NO CHECK constraint
 *     (the union narrows at the TypeScript layer, so adding a tier stays a
 *     zero-DDL change — same convention as `message_attachments.kind`).
 *  2. The default for every EXISTING row is NULL = "no tier preference",
 *     which routes exactly as it did before the column existed. Any non-NULL
 *     default would silently re-route every existing mode's traffic; the
 *     seeded built-ins are checked for this explicitly.
 *  3. A row written under the OLD schema stays intact and reads NULL once the
 *     column is added — the migration is purely additive.
 *  4. Both `migrate()` and the standalone `up()` are idempotent.
 *  5. Every tier value round-trips through the Drizzle column.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql, eq, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { up as addModePreferredTier } from "../db/migrations/add-mode-preferred-tier";
import { VALID_TIERS } from "../runtime/tier-classifier";

let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

async function freshDb() {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
}

async function preferredTierColumn() {
  return (
    await db.execute(sql`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'modes'
        AND column_name = 'preferred_tier'
    `)
  ).rows as Array<{ data_type: string; is_nullable: string; column_default: string | null }>;
}

beforeEach(async () => {
  await freshDb();
});

afterEach(async () => {
  if (pglite) await pglite.close().catch(() => {});
});

describe("modes.preferred_tier — shape", () => {
  test("migrate() adds it as nullable TEXT with no default and no CHECK constraint", async () => {
    const cols = await preferredTierColumn();
    expect(cols).toHaveLength(1);
    expect(cols[0]!.data_type).toBe("text");
    expect(cols[0]!.is_nullable).toBe("YES");
    // No DB-level default: NULL is the "no preference" value, and routing
    // reads it as such (src/runtime/routing/mode-binding.ts).
    expect(cols[0]!.column_default).toBeNull();

    const checks = (
      await db.execute(sql`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.modes'::regclass AND contype = 'c'
      `)
    ).rows as Array<{ conname: string }>;
    expect(checks).toEqual([]);
  });

  test("every routing tier round-trips through the Drizzle column", async () => {
    for (const tier of VALID_TIERS) {
      const [row] = await db
        .insert(schema.modes)
        .values({
          name: `Tier ${tier}`,
          slug: `tier-${tier}`,
          systemPromptInstruction: "do the thing",
          preferredTier: tier,
        })
        .returning();
      expect(row!.preferredTier).toBe(tier);

      const fetched = await db.select().from(schema.modes).where(eq(schema.modes.id, row!.id));
      expect(fetched[0]!.preferredTier).toBe(tier);
    }
  });

  test("a mode inserted without the field reads NULL, not a tier", async () => {
    const [row] = await db
      .insert(schema.modes)
      .values({ name: "No Pref", slug: "no-pref", systemPromptInstruction: "x" })
      .returning();
    expect(row!.preferredTier).toBeNull();
  });
});

describe("modes.preferred_tier — existing rows keep routing as before", () => {
  test("the seeded built-in modes carry NO tier preference", async () => {
    // Plan / Code Review / Ez are seeded by migrate(). If any of them gained a
    // tier here, upgrading would silently re-route their traffic.
    const builtins = await db.select().from(schema.modes).where(eq(schema.modes.builtin, true));
    expect(builtins.length).toBeGreaterThanOrEqual(3);
    for (const row of builtins) {
      expect(row.preferredTier).toBeNull();
    }
    const unset = await db
      .select()
      .from(schema.modes)
      .where(isNull(schema.modes.preferredTier));
    expect(unset).toHaveLength(builtins.length);
  });

  test("a row written under the OLD schema survives the column being added, and reads NULL", async () => {
    // Simulate the pre-migration state: drop the column, write a legacy row
    // (preferred_model set — the config that used to be dead), then apply the
    // standalone migration the way a boot would.
    await db.execute(sql`ALTER TABLE modes DROP COLUMN preferred_tier`);
    expect(await preferredTierColumn()).toHaveLength(0);

    await db.execute(sql`
      INSERT INTO modes (id, name, slug, system_prompt_instruction, preferred_model, preferred_provider)
      VALUES ('legacy-mode', 'Legacy', 'legacy', 'review carefully', 'claude-opus-4-6', 'anthropic')
    `);

    await addModePreferredTier(db);

    expect(await preferredTierColumn()).toHaveLength(1);
    const rows = await db.select().from(schema.modes).where(eq(schema.modes.id, "legacy-mode"));
    expect(rows).toHaveLength(1);
    // Untouched columns intact, new column NULL.
    expect(rows[0]!.preferredModel).toBe("claude-opus-4-6");
    expect(rows[0]!.preferredProvider).toBe("anthropic");
    expect(rows[0]!.systemPromptInstruction).toBe("review carefully");
    expect(rows[0]!.preferredTier).toBeNull();
  });
});

describe("modes.preferred_tier — idempotency", () => {
  test("re-running the standalone up() does not throw or clear stored tiers", async () => {
    await db.insert(schema.modes).values({
      name: "Careful",
      slug: "careful",
      systemPromptInstruction: "x",
      preferredTier: "powerful",
    });

    await addModePreferredTier(db);
    await addModePreferredTier(db);

    const rows = await db.select().from(schema.modes).where(eq(schema.modes.slug, "careful"));
    expect(rows[0]!.preferredTier).toBe("powerful");
  });

  test("a second migrate() (a container restart) preserves stored tiers", async () => {
    await db.insert(schema.modes).values({
      name: "Cheap",
      slug: "cheap",
      systemPromptInstruction: "x",
      preferredTier: "fast",
    });

    await migrate(db);

    const rows = await db.select().from(schema.modes).where(eq(schema.modes.slug, "cheap"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.preferredTier).toBe("fast");
  });
});
