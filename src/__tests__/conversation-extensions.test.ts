import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
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

import {
  addConversationExtensions,
  getConversationExtensionIds,
} from "../db/queries/conversation-extensions";
import { createConversation } from "../db/queries/conversations";
import { createProject } from "../db/queries/projects";
import { createExtension } from "../db/queries/extensions";

// Minimal manifest stub required by the schema's jsonb type
const stubManifest = {
  schemaVersion: "v2" as const,
  id: "test-ext",
  name: "Test Extension",
  version: "1.0.0",
  description: "",
  permissions: {},
  tools: [],
};

async function makeExtension(nameSuffix: string) {
  return createExtension({
    name: `test-ext-${nameSuffix}`,
    version: "1.0.0",
    description: "Test extension",
    manifest: stubManifest as any,
    source: "local",
    installPath: `/tmp/ext-${nameSuffix}`,
    enabled: true,
    grantedPermissions: {} as any,
    checksumVerified: false,
    consecutiveFailures: 0,
  });
}

let projectId: string;
let convId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Ext Test Project", path: "/tmp/ext-test" });
  projectId = project.id;
  const conv = await createConversation(projectId);
  convId = conv.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

// ── getConversationExtensionIds ───────────────────────────────────────

describe("getConversationExtensionIds", () => {
  test("returns empty array for conversation with no extensions", async () => {
    const conv = await createConversation(projectId);
    const ids = await getConversationExtensionIds(conv.id);
    expect(ids).toEqual([]);
  });

  test("returns empty array for nonexistent conversation id", async () => {
    const ids = await getConversationExtensionIds("00000000-0000-0000-0000-000000000000");
    expect(ids).toEqual([]);
  });
});

// ── addConversationExtensions ─────────────────────────────────────────

describe("addConversationExtensions", () => {
  test("adds a single extension to a conversation", async () => {
    const conv = await createConversation(projectId);
    const ext = await makeExtension("single-" + Date.now());

    await addConversationExtensions(conv.id, [{ extensionId: ext.id }]);

    const ids = await getConversationExtensionIds(conv.id);
    expect(ids).toContain(ext.id);
    expect(ids.length).toBe(1);
  });

  test("adds multiple extensions in one call", async () => {
    const conv = await createConversation(projectId);
    const ext1 = await makeExtension("multi1-" + Date.now());
    const ext2 = await makeExtension("multi2-" + Date.now());

    await addConversationExtensions(conv.id, [
      { extensionId: ext1.id },
      { extensionId: ext2.id },
    ]);

    const ids = await getConversationExtensionIds(conv.id);
    expect(ids).toContain(ext1.id);
    expect(ids).toContain(ext2.id);
    expect(ids.length).toBe(2);
  });

  test("is idempotent — duplicate insert does not throw or duplicate", async () => {
    const conv = await createConversation(projectId);
    const ext = await makeExtension("idem-" + Date.now());

    await addConversationExtensions(conv.id, [{ extensionId: ext.id }]);
    // Insert same extension again — should be silently ignored (onConflictDoNothing)
    await addConversationExtensions(conv.id, [{ extensionId: ext.id }]);

    const ids = await getConversationExtensionIds(conv.id);
    expect(ids.filter(id => id === ext.id).length).toBe(1);
  });

  test("no-ops when entries array is empty", async () => {
    const conv = await createConversation(projectId);

    await addConversationExtensions(conv.id, []);

    const ids = await getConversationExtensionIds(conv.id);
    expect(ids).toEqual([]);
  });

  test("associates extensions with the correct conversation only", async () => {
    const conv1 = await createConversation(projectId);
    const conv2 = await createConversation(projectId);
    const ext = await makeExtension("isolation-" + Date.now());

    await addConversationExtensions(conv1.id, [{ extensionId: ext.id }]);

    const ids1 = await getConversationExtensionIds(conv1.id);
    const ids2 = await getConversationExtensionIds(conv2.id);

    expect(ids1).toContain(ext.id);
    expect(ids2).not.toContain(ext.id);
  });

  test("stores messageId when provided", async () => {
    const conv = await createConversation(projectId);
    const ext = await makeExtension("msgid-" + Date.now());

    // Insert a message to reference
    const { getDb } = await import("../db/connection");
    const { messages } = await import("../db/schema");
    const msgRows = await getDb().insert(messages).values({
      conversationId: conv.id,
      role: "user",
      content: "test message",
    }).returning();
    const messageId = msgRows[0]!.id;

    await addConversationExtensions(conv.id, [{ extensionId: ext.id, messageId }]);

    // Verify it was stored with the messageId
    const { conversationExtensions } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await getDb()
      .select()
      .from(conversationExtensions)
      .where(eq(conversationExtensions.conversationId, conv.id));

    expect(rows.length).toBe(1);
    expect(rows[0]!.addedByMessageId).toBe(messageId);
    expect(rows[0]!.extensionId).toBe(ext.id);
  });

  test("accumulates extensions across multiple calls", async () => {
    const conv = await createConversation(projectId);
    const ext1 = await makeExtension("accum1-" + Date.now());
    const ext2 = await makeExtension("accum2-" + Date.now());

    await addConversationExtensions(conv.id, [{ extensionId: ext1.id }]);
    await addConversationExtensions(conv.id, [{ extensionId: ext2.id }]);

    const ids = await getConversationExtensionIds(conv.id);
    expect(ids).toContain(ext1.id);
    expect(ids).toContain(ext2.id);
    expect(ids.length).toBe(2);
  });
});

// ── remove via cascade ────────────────────────────────────────────────

describe("cascade deletion", () => {
  test("conversation deletion cascades to remove its extensions", async () => {
    const conv = await createConversation(projectId);
    const ext = await makeExtension("cascade-" + Date.now());

    await addConversationExtensions(conv.id, [{ extensionId: ext.id }]);
    const before = await getConversationExtensionIds(conv.id);
    expect(before).toContain(ext.id);

    // Delete the conversation
    const { getDb } = await import("../db/connection");
    const { conversations } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    await getDb().delete(conversations).where(eq(conversations.id, conv.id));

    // Extensions for that conversation are gone
    const after = await getConversationExtensionIds(conv.id);
    expect(after).toEqual([]);
  });
});
