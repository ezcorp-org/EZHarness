import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, ADMIN_USER, MEMBER_USER } from "./helpers/mock-request";

mockServerAlias();

// Route imports the $server aliases for attachments + conversations queries.
mock.module("$server/db/queries/attachments", () => require("../db/queries/attachments"));

// Stub $types so bun can resolve the handler module (same pattern as ext-files-route.test.ts).
mock.module("../../web/src/routes/api/attachments/[id]/$types", () => ({}));

// Auth: requireAuth returns whatever user locals carries; tests drive identity via mkEvent.
mock.module("$server/auth/middleware", () => ({
  requireAuth: (locals: any) => {
    if (!locals?.user) {
      const res = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      throw res;
    }
    return locals.user;
  },
}));
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

mockDbConnection();

// Real DB-backed settings (prevents leaked settings mocks).
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

import { GET } from "../../web/src/routes/api/attachments/[id]/+server";
import { createProject } from "../db/queries/projects";
import { createConversation, createMessage } from "../db/queries/conversations";
import { insertAttachment } from "../db/queries/attachments";
import { getDb } from "../db/connection";
import { users } from "../db/schema";

const IMG_BYTES = new TextEncoder().encode("IMG-BYTES-HERE");
let OWNER_ID = "";

let projectRoot: string;
let attachmentId: string;
let storagePath: string;

beforeAll(async () => {
  await setupTestDb();
  const [owner] = await getDb().insert(users).values({
    email: "owner@test.local",
    passwordHash: "x",
    name: "Owner",
    role: "member",
  }).returning();
  OWNER_ID = owner!.id;
});

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "ezcorp-att-"));
  const project = await createProject({ name: "Serve Test", path: projectRoot });
  const conv = await createConversation(project.id, { title: "c", userId: OWNER_ID });
  const msg = await createMessage(conv.id, { role: "user", content: "hi" });
  const dir = join(projectRoot, ".ezcorp", "attachments", conv.id, msg.id);
  await mkdir(dir, { recursive: true });
  storagePath = join(dir, "file.png");
  await writeFile(storagePath, IMG_BYTES);
  const row = await insertAttachment({
    messageId: msg.id,
    conversationId: conv.id,
    filename: "cat.png",
    mimeType: "image/png",
    sizeBytes: IMG_BYTES.byteLength,
    storagePath,
    kind: "image",
  });
  attachmentId = row.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
});

function mkEvent(id: string, user: any, query = "") {
  return createMockEvent({
    url: `http://localhost/api/attachments/${id}${query}`,
    params: { id },
    user,
  });
}

describe("GET /api/attachments/[id]", () => {
  test("serves the bytes with correct content-type for the owner", async () => {
    const res = await GET(mkEvent(attachmentId, { ...MEMBER_USER, id: OWNER_ID }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Length")).toBe(String(IMG_BYTES.byteLength));
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe("IMG-BYTES-HERE");
  });

  test("returns 404 for a non-owner, non-admin user", async () => {
    const res = await GET(mkEvent(attachmentId, { ...MEMBER_USER, id: "other-user" }));
    expect(res.status).toBe(404);
  });

  test("admin bypasses the ownership check", async () => {
    const res = await GET(mkEvent(attachmentId, ADMIN_USER));
    expect(res.status).toBe(200);
  });

  test("returns 404 for an unknown attachment id", async () => {
    const res = await GET(mkEvent("00000000-0000-0000-0000-000000000000", { ...MEMBER_USER, id: OWNER_ID }));
    expect(res.status).toBe(404);
  });

  test("default Content-Disposition is inline; ?download=1 forces attachment", async () => {
    const inline = await GET(mkEvent(attachmentId, { ...MEMBER_USER, id: OWNER_ID }));
    expect(inline.headers.get("Content-Disposition")).toBe("inline");
    const dl = await GET(mkEvent(attachmentId, { ...MEMBER_USER, id: OWNER_ID }, "?download=1"));
    const cd = dl.headers.get("Content-Disposition") ?? "";
    expect(cd).toContain('attachment');
    expect(cd).toContain('filename="cat.png"');
  });

  test("Cache-Control is private + immutable", async () => {
    const res = await GET(mkEvent(attachmentId, { ...MEMBER_USER, id: OWNER_ID }));
    const cc = res.headers.get("Cache-Control") ?? "";
    expect(cc).toContain("private");
    expect(cc).toContain("immutable");
  });

  test("returns 404 when the backing file is missing on disk", async () => {
    await rm(storagePath, { force: true });
    const res = await GET(mkEvent(attachmentId, { ...MEMBER_USER, id: OWNER_ID }));
    expect(res.status).toBe(404);
  });

  test("returns 401 for unauthenticated requests", async () => {
    try {
      await GET(mkEvent(attachmentId, undefined));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(401);
    }
  });
});
