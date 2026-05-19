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
    async upsertSetting() {},
    async deleteSetting() { return false; },
    async isListingInstalled() { return false; },
  };
});

mockDbConnection();

import { createConversation, createMessage, getMessages, getConversationPath } from "../db/queries/conversations";
import { insertAttachment } from "../db/queries/attachments";
import { createProject } from "../db/queries/projects";

let conversationId: string;
let msgA: string;
let msgB: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Hydration Test", path: "/tmp/hydr" });
  const conv = await createConversation(project.id, { title: "c" });
  conversationId = conv.id;

  const a = await createMessage(conversationId, { role: "user", content: "msg A" });
  const b = await createMessage(conversationId, { role: "user", content: "msg B", parentMessageId: a.id });
  msgA = a.id;
  msgB = b.id;

  await insertAttachment({
    messageId: msgA, conversationId,
    filename: "cat.png", mimeType: "image/png", sizeBytes: 12,
    storagePath: "/tmp/hydr/cat.png", kind: "image",
  });
  await insertAttachment({
    messageId: msgA, conversationId,
    filename: "notes.txt", mimeType: "text/plain", sizeBytes: 34,
    storagePath: "/tmp/hydr/notes.txt", kind: "text",
  });
  // msgB intentionally has no attachments.
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("message attachment hydration", () => {
  test("getMessages hydrates attachments on the correct message only", async () => {
    const msgs = await getMessages(conversationId);
    const a = msgs.find((m) => m.id === msgA)!;
    const b = msgs.find((m) => m.id === msgB)!;
    expect(a.attachments).toBeDefined();
    expect(a.attachments!.length).toBe(2);
    expect(b.attachments).toBeUndefined();
  });

  test("getConversationPath hydrates attachments", async () => {
    const path = await getConversationPath(msgB, conversationId);
    const a = path.find((m) => m.id === msgA)!;
    expect(a.attachments).toBeDefined();
    expect(a.attachments!.length).toBe(2);
    const filenames = a.attachments!.map((x) => x.filename).sort();
    expect(filenames).toEqual(["cat.png", "notes.txt"]);
  });

  test("attachments never leak storagePath or conversationId to callers", async () => {
    const msgs = await getMessages(conversationId);
    const a = msgs.find((m) => m.id === msgA)!;
    for (const att of a.attachments ?? []) {
      expect((att as any).storagePath).toBeUndefined();
      expect((att as any).conversationId).toBeUndefined();
      expect(att.id).toBeDefined();
      expect(att.filename).toBeDefined();
      expect(att.mimeType).toBeDefined();
      expect(att.sizeBytes).toBeDefined();
      expect(att.kind).toBeDefined();
    }
  });

  test("empty attachment set leaves messages unchanged", async () => {
    const tempConv = await createConversation((await createProject({ name: "empty", path: "/tmp/empty" })).id, { title: "e" });
    const m = await createMessage(tempConv.id, { role: "user", content: "no-att" });
    const msgs = await getMessages(tempConv.id);
    expect(msgs.find((x) => x.id === m.id)?.attachments).toBeUndefined();
  });
});
