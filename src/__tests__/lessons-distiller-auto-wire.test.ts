/**
 * Auto-wire tests for the bundled extensions that must observe every
 * conversation (`lessons-distiller`, `memory-extractor`).
 *
 * Two flows under test, both in `src/extensions/auto-wire-bundled.ts`:
 *
 *   1. `autoWireBundledExtensions(conversationId)` — the create-time
 *      hook `createConversation` calls, which wires ONE conversation.
 *   2. `reconcileBundledConversationWiring()` — the idempotent
 *      whole-table reconcile that boot and activation call, which wires
 *      EVERY conversation still lacking a row.
 *
 * The reconcile replaced two sentinel-gated one-time backfill
 * migrations. The bug it fixes: the create-time hook only fires while
 * the extension is already enabled, so every conversation created
 * during a disabled window (a failed bootstrap, an operator toggle)
 * stayed unwired forever and the extension silently never fired on it.
 * These tests therefore drive the real shape of that bug — create
 * conversations while disabled, enable, reconcile.
 *
 * Acceptance:
 *   a. Reconcile wires every conversation created while the extension
 *      was disabled.
 *   b. Reconcile skips an extension that is disabled, and one with no
 *      registry row at all.
 *   c. A second reconcile inserts zero rows and leaves exactly one row
 *      per (conversation, extension) pair.
 *   d. Reconcile spans more conversations than one insert batch.
 *   e. The create-time hook still wires a new conversation into both
 *      extensions.
 *
 * Direct DB only — no JSON-RPC pipe, no subprocess spawn.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { autoWireBundledExtensions, reconcileBundledConversationWiring } =
  await import("../extensions/auto-wire-bundled");
const { getConversationExtensionIds } = await import(
  "../db/queries/conversation-extensions"
);
const { createConversation } = await import("../db/queries/conversations");
const { createProject } = await import("../db/queries/projects");
const { createExtension } = await import("../db/queries/extensions");
const { getDb } = await import("../db/connection");
const { conversationExtensions, conversations, extensions } = await import(
  "../db/schema"
);
const { eq, and } = await import("drizzle-orm");

let projectId: string;

/** Seed one bundled extension row by manifest name. Both bundled names
 *  carry the same `run:complete` subscription shape, so one builder
 *  covers them. */
