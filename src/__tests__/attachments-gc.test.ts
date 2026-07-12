import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, ADMIN_USER } from "./helpers/mock-request";

mockServerAlias();
mock.module("$server/db/queries/projects", () => require("../db/queries/projects"));
mock.module("$server/chat/attachments/storage", () => require("../chat/attachments/storage"));
mock.module("$server/auth/middleware", () => ({
  requireAuth: (_: any) => ADMIN_USER,
}));
mock.module("$lib/server/security/validation", () => ({
  validationError: () => new Response("", { status: 400 }),
}));
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

mockDbConnection();
mock.module("../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

let DELETE: any;
import { createProject } from "../db/queries/projects";
import { createConversation, createMessage } from "../db/queries/conversations";
import { insertAttachment, listAttachmentsForConversation } from "../db/queries/attachments";
import { writeAttachment } from "../chat/attachments/storage";

let projectRoot: string;
let projectId: string;

beforeAll(async () => {
  await setupTestDb();
  projectRoot = await mkdtemp(join(tmpdir(), "ezcorp-gc-"));
  const p = await createProject({ name: "GC Test", path: projectRoot });
  projectId = p.id;
  const mod = await import("../../web/src/routes/api/conversations/[id]/+server");
  DELETE = mod.DELETE;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
});

async function fileExists(p: string) {
  try { await access(p); return true; } catch { return false; }
}

describe("conversation delete → attachments GC (disk + DB)", () => {
  test("deleting a conversation removes both DB rows and disk files", async () => {
    const conv = await createConversation(projectId, {
      title: "doomed", provider: "anthropic", model: "claude-sonnet-4-5",
    });
    const msg = await createMessage(conv.id, { role: "user", content: "hi" });
    const bytes = new Uint8Array([1, 2, 3]);
    const written = await writeAttachment({
      projectRoot, conversationId: conv.id, messageId: msg.id,
      filename: "a.png", mimeType: "image/png", bytes,
    });
    await insertAttachment({
      messageId: msg.id, conversationId: conv.id,
      filename: "a.png", mimeType: "image/png", sizeBytes: bytes.byteLength,
      storagePath: written.storagePath, kind: "image",
    });

    expect(await fileExists(written.storagePath)).toBe(true);
    expect((await listAttachmentsForConversation(conv.id)).length).toBe(1);

    const res = await DELETE({
      params: { id: conv.id },
      locals: {} as any,
    } as any);
    expect(res.status).toBe(204);

    // DB rows cascaded via FK.
    expect((await listAttachmentsForConversation(conv.id)).length).toBe(0);
    // Disk files cleaned by the handler.
    expect(await fileExists(written.storagePath)).toBe(false);
  });
});
