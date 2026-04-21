import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

// Guard against leaked settings mocks from parallel files.
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

import {
  insertAttachment,
  listAttachmentsForMessage,
  listAttachmentsForConversation,
  deleteAttachmentsForMessage,
  deleteAttachmentsForConversation,
} from "../db/queries/attachments";
import { createConversation, createMessage } from "../db/queries/conversations";
import { createProject } from "../db/queries/projects";

let projectId: string;
let conversationId: string;
let messageId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Attachments Test", path: "/tmp/att" });
  projectId = project.id;
  const conv = await createConversation(projectId, { title: "t" });
  conversationId = conv.id;
  const msg = await createMessage(conversationId, { role: "user", content: "hi" });
  messageId = msg.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("attachments queries", () => {
  test("insertAttachment round-trips a row with all fields", async () => {
    const row = await insertAttachment({
      messageId,
      conversationId,
      filename: "cat.png",
      mimeType: "image/png",
      sizeBytes: 1234,
      storagePath: "/tmp/att/cat.png",
      kind: "image",
    });
    expect(row.id).toBeDefined();
    expect(row.filename).toBe("cat.png");
    expect(row.mimeType).toBe("image/png");
    expect(row.sizeBytes).toBe(1234);
    expect(row.kind).toBe("image");
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  test("listAttachmentsForMessage returns inserted rows", async () => {
    await insertAttachment({
      messageId, conversationId,
      filename: "notes.txt", mimeType: "text/plain",
      sizeBytes: 10, storagePath: "/tmp/att/notes.txt", kind: "text",
    });
    const rows = await listAttachmentsForMessage(messageId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every(r => r.messageId === messageId)).toBe(true);
  });

  test("listAttachmentsForConversation returns rows across messages", async () => {
    const otherMsg = await createMessage(conversationId, { role: "user", content: "again" });
    await insertAttachment({
      messageId: otherMsg.id, conversationId,
      filename: "doc.pdf", mimeType: "application/pdf",
      sizeBytes: 50, storagePath: "/tmp/att/doc.pdf", kind: "pdf",
    });
    const rows = await listAttachmentsForConversation(conversationId);
    const msgIds = new Set(rows.map(r => r.messageId));
    expect(msgIds.has(messageId)).toBe(true);
    expect(msgIds.has(otherMsg.id)).toBe(true);
  });

  test("deleteAttachmentsForMessage removes only that message's rows", async () => {
    const other = await createMessage(conversationId, { role: "user", content: "3" });
    await insertAttachment({
      messageId: other.id, conversationId,
      filename: "a.png", mimeType: "image/png", sizeBytes: 1,
      storagePath: "/tmp/a.png", kind: "image",
    });
    const deleted = await deleteAttachmentsForMessage(other.id);
    expect(deleted.length).toBe(1);
    const remaining = await listAttachmentsForMessage(other.id);
    expect(remaining.length).toBe(0);
    const elsewhere = await listAttachmentsForMessage(messageId);
    expect(elsewhere.length).toBeGreaterThan(0);
  });

  test("deleteAttachmentsForConversation removes all rows for the conversation", async () => {
    const tempConv = await createConversation(projectId, { title: "temp" });
    const tempMsg = await createMessage(tempConv.id, { role: "user", content: "x" });
    await insertAttachment({
      messageId: tempMsg.id, conversationId: tempConv.id,
      filename: "x.txt", mimeType: "text/plain", sizeBytes: 1,
      storagePath: "/tmp/x.txt", kind: "text",
    });
    const deleted = await deleteAttachmentsForConversation(tempConv.id);
    expect(deleted.length).toBe(1);
    expect(await listAttachmentsForConversation(tempConv.id)).toEqual([]);
  });

  test("cascade: deleting conversation removes attachments via FK ON DELETE CASCADE", async () => {
    const c = await createConversation(projectId, { title: "cascade" });
    const m = await createMessage(c.id, { role: "user", content: "x" });
    await insertAttachment({
      messageId: m.id, conversationId: c.id,
      filename: "z.png", mimeType: "image/png", sizeBytes: 1,
      storagePath: "/tmp/z.png", kind: "image",
    });
    const { deleteConversation } = await import("../db/queries/conversations");
    await deleteConversation(c.id);
    expect(await listAttachmentsForConversation(c.id)).toEqual([]);
  });
});