async function seedBundled(name: string, enabled: boolean): Promise<string> {
  const ext = await createExtension({
    name,
    version: "1.0.0",
    source: "test",
    description: "test",
    enabled,
    manifest: {
      schemaVersion: 2,
      name,
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
  return ext.id;
}

/** Count the wiring rows for one (conversation, extension) pair. Used to
 *  prove `onConflictDoNothing` left exactly one row, not two. */
async function wiringRowCount(
  conversationId: string,
  extensionId: string,
): Promise<number> {
  const rows = await getDb()
    .select()
    .from(conversationExtensions)
    .where(
      and(
        eq(conversationExtensions.conversationId, conversationId),
        eq(conversationExtensions.extensionId, extensionId),
      ),
    );
  return rows.length;
}

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({
    name: "Auto-wire test",
    path: "/tmp/auto-wire-test",
  });
  projectId = project.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  // Every test seeds its own extension rows in its own enabled state,
  // so wipe both tables first. Deleting `extensions` cascades the
  // wiring rows; deleting `conversations` keeps the counts exact.
  await getDb().delete(conversationExtensions);
  await getDb().delete(conversations);
  await getDb().delete(extensions);
});

// ── (a) Reconcile closes the disabled-window gap ─────────────────────

describe("reconcileBundledConversationWiring — backfill", () => {
  test("wires every conversation created while the extensions were disabled", async () => {
    const lessonsId = await seedBundled("lessons-distiller", false);
    const memoryId = await seedBundled("memory-extractor", false);

    // The exact shape of the live bug: conversations created during a
    // disabled window get no row from the create-time hook.
    const convs = [
      await createConversation(projectId),
      await createConversation(projectId),
      await createConversation(projectId),
    ];
    for (const conv of convs) {
      expect(await getConversationExtensionIds(conv.id)).toEqual([]);
    }

    await getDb().update(extensions).set({ enabled: true });

    const inserted = await reconcileBundledConversationWiring();
    expect(inserted).toBe(6);

    for (const conv of convs) {
      const ids = await getConversationExtensionIds(conv.id);
      expect(ids).toContain(lessonsId);
      expect(ids).toContain(memoryId);
    }
  });

  test("wires conversations beyond a single insert batch", async () => {
    // The reconcile inserts in batches of 500. A 501st conversation
    // proves the loop advances instead of stopping at the first batch.
    const memoryId = await seedBundled("memory-extractor", true);
    const rows = Array.from({ length: 501 }, (_, i) => ({
      projectId,
      title: `batch conversation ${i}`,
    }));
    const created = await getDb()
      .insert(conversations)
      .values(rows)
      .returning({ id: conversations.id });
    expect(created).toHaveLength(501);

    const inserted = await reconcileBundledConversationWiring();
    expect(inserted).toBe(501);

    const wired = await getDb()
      .select({ id: conversationExtensions.id })
      .from(conversationExtensions)
      .where(eq(conversationExtensions.extensionId, memoryId));
    expect(wired).toHaveLength(501);
  });
});

// ── (b) Reconcile respects disabled / absent extensions ──────────────

describe("reconcileBundledConversationWiring — skips", () => {
  test("skips a disabled extension and wires only the enabled one", async () => {
    const lessonsId = await seedBundled("lessons-distiller", true);
    const memoryId = await seedBundled("memory-extractor", false);

    const conv1 = await createConversation(projectId);
    const conv2 = await createConversation(projectId);
    // The create-time hook already wired the ENABLED one; clear it so
    // the reconcile has real work and its return count is unambiguous.
    await getDb().delete(conversationExtensions);

    const inserted = await reconcileBundledConversationWiring();
    expect(inserted).toBe(2);

    for (const conv of [conv1, conv2]) {
      const ids = await getConversationExtensionIds(conv.id);
      expect(ids).toContain(lessonsId);
      expect(ids).not.toContain(memoryId);
    }
  });

  test("skips a bundled name with no registry row at all", async () => {
    // Only memory-extractor is installed. `lessons-distiller` has no
    // row — a boot-order gap, not an operator choice — and must be a
    // silent skip rather than a throw.
    const memoryId = await seedBundled("memory-extractor", true);
    const conv1 = await createConversation(projectId);
    const conv2 = await createConversation(projectId);
    await getDb().delete(conversationExtensions);

    const inserted = await reconcileBundledConversationWiring();
    expect(inserted).toBe(2);

    for (const conv of [conv1, conv2]) {
      expect(await getConversationExtensionIds(conv.id)).toEqual([memoryId]);
    }
  });
});

// ── (c) Idempotency ──────────────────────────────────────────────────

describe("reconcileBundledConversationWiring — idempotent", () => {
  test("a second run inserts zero rows and leaves one row per pair", async () => {
    const lessonsId = await seedBundled("lessons-distiller", false);
    const memoryId = await seedBundled("memory-extractor", false);
    const conv = await createConversation(projectId);
    await getDb().update(extensions).set({ enabled: true });

    expect(await reconcileBundledConversationWiring()).toBe(2);
    expect(await reconcileBundledConversationWiring()).toBe(0);

    for (const extensionId of [lessonsId, memoryId]) {
      expect(await wiringRowCount(conv.id, extensionId)).toBe(1);
    }
  });

  test("a reconcile after the create-time hook already wired the conversation inserts nothing", async () => {
    await seedBundled("lessons-distiller", true);
    await seedBundled("memory-extractor", true);
    await createConversation(projectId);

    expect(await reconcileBundledConversationWiring()).toBe(0);
  });
});

// ── (e) Create-time hook ─────────────────────────────────────────────

describe("autoWireBundledExtensions — new conversations", () => {
  test("createConversation wires BOTH lessons-distiller and memory-extractor", async () => {
    const lessonsId = await seedBundled("lessons-distiller", true);
    const memoryId = await seedBundled("memory-extractor", true);

    const conv = await createConversation(projectId);
    const ids = await getConversationExtensionIds(conv.id);
    expect(ids).toContain(lessonsId);
    expect(ids).toContain(memoryId);
  });

  test("an explicit re-call is idempotent for both extensions", async () => {
    const lessonsId = await seedBundled("lessons-distiller", true);
    const memoryId = await seedBundled("memory-extractor", true);
    const conv = await createConversation(projectId);

    // The helper returns the count of rows it TRIED to insert (one per
    // bundled name); the conflict handler makes the second insert a
    // no-op at the DB layer.
    expect(await autoWireBundledExtensions(conv.id)).toBe(2);

    for (const extensionId of [lessonsId, memoryId]) {
      expect(await wiringRowCount(conv.id, extensionId)).toBe(1);
    }
  });

  test("createConversation wires nothing while the extensions are disabled", async () => {
    await seedBundled("lessons-distiller", false);
    await seedBundled("memory-extractor", false);

    const conv = await createConversation(projectId);
    expect(await getConversationExtensionIds(conv.id)).toEqual([]);
    expect(await autoWireBundledExtensions(conv.id)).toBe(0);
  });
});
