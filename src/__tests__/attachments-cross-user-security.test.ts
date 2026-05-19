/**
 * Integration: attachments uploaded by user A must not be readable by user B,
 * either via the byte-serving route or via the conversation's message-list
 * hydration. Admin still bypasses. Missing ownership (userId=null) → admin only.
 */

import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, ADMIN_USER } from "./helpers/mock-request";

mockServerAlias();
mock.module("$server/db/queries/attachments", () => require("../db/queries/attachments"));
mock.module("../../web/src/routes/api/attachments/[id]/$types", () => ({}));
mock.module("$server/auth/middleware", () => ({
  requireAuth: (locals: any) => {
    if (!locals?.user) {
      const res = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      throw res;
    }
    return locals.user;
  },
}));
mock.module("$lib/server/security/api-keys", () => ({ requireScope: () => null }));

mockDbConnection();
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

import { GET as getAttachment } from "../../web/src/routes/api/attachments/[id]/+server";
import { createProject } from "../db/queries/projects";
import { createConversation, createMessage, getMessages } from "../db/queries/conversations";
import { insertAttachment } from "../db/queries/attachments";
import { getDb } from "../db/connection";
import { users } from "../db/schema";

const BYTES = new TextEncoder().encode("SECRET-BYTES");

let userAId = "";
let userBId = "";
let attachmentId = "";
let convAId = "";
let convBId = "";
let unownedAttId = "";
let tmpRoot = "";

beforeAll(async () => {
  await setupTestDb();
  tmpRoot = await mkdtemp(join(tmpdir(), "ezcorp-xuser-"));

  const [a] = await getDb().insert(users).values({
    email: "a@test.local", passwordHash: "x", name: "A", role: "member",
  }).returning();
  const [b] = await getDb().insert(users).values({
    email: "b@test.local", passwordHash: "x", name: "B", role: "member",
  }).returning();
  userAId = a!.id;
  userBId = b!.id;

  const project = await createProject({ name: "XUser", path: tmpRoot });

  // User A's private conversation + attachment.
  const convA = await createConversation(project.id, { title: "A-conv", userId: userAId });
  convAId = convA.id;
  const msgA = await createMessage(convA.id, { role: "user", content: "hi" });
  const dirA = join(tmpRoot, ".ezcorp", "attachments", convA.id, msgA.id);
  await mkdir(dirA, { recursive: true });
  const filePathA = join(dirA, "secret.png");
  await writeFile(filePathA, BYTES);
  const rowA = await insertAttachment({
    messageId: msgA.id, conversationId: convA.id,
    filename: "secret.png", mimeType: "image/png",
    sizeBytes: BYTES.byteLength, storagePath: filePathA, kind: "image",
  });
  attachmentId = rowA.id;

  // User B's conversation (unrelated, just needs to exist).
  const convB = await createConversation(project.id, { title: "B-conv", userId: userBId });
  convBId = convB.id;

  // Unowned conversation (userId=null) — admin only.
  const convUnowned = await createConversation(project.id, { title: "U-conv" });
  const msgU = await createMessage(convUnowned.id, { role: "user", content: "u" });
  const dirU = join(tmpRoot, ".ezcorp", "attachments", convUnowned.id, msgU.id);
  await mkdir(dirU, { recursive: true });
  const filePathU = join(dirU, "u.png");
  await writeFile(filePathU, BYTES);
  const rowU = await insertAttachment({
    messageId: msgU.id, conversationId: convUnowned.id,
    filename: "u.png", mimeType: "image/png",
    sizeBytes: BYTES.byteLength, storagePath: filePathU, kind: "image",
  });
  unownedAttId = rowU.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

function mkEvent(id: string, userId: string | null, role: "member" | "admin" = "member") {
  return createMockEvent({
    url: `http://localhost/api/attachments/${id}`,
    params: { id },
    user: userId ? { id: userId, email: `${userId}@x`, name: userId, role } : undefined,
  });
}

describe("cross-user attachment access", () => {
  test("owner A can fetch their attachment bytes", async () => {
    const res = await getAttachment(mkEvent(attachmentId, userAId));
    expect(res.status).toBe(200);
  });

  test("non-owner B gets 404 when fetching A's attachment bytes (does not leak existence)", async () => {
    const res = await getAttachment(mkEvent(attachmentId, userBId));
    expect(res.status).toBe(404);
  });

  test("admin can fetch any attachment, including cross-user", async () => {
    const res = await getAttachment(mkEvent(attachmentId, ADMIN_USER.id, "admin"));
    expect(res.status).toBe(200);
  });

  test("unowned (null userId) attachment → member gets 404, admin gets 200", async () => {
    const memberRes = await getAttachment(mkEvent(unownedAttId, userAId));
    expect(memberRes.status).toBe(404);
    const adminRes = await getAttachment(mkEvent(unownedAttId, ADMIN_USER.id, "admin"));
    expect(adminRes.status).toBe(200);
  });

  test("A's messages hydrate attachments; B's messages do not leak A's attachment ids", async () => {
    // Positive: A's conversation hydrates correctly.
    const aMsgs = await getMessages(convAId);
    const aHasAttachment = aMsgs.some((m) => (m.attachments ?? []).some((x) => x.id === attachmentId));
    expect(aHasAttachment).toBe(true);

    // Negative: B's own conversation obviously doesn't contain A's attachment.
    const bMsgs = await getMessages(convBId);
    const bLeak = bMsgs.some((m) => (m.attachments ?? []).some((x) => x.id === attachmentId));
    expect(bLeak).toBe(false);
  });

  test("hydrated attachments never include storagePath even for the rightful owner", async () => {
    const aMsgs = await getMessages(convAId);
    for (const m of aMsgs) {
      for (const att of m.attachments ?? []) {
        expect((att as any).storagePath).toBeUndefined();
      }
    }
  });
});
