/**
 * Integration: /api/attachments/[id] writes an `attachment:admin_read` audit
 * entry exactly when an admin reads a conversation they don't own.
 * Owner self-reads, non-owner 404s, and admin self-reads stay unlogged
 * to keep the audit log focused on cross-user privileged access.
 */

import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent } from "./helpers/mock-request";

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
import { createConversation, createMessage } from "../db/queries/conversations";
import { insertAttachment } from "../db/queries/attachments";
import { listAuditLog } from "../db/queries/audit-log";
import { getDb } from "../db/connection";
import { users } from "../db/schema";

const BYTES = new TextEncoder().encode("AUDIT-BYTES");

let ownerId = "";
let memberId = "";
let adminId = "";
let ownerAttId = "";
let adminAttId = "";
let ownerConvId = "";
let tmpRoot = "";

beforeAll(async () => {
  await setupTestDb();
  tmpRoot = await mkdtemp(join(tmpdir(), "ezcorp-audit-"));

  const [owner] = await getDb().insert(users).values({
    email: "owner@audit.local", passwordHash: "x", name: "Owner", role: "member",
  }).returning();
  const [member] = await getDb().insert(users).values({
    email: "member@audit.local", passwordHash: "x", name: "Member", role: "member",
  }).returning();
  const [admin] = await getDb().insert(users).values({
    email: "admin@audit.local", passwordHash: "x", name: "Admin", role: "admin",
  }).returning();
  ownerId = owner!.id;
  memberId = member!.id;
  adminId = admin!.id;

  const project = await createProject({ name: "Audit", path: tmpRoot });

  // Owner's conversation + attachment.
  const ownerConv = await createConversation(project.id, { title: "owner-conv", userId: ownerId });
  ownerConvId = ownerConv.id;
  const ownerMsg = await createMessage(ownerConv.id, { role: "user", content: "hi" });
  const ownerDir = join(tmpRoot, ".ezcorp", "attachments", ownerConv.id, ownerMsg.id);
  await mkdir(ownerDir, { recursive: true });
  const ownerPath = join(ownerDir, "owner.png");
  await writeFile(ownerPath, BYTES);
  const ownerRow = await insertAttachment({
    messageId: ownerMsg.id, conversationId: ownerConv.id,
    filename: "owner.png", mimeType: "image/png",
    sizeBytes: BYTES.byteLength, storagePath: ownerPath, kind: "image",
  });
  ownerAttId = ownerRow.id;

  // Admin's own conversation + attachment (for the self-read case).
  const adminConv = await createConversation(project.id, { title: "admin-conv", userId: adminId });
  const adminMsg = await createMessage(adminConv.id, { role: "user", content: "hi" });
  const adminDir = join(tmpRoot, ".ezcorp", "attachments", adminConv.id, adminMsg.id);
  await mkdir(adminDir, { recursive: true });
  const adminPath = join(adminDir, "admin.png");
  await writeFile(adminPath, BYTES);
  const adminRow = await insertAttachment({
    messageId: adminMsg.id, conversationId: adminConv.id,
    filename: "admin.png", mimeType: "image/png",
    sizeBytes: BYTES.byteLength, storagePath: adminPath, kind: "image",
  });
  adminAttId = adminRow.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

function mkEvent(id: string, user: { id: string; role: "member" | "admin" } | undefined) {
  return createMockEvent({
    url: `http://localhost/api/attachments/${id}`,
    params: { id },
    user: user
      ? { id: user.id, email: `${user.id}@x`, name: user.id, role: user.role }
      : undefined,
  });
}

async function adminReadCount(): Promise<number> {
  const rows = await listAuditLog({ action: "attachment:admin_read", limit: 1000 });
  return rows.length;
}

describe("attachment:admin_read audit log", () => {
  test("admin reads someone else's attachment → audit row with populated metadata, 200 body still returned", async () => {
    const before = await adminReadCount();
    const res = await getAttachment(mkEvent(ownerAttId, { id: adminId, role: "admin" }));
    expect(res.status).toBe(200);

    const rows = await listAuditLog({ action: "attachment:admin_read", limit: 1000 });
    expect(rows.length).toBe(before + 1);

    const entry = rows.find((r) => r.target === ownerAttId);
    expect(entry).toBeDefined();
    expect(entry!.userId).toBe(adminId);
    expect(entry!.target).toBe(ownerAttId);
    const meta = entry!.metadata as Record<string, unknown>;
    expect(meta.conversationId).toBe(ownerConvId);
    expect(meta.ownerId).toBe(ownerId);
    expect(meta.filename).toBe("owner.png");
  });

  test("owner reads their own attachment → admin_read audit count unchanged", async () => {
    const before = await adminReadCount();
    const res = await getAttachment(mkEvent(ownerAttId, { id: ownerId, role: "member" }));
    expect(res.status).toBe(200);
    const after = await adminReadCount();
    expect(after).toBe(before);
  });

  test("non-owner member hits the 404 path → admin_read audit count unchanged", async () => {
    const before = await adminReadCount();
    const res = await getAttachment(mkEvent(ownerAttId, { id: memberId, role: "member" }));
    expect(res.status).toBe(404);
    const after = await adminReadCount();
    expect(after).toBe(before);
  });

  test("admin reads their OWN attachment → admin_read audit count unchanged (not a cross-user read)", async () => {
    const before = await adminReadCount();
    const res = await getAttachment(mkEvent(adminAttId, { id: adminId, role: "admin" }));
    expect(res.status).toBe(200);
    const after = await adminReadCount();
    expect(after).toBe(before);
  });
});
