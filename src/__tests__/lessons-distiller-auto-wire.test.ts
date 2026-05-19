/**
 * Phase 53 Stage 2 — auto-wire tests.
 *
 * Two flows under test:
 *
 *   1. Backfill migration
 *      (`src/extensions/migrations/lessons-distiller-conversation-wiring.ts`
 *       and the parallel
 *       `src/extensions/migrations/memory-extractor-conversation-wiring.ts`).
 *      Each inserts a `conversation_extensions` row for every existing
 *      conversation that lacks one, gated by a sentinel setting key.
 *
 *   2. New-conversation hook (`src/extensions/auto-wire-bundled.ts`)
 *      called from `createConversation` so freshly-created
 *      conversations get the wiring row at birth.
 *
 * Phase 53.4 extends this suite to cover the memory-extractor in
 * addition to lessons-distiller. The new-conv hook fires for BOTH
 * extensions in a single createConversation call (one wired-row per
 * bundled name), and each migration carries its own sentinel so the
 * two can replay / advance independently.
 *
 * Acceptance:
 *   a. Backfill on install with N pre-existing convs writes N rows
 *      per bundled extension covered.
 *   b. Sentinel idempotency — a second run is a no-op.
 *   c. New-conv hook adds the row automatically for BOTH extensions.
 *   d. Sentinel respects user de-wirings — after the migration
 *      completes once, manually unwiring a conversation does NOT cause
 *      a re-add on the next boot.
 *
 * The runtime API path is direct DB only — no JSON-RPC pipe, no
 * subprocess spawn.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mock.module("../db/queries/settings", () => {
  const { eq } = require("drizzle-orm");
  const { settings: tbl } = require("../db/schema");
  return {
    async getAllSettings() {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl);
      return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    },
    async getSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      return rows[0]?.value;
    },
    async upsertSetting(key: string, value: unknown) {
      const { getDb } = require("../db/connection");
      const db = getDb();
      const rows = await db.select().from(tbl).where(eq(tbl.key, key));
      if (rows[0]) {
        await db.update(tbl).set({ value, updatedAt: new Date() }).where(eq(tbl.key, key));
      } else {
        await db.insert(tbl).values({ key, value, updatedAt: new Date() });
      }
    },
    async deleteSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      if (!rows[0]) return false;
      await getDb().delete(tbl).where(eq(tbl.key, key));
      return true;
    },
    async isListingInstalled() { return false; },
  };
});

mockDbConnection();

const { migrateLessonsDistillerConversationWiring } = await import(
  "../extensions/migrations/lessons-distiller-conversation-wiring"
);
const { migrateMemoryExtractorConversationWiring } = await import(
  "../extensions/migrations/memory-extractor-conversation-wiring"
);
const { autoWireBundledExtensions } = await import(
  "../extensions/auto-wire-bundled"
);
const {
  getConversationExtensionIds,
  addConversationExtensions,
} = await import("../db/queries/conversation-extensions");
const { createConversation } = await import("../db/queries/conversations");
const { createProject } = await import("../db/queries/projects");
const { createExtension } = await import("../db/queries/extensions");
const { getSetting, deleteSetting, upsertSetting } = await import(
  "../db/queries/settings"
);
const { getDb } = await import("../db/connection");
const { conversationExtensions } = await import("../db/schema");
const { eq, and } = await import("drizzle-orm");

const SENTINEL_KEY = "global:lessonsDistillerAutoWiringMigratedAt";
const MEMORY_SENTINEL_KEY = "global:memoryExtractorAutoWiringMigratedAt";

let projectId: string;
let lessonsDistillerExtId: string;
let memoryExtractorExtId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({
    name: "Auto-wire test",
    path: "/tmp/auto-wire-test",
  });
  projectId = project.id;

  // Seed the bundled lessons-distiller row. The auto-wire helper looks
  // it up by name, the migration takes the id directly.
  const ext = await createExtension({
    name: "lessons-distiller",
    version: "1.0.0",
    source: "test",
    description: "test",
    manifest: {
      schemaVersion: 2,
      name: "lessons-distiller",
      version: "1.0.0",
      description: "test",
      author: { name: "t" },
      entrypoint: "x",
      tools: [],
      permissions: { eventSubscriptions: ["run:complete"] },
      settings: {
        enabled: { type: "boolean", label: "Enabled", default: true },
      },
    } as never,
  });
  lessonsDistillerExtId = ext.id;

  // Phase 53.4: seed the memory-extractor too. Same shape as
  // lessons-distiller; the auto-wire helper looks it up by name from
  // the AUTO_WIRE_BUNDLED_EXTENSION_NAMES list.
  const memExt = await createExtension({
    name: "memory-extractor",
    version: "1.0.0",
    source: "test",
    description: "test",
    manifest: {
      schemaVersion: 2,
      name: "memory-extractor",
      version: "1.0.0",
      description: "test",
      author: { name: "t" },
      entrypoint: "x",
      tools: [],
      permissions: { eventSubscriptions: ["run:complete"] },
      settings: {
        enabled: { type: "boolean", label: "Enabled", default: true },
      },
    } as never,
  });
  memoryExtractorExtId = memExt.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  // Clear sentinel + every wiring row for both bundled extensions so
  // each test starts fresh.
  await deleteSetting(SENTINEL_KEY);
  await deleteSetting(MEMORY_SENTINEL_KEY);
  await getDb()
    .delete(conversationExtensions)
    .where(eq(conversationExtensions.extensionId, lessonsDistillerExtId));
  await getDb()
    .delete(conversationExtensions)
    .where(eq(conversationExtensions.extensionId, memoryExtractorExtId));
});

// ── (a) Backfill on install ──────────────────────────────────────────

describe("migrateLessonsDistillerConversationWiring — backfill", () => {
  test("inserts a wiring row for every pre-existing conversation lacking one", async () => {
    // Three pre-existing conversations. Auto-wire fires inside
    // createConversation, so we have to clear those rows below to set
    // up the "legacy state" the migration is designed to handle.
    const c1 = await createConversation(projectId);
    const c2 = await createConversation(projectId);
    const c3 = await createConversation(projectId);
    await getDb()
      .delete(conversationExtensions)
      .where(eq(conversationExtensions.extensionId, lessonsDistillerExtId));
    await deleteSetting(SENTINEL_KEY);

    // Pre-condition: none of the three are wired to LESSONS-DISTILLER
    // specifically (Phase 53.4 also auto-wires memory-extractor on
    // createConversation; that row may be present and is irrelevant
    // to this assertion).
    for (const c of [c1, c2, c3]) {
      const ids = await getConversationExtensionIds(c.id);
      expect(ids).not.toContain(lessonsDistillerExtId);
    }

    await migrateLessonsDistillerConversationWiring(lessonsDistillerExtId);

    // Post-condition: each one has the lessons-distiller wired.
    for (const c of [c1, c2, c3]) {
      const ids = await getConversationExtensionIds(c.id);
      expect(ids).toContain(lessonsDistillerExtId);
    }

    // Sentinel stamped.
    const sentinel = await getSetting(SENTINEL_KEY);
    expect(typeof sentinel).toBe("string");
    expect(Number.isNaN(Date.parse(sentinel as string))).toBe(false);
  });

  test("conversations already wired by name keep their single row (no duplicates)", async () => {
    const conv = await createConversation(projectId);
    // Wipe the auto-wired row first; then re-add one row by hand.
    await getDb()
      .delete(conversationExtensions)
      .where(eq(conversationExtensions.extensionId, lessonsDistillerExtId));
    await addConversationExtensions(conv.id, [
      { extensionId: lessonsDistillerExtId },
    ]);
    await deleteSetting(SENTINEL_KEY);

    await migrateLessonsDistillerConversationWiring(lessonsDistillerExtId);

    // Still exactly one row — onConflictDoNothing prevented duplicate.
    const rows = await getDb()
      .select()
      .from(conversationExtensions)
      .where(
        and(
          eq(conversationExtensions.conversationId, conv.id),
          eq(conversationExtensions.extensionId, lessonsDistillerExtId),
        ),
      );
    expect(rows.length).toBe(1);
  });
});

// ── (b) Sentinel idempotency ─────────────────────────────────────────

describe("migrateLessonsDistillerConversationWiring — sentinel", () => {
  test("rerun with sentinel present is a no-op (no rows touched)", async () => {
    // Stamp the sentinel before any rows exist.
    await upsertSetting(SENTINEL_KEY, new Date().toISOString());

    const conv = await createConversation(projectId);
    // Remove the auto-wired row to simulate a "sentinel says done, but
    // a row is missing" state — which is exactly what we want the
    // sentinel to NOT undo.
    await getDb()
      .delete(conversationExtensions)
      .where(
        and(
          eq(conversationExtensions.conversationId, conv.id),
          eq(conversationExtensions.extensionId, lessonsDistillerExtId),
        ),
      );

    await migrateLessonsDistillerConversationWiring(lessonsDistillerExtId);

    // Sentinel was already present → migration short-circuited.
    const ids = await getConversationExtensionIds(conv.id);
    expect(ids).not.toContain(lessonsDistillerExtId);
  });
});

// ── (c) New-conversation hook ────────────────────────────────────────

describe("autoWireBundledExtensions — new conversations", () => {
  test("createConversation wires lessons-distiller automatically", async () => {
    const conv = await createConversation(projectId);
    const ids = await getConversationExtensionIds(conv.id);
    expect(ids).toContain(lessonsDistillerExtId);
  });

  test("createConversation wires memory-extractor automatically (Phase 53.4)", async () => {
    const conv = await createConversation(projectId);
    const ids = await getConversationExtensionIds(conv.id);
    expect(ids).toContain(memoryExtractorExtId);
  });

  test("createConversation wires BOTH lessons-distiller and memory-extractor", async () => {
    const conv = await createConversation(projectId);
    const ids = await getConversationExtensionIds(conv.id);
    expect(ids).toContain(lessonsDistillerExtId);
    expect(ids).toContain(memoryExtractorExtId);
  });

  test("explicit autoWireBundledExtensions call is idempotent for both extensions", async () => {
    const conv = await createConversation(projectId);
    const wired = await autoWireBundledExtensions(conv.id);
    // Helper returns the count of rows it tried to insert (one per
    // bundled name in AUTO_WIRE_BUNDLED_EXTENSION_NAMES — currently
    // lessons-distiller + memory-extractor = 2). The conflict handler
    // in addConversationExtensions means the second insert is a no-op
    // at the DB layer.
    expect(wired).toBe(2);

    for (const extId of [lessonsDistillerExtId, memoryExtractorExtId]) {
      const rows = await getDb()
        .select()
        .from(conversationExtensions)
        .where(
          and(
            eq(conversationExtensions.conversationId, conv.id),
            eq(conversationExtensions.extensionId, extId),
          ),
        );
      expect(rows.length).toBe(1);
    }
  });
});

// ── (e) Memory-extractor backfill migration (sibling sentinel) ──────

describe("migrateMemoryExtractorConversationWiring — backfill", () => {
  test("inserts a wiring row for every pre-existing conversation lacking one", async () => {
    const c1 = await createConversation(projectId);
    const c2 = await createConversation(projectId);
    await getDb()
      .delete(conversationExtensions)
      .where(eq(conversationExtensions.extensionId, memoryExtractorExtId));
    await deleteSetting(MEMORY_SENTINEL_KEY);

    for (const c of [c1, c2]) {
      const ids = await getConversationExtensionIds(c.id);
      expect(ids).not.toContain(memoryExtractorExtId);
    }

    await migrateMemoryExtractorConversationWiring(memoryExtractorExtId);

    for (const c of [c1, c2]) {
      const ids = await getConversationExtensionIds(c.id);
      expect(ids).toContain(memoryExtractorExtId);
    }

    const sentinel = await getSetting(MEMORY_SENTINEL_KEY);
    expect(typeof sentinel).toBe("string");
  });

  test("rerun with sibling memory sentinel present is a no-op", async () => {
    await upsertSetting(MEMORY_SENTINEL_KEY, new Date().toISOString());
    const conv = await createConversation(projectId);
    await getDb()
      .delete(conversationExtensions)
      .where(
        and(
          eq(conversationExtensions.conversationId, conv.id),
          eq(conversationExtensions.extensionId, memoryExtractorExtId),
        ),
      );

    await migrateMemoryExtractorConversationWiring(memoryExtractorExtId);

    const ids = await getConversationExtensionIds(conv.id);
    expect(ids).not.toContain(memoryExtractorExtId);
  });

  test("memory-extractor and lessons-distiller sentinels are independent", async () => {
    // Stamp the lessons sentinel only — memory-extractor should still
    // run a fresh backfill.
    await upsertSetting(SENTINEL_KEY, new Date().toISOString());
    const c = await createConversation(projectId);
    await getDb()
      .delete(conversationExtensions)
      .where(eq(conversationExtensions.extensionId, lessonsDistillerExtId));
    await getDb()
      .delete(conversationExtensions)
      .where(eq(conversationExtensions.extensionId, memoryExtractorExtId));

    await migrateLessonsDistillerConversationWiring(lessonsDistillerExtId);
    await migrateMemoryExtractorConversationWiring(memoryExtractorExtId);

    const ids = await getConversationExtensionIds(c.id);
    expect(ids).not.toContain(lessonsDistillerExtId);
    expect(ids).toContain(memoryExtractorExtId);
  });
});

// ── (d) Sentinel respects user de-wiring ──────────────────────────────

describe("auto-wire — user-driven unwirings stay unwired", () => {
  test("after migration + manual unwire + reboot, conversation stays unwired", async () => {
    // Simulate first-boot migration: stamp sentinel + wire one conv.
    const conv = await createConversation(projectId);
    await migrateLessonsDistillerConversationWiring(lessonsDistillerExtId);

    // User uninstalls the wiring (e.g. via the conversation extensions UI).
    await getDb()
      .delete(conversationExtensions)
      .where(
        and(
          eq(conversationExtensions.conversationId, conv.id),
          eq(conversationExtensions.extensionId, lessonsDistillerExtId),
        ),
      );

    // Subsequent boot: migration runs again. Sentinel is still set, so
    // the migration should NOT re-add the wiring the user removed.
    await migrateLessonsDistillerConversationWiring(lessonsDistillerExtId);

    const ids = await getConversationExtensionIds(conv.id);
    expect(ids).not.toContain(lessonsDistillerExtId);
  });
});
