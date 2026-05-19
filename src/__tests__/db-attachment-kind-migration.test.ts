import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import type { MessageAttachment } from "../db/schema";

/**
 * Guard for the `messageAttachments.kind` union expansion.
 *
 * src/db/schema.ts declares:
 *   kind: text("kind").notNull().$type<"image" | "text" | "pdf" | "audio" | "extension-handle">()
 *
 * The DDL in src/db/migrate.ts intentionally stores `kind` as plain TEXT
 * (no CHECK constraint) so the union narrows at the TypeScript level and
 * adding a new variant is a zero-DDL change. These tests pin that contract:
 *
 *  1. Insert + select round-trips for every variant in the union.
 *  2. Rows written under the OLD 4-variant union remain readable after the
 *     migration runs again — proves the schema change is purely additive.
 *  3. migrate() stays idempotent in the presence of all 5 variants.
 *  4. The narrowed `row.kind` value at the type-system layer is one of the
 *     5 expected literals (asserted at runtime via `toContain`).
 */

const ALL_KINDS = ["image", "text", "pdf", "audio", "extension-handle"] as const;
type AttachmentKind = (typeof ALL_KINDS)[number];

let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

async function freshDb() {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
}

async function seedMessage(): Promise<{ projectId: string; conversationId: string; messageId: string }> {
  const [project] = await db.insert(schema.projects).values({
    name: "attachment-kind-test",
    path: "/tmp/attachment-kind-test",
  }).returning();
  const [conv] = await db.insert(schema.conversations).values({
    projectId: project!.id,
    title: "kind test",
  }).returning();
  const [msg] = await db.insert(schema.messages).values({
    conversationId: conv!.id,
    role: "user",
    content: "hi",
  }).returning();
  return { projectId: project!.id, conversationId: conv!.id, messageId: msg!.id };
}

beforeEach(async () => {
  await freshDb();
});

afterEach(async () => {
  if (pglite) await pglite.close().catch(() => {});
});

describe("messageAttachments.kind union expansion", () => {
  test("insert + select round-trips every union variant", async () => {
    const { conversationId, messageId } = await seedMessage();

    for (const kind of ALL_KINDS) {
      const [row] = await db.insert(schema.messageAttachments).values({
        messageId,
        conversationId,
        filename: `${kind}.bin`,
        mimeType: "application/octet-stream",
        sizeBytes: 42,
        storagePath: `/tmp/${kind}.bin`,
        kind,
      }).returning();

      expect(row).toBeDefined();
      expect(row!.id).toBeDefined();
      expect(row!.kind).toBe(kind);
      expect(row!.filename).toBe(`${kind}.bin`);
      expect(row!.createdAt).toBeInstanceOf(Date);

      const fetched = await db
        .select()
        .from(schema.messageAttachments)
        .where(eq(schema.messageAttachments.id, row!.id));
      expect(fetched[0]?.kind).toBe(kind);
    }

    const all = await db.select().from(schema.messageAttachments);
    expect(all.map((r) => r.kind).sort()).toEqual([...ALL_KINDS].sort());
  });

  test("rows written under the OLD 4-variant union remain queryable after another migrate()", async () => {
    // The schema change is purely additive at the TypeScript layer — the
    // underlying TEXT column has always been unconstrained. Simulate the
    // historical state by inserting only the original four kinds, then
    // re-run migrate() (the boot sequence does this on every restart) and
    // assert that the legacy rows still come back unchanged.
    const { conversationId, messageId } = await seedMessage();
    const legacyKinds = ["image", "text", "pdf", "audio"] as const;

    for (const kind of legacyKinds) {
      await db.insert(schema.messageAttachments).values({
        messageId,
        conversationId,
        filename: `legacy-${kind}.bin`,
        mimeType: "application/octet-stream",
        sizeBytes: 7,
        storagePath: `/tmp/legacy-${kind}.bin`,
        kind,
      });
    }

    // Re-run migrate (mirrors a Watchtower restart against an existing DB).
    await migrate(db);

    const rows = await db.select().from(schema.messageAttachments);
    expect(rows).toHaveLength(legacyKinds.length);
    expect(rows.map((r) => r.kind).sort()).toEqual([...legacyKinds].sort());
    for (const row of rows) {
      expect(row.filename).toBe(`legacy-${row.kind}.bin`);
      expect(row.sizeBytes).toBe(7);
    }
  });

  test("migrate() is a no-op when the table holds rows of all 5 kinds", async () => {
    const { conversationId, messageId } = await seedMessage();

    for (const kind of ALL_KINDS) {
      await db.insert(schema.messageAttachments).values({
        messageId,
        conversationId,
        filename: `${kind}.bin`,
        mimeType: "application/octet-stream",
        sizeBytes: 1,
        storagePath: `/tmp/${kind}.bin`,
        kind,
      });
    }

    const before = await db.select().from(schema.messageAttachments);
    expect(before).toHaveLength(ALL_KINDS.length);

    // Second migrate() must not throw and must not mutate or drop rows.
    await migrate(db);

    const after = await db.select().from(schema.messageAttachments);
    expect(after).toHaveLength(ALL_KINDS.length);

    // Identity-by-id: every pre-migrate row is still present with the same
    // kind (catches any well-meaning DELETE/UPDATE creeping into migrate()).
    const beforeById = new Map(before.map((r) => [r.id, r.kind]));
    for (const row of after) {
      expect(beforeById.get(row.id)).toBe(row.kind);
    }
  });

  test("kind narrows to the declared union at the type level", async () => {
    const { conversationId, messageId } = await seedMessage();
    await db.insert(schema.messageAttachments).values({
      messageId,
      conversationId,
      filename: "handle.json",
      mimeType: "application/json",
      sizeBytes: 16,
      storagePath: "/tmp/handle.json",
      kind: "extension-handle",
    });

    const rows: MessageAttachment[] = await db.select().from(schema.messageAttachments);
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    // Static side: assigning row.kind to the union type must compile —
    // this line breaks the build if the schema $type<...> ever drifts away
    // from the documented 5-member union.
    const kind: AttachmentKind = row.kind;
    expect(ALL_KINDS).toContain(kind);
  });

  test("the kind column is TEXT NOT NULL with no CHECK constraint", async () => {
    // Documents the deliberate choice to enforce the union at the TS layer
    // only. If a future migration adds a CHECK constraint, this test fails
    // and the author has to update both the schema and this guard in lockstep.
    const cols = (await db.execute(sql`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'message_attachments'
        AND column_name = 'kind'
    `)).rows as Array<{ data_type: string; is_nullable: string }>;
    expect(cols).toHaveLength(1);
    expect(cols[0]!.data_type).toBe("text");
    expect(cols[0]!.is_nullable).toBe("NO");

    const checks = (await db.execute(sql`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'public.message_attachments'::regclass
        AND contype = 'c'
    `)).rows as Array<{ conname: string }>;
    expect(checks).toEqual([]);
  });
});
