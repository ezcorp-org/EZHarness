import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, ADMIN_USER } from "./helpers/mock-request";

// ── Mock server-side aliases used by the endpoint ───────────────────

mockServerAlias();

// Additional aliases this route uses that mockServerAlias() doesn't cover.
mock.module("$server/db/queries/attachments", () => require("../db/queries/attachments"));
mock.module("$server/db/queries/projects", () => require("../db/queries/projects"));
mock.module("$server/providers/model-capabilities", () => require("../providers/model-capabilities"));
mock.module("$server/chat/attachments/validator", () => require("../chat/attachments/validator"));
mock.module("$server/chat/attachments/storage", () => require("../chat/attachments/storage"));
mock.module("$server/chat/attachments/content-builder", () => require("../chat/attachments/content-builder"));

// Stubs for security + auth middleware that don't exist in src/ (they live in web/).
mock.module("$server/auth/middleware", () => ({
  requireAuth: (_locals: any) => ADMIN_USER,
}));
const streamChatCalls: any[] = [];
mock.module("$lib/server/context", () => ({
  getExecutor: () => ({
    streamChat: async (...args: any[]) => {
      streamChatCalls.push(args);
      return { id: "run-test", status: "success" } as any;
    },
  }),
  getBus: () => ({ emit: () => {}, on: () => () => {} }),
  getCommandRegistry: () => ({ listCommands: async () => [] }),
  ensureInitialized: async () => {},
}));
mock.module("$lib/server/security/validation", () => ({
  validationError: (err: any) => new Response(JSON.stringify({ error: err.issues ?? String(err) }), { status: 400 }),
}));
mock.module("$lib/server/security/resource-quotas", () => ({
  checkTokenBudget: async () => ({ allowed: true, resetsAt: null }),
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

// Import route handler AFTER all mocks (dynamic so ESM hoisting doesn't load it first).
let POST: any;
import * as convQueries from "../db/queries/conversations";
import { createProject } from "../db/queries/projects";
import { listAttachmentsForMessage } from "../db/queries/attachments";
import { attachmentsRoot } from "../chat/attachments/storage";

// ── Fixtures ────────────────────────────────────────────────────────

const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

let projectRoot: string;
let projectId: string;
let conversationId: string;

async function fileExists(p: string) {
  try { await access(p); return true; } catch { return false; }
}

function resetExecutorCalls() {
  streamChatCalls.length = 0;
}


beforeAll(async () => {
  await setupTestDb();
  projectRoot = await mkdtemp(join(tmpdir(), "ezcorp-mp-"));
  const project = await createProject({ name: "MP Test", path: projectRoot });
  projectId = project.id;
  const mod = await import("../../web/src/routes/api/conversations/[id]/messages/+server");
  POST = mod.POST;
});

beforeEach(async () => {
  resetExecutorCalls();
  const conv = await convQueries.createConversation(projectId, {
    title: "c", provider: "anthropic", model: "claude-3-5-sonnet-20241022",
  });
  conversationId = conv.id;
  // ADMIN_USER has role "admin" which bypasses ownership check in verifyConversationOwnership.
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
});

function buildMultipartRequest(fields: Record<string, string>, files: Array<{ name: string; type: string; bytes: Uint8Array }>): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  for (const f of files) form.append("files", new File([f.bytes as BlobPart], f.name, { type: f.type }));
  return new Request(`http://localhost/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: form,
  });
}

function buildJsonRequest(body: unknown): Request {
  return new Request(`http://localhost/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function invokePost(req: Request): Promise<Response> {
  return POST({
    request: req,
    params: { id: conversationId },
    locals: {} as any,
  } as any);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("POST /api/conversations/:id/messages (multi-modal)", () => {
  test("JSON-only legacy path still works (regression guard)", async () => {
    const res = await invokePost(buildJsonRequest({ content: "hello" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userMessage.content).toBe("hello");
    expect(body.attachments ?? []).toEqual([]);
    const calls = streamChatCalls;
    expect(calls.length).toBe(1);
    expect(calls[0][2].attachments).toBeUndefined();
  });

  test("multipart with a valid PNG → DB row + disk file + streamChat gets attachments", async () => {
    const req = buildMultipartRequest(
      { content: "look at this", provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
      [{ name: "cat.png", type: "image/png", bytes: PNG_1x1 }],
    );
    const res = await invokePost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userMessage.content).toBe("look at this");
    expect(body.attachments.length).toBe(1);
    expect(body.attachments[0].mimeType).toBe("image/png");

    const rows = await listAttachmentsForMessage(body.userMessage.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("image");
    expect(rows[0]!.storagePath).toContain(attachmentsRoot(projectRoot));
    expect(await fileExists(rows[0]!.storagePath)).toBe(true);

    const calls = streamChatCalls;
    expect(calls.length).toBe(1);
    const passedOpts = calls[0][2];
    expect(passedOpts.attachments).toBeDefined();
    expect(passedOpts.attachments.length).toBe(1);
    expect(passedOpts.attachments[0].mimeType).toBe("image/png");
  });

  test("multipart with text file → TextContent-style persistence", async () => {
    const req = buildMultipartRequest(
      { content: "summarize", provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
      [{ name: "notes.txt", type: "text/plain", bytes: new TextEncoder().encode("line one") }],
    );
    const res = await invokePost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attachments[0].mimeType).toBe("text/plain");
    const rows = await listAttachmentsForMessage(body.userMessage.id);
    expect(rows[0]!.kind).toBe("text");
  });

  test("incompatible model (text-only) with an image → 400, no DB/disk side effects", async () => {
    const req = buildMultipartRequest(
      { content: "x", provider: "custom-provider", model: "local-text-only-model" },
      [{ name: "cat.png", type: "image/png", bytes: PNG_1x1 }],
    );
    const res = await invokePost(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("MIME_NOT_ALLOWED");
    // No user message created for this conv because validation happens pre-persist.
    const msgs = await convQueries.getMessages(conversationId);
    expect(msgs.length).toBe(0);
    expect(streamChatCalls.length).toBe(0);
  });

  test("oversized file → 413", async () => {
    const huge = new Uint8Array(33 * 1024 * 1024 + 1);
    huge.set(PNG_1x1, 0);
    const req = buildMultipartRequest(
      { content: "x", provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
      [{ name: "big.png", type: "image/png", bytes: huge }],
    );
    const res = await invokePost(req);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe("TOO_LARGE");
  });

  test("MIME/magic-byte mismatch → 400", async () => {
    const req = buildMultipartRequest(
      { content: "x", provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
      [{ name: "fake.png", type: "image/png", bytes: new TextEncoder().encode("plain text bytes") }],
    );
    const res = await invokePost(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("MIME_MISMATCH");
    expect(body.file).toBe("fake.png");
  });

  test("attachments array is empty in JSON path (forward-compat)", async () => {
    const res = await invokePost(buildJsonRequest({ content: "hi" }));
    const body = await res.json();
    expect(body.attachments).toEqual([]);
  });

  test("POST response includes AttachmentSummary with id + kind and no storagePath leak", async () => {
    const req = buildMultipartRequest(
      { content: "shape check", provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
      [{ name: "cat.png", type: "image/png", bytes: PNG_1x1 }],
    );
    const res = await invokePost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attachments.length).toBe(1);
    const a = body.attachments[0];
    expect(typeof a.id).toBe("string");
    expect(a.id.length).toBeGreaterThan(0);
    expect(a.filename).toBe("cat.png");
    expect(a.mimeType).toBe("image/png");
    expect(a.kind).toBe("image");
    expect(typeof a.sizeBytes).toBe("number");
    expect(a.storagePath).toBeUndefined();

    // Also embedded on userMessage so optimistic replacement carries cards.
    expect(body.userMessage.attachments).toBeDefined();
    expect(body.userMessage.attachments[0].id).toBe(a.id);
    expect(body.userMessage.attachments[0].storagePath).toBeUndefined();

    // Defensive: no storagePath anywhere in the JSON stringified response.
    expect(JSON.stringify(body)).not.toContain("/tmp/");
    expect(JSON.stringify(body)).not.toContain(".ezcorp/attachments");
  });

  test("POST with multiple images returns one summary per file, stable order", async () => {
    const req = buildMultipartRequest(
      { content: "two", provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
      [
        { name: "a.png", type: "image/png", bytes: PNG_1x1 },
        { name: "b.png", type: "image/png", bytes: PNG_1x1 },
      ],
    );
    const res = await invokePost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attachments.length).toBe(2);
    expect(body.attachments[0].filename).toBe("a.png");
    expect(body.attachments[1].filename).toBe("b.png");
    expect(body.attachments[0].id).not.toBe(body.attachments[1].id);
  });

});
