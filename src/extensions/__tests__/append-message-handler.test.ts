// Unit tests for src/extensions/append-message-handler.ts.
//
// Mirror the storage-handler-coverage / emit-task-event-handler test
// pattern: real PGlite + drizzle, mock only db/connection. Verifies
// the full enforcement ladder + the happy-path side effects (message
// row, tool_calls rows, attachment reattribution).

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mock } from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "../../__tests__/helpers/test-pglite";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";

mock.module("../../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized — call setupTestDb() first");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

const { handleAppendMessageRpc } = await import("../append-message-handler");
const { getDb } = await import("../../db/connection");
const {
  conversations,
  projects,
  conversationExtensions,
  users,
  messages,
  messageAttachments,
  extensions: extensionsTable,
  toolCalls,
} = await import("../../db/schema");
const { eq, and, asc } = await import("drizzle-orm");

import type { JsonRpcRequest } from "../types";
import type { AppendMessageContext } from "../append-message-handler";
import type { ExtensionPermissions } from "../types";

// ── Fixtures ─────────────────────────────────────────────────────────

const EXT_WIRED = "ext-am-wired";
const EXT_UNWIRED = "ext-am-unwired";
const CONV_WIRED = "conv-am-wired";
const OTHER_CONV = "conv-am-other";
const PROJECT = "proj-am";
const USER = "user-am";

function makePerms(append = true): ExtensionPermissions {
  const perms: ExtensionPermissions = { grantedAt: {} };
  if (append) perms.appendMessages = { excludedDefault: true };
  return perms;
}

function makeCtx(overrides: Partial<AppendMessageContext> = {}): AppendMessageContext {
  return {
    conversationId: overrides.conversationId ?? CONV_WIRED,
    userId: overrides.userId ?? USER,
    grantedPermissions: overrides.grantedPermissions ?? makePerms(true),
  };
}

function rpc(params: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ezcorp/append-message", params };
}

async function ensureExtension(id: string): Promise<void> {
  await getDb().insert(extensionsTable).values({
    id,
    name: id,
    version: "1.0.0",
    description: "test",
    manifest: { schemaVersion: 2, name: id, version: "1.0.0", description: "t", author: { name: "t" }, permissions: {} },
    source: `test:${id}`,
    installPath: `/tmp/${id}`,
    enabled: true,
  } as any).onConflictDoNothing();
}

async function wireExtension(convId: string, extId: string): Promise<void> {
  await ensureExtension(extId);
  await getDb().insert(conversationExtensions).values({
    conversationId: convId,
    extensionId: extId,
  } as any).onConflictDoNothing();
}

async function insertParentMessage(convId: string): Promise<string> {
  const rows = await getDb().insert(messages).values({
    conversationId: convId,
    role: "user",
    content: "parent",
  } as any).returning();
  return rows[0]!.id;
}

async function insertAttachment(opts: { conversationId: string; messageId: string }): Promise<string> {
  const rows = await getDb().insert(messageAttachments).values({
    conversationId: opts.conversationId,
    messageId: opts.messageId,
    filename: "x.wav",
    mimeType: "audio/wav",
    sizeBytes: 1024,
    storagePath: "/tmp/x.wav",
    kind: "audio",
  } as any).returning();
  return rows[0]!.id;
}

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values({
    id: USER,
    email: `${USER}@t.local`,
    passwordHash: "x",
    name: USER,
  } as any).onConflictDoNothing();
  await getDb().insert(projects).values({ id: PROJECT, name: PROJECT, path: `/tmp/${PROJECT}` } as any);
  await getDb().insert(conversations).values({ id: CONV_WIRED, projectId: PROJECT, title: "wired", userId: USER } as any);
  await getDb().insert(conversations).values({ id: OTHER_CONV, projectId: PROJECT, title: "other", userId: USER } as any);
  await wireExtension(CONV_WIRED, EXT_WIRED);
  await ensureExtension(EXT_UNWIRED);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

// ── Tests ──────────────────────────────────────────────────────────

describe("append-message — permission gate", () => {
  test("appendMessages NOT granted → -32001", async () => {
    const parent = await insertParentMessage(CONV_WIRED);
    const resp = await handleAppendMessageRpc(
      EXT_WIRED,
      rpc({ parentMessageId: parent, role: "extension", content: "hi" }),
      makeCtx({ grantedPermissions: makePerms(false) }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toMatch(/appendMessages/);
  });

  test("kill-switch (EZCORP_DISABLE_CAPABILITY_TOOLS=1) → -32001", async () => {
    process.env.EZCORP_DISABLE_CAPABILITY_TOOLS = "1";
    try {
      const parent = await insertParentMessage(CONV_WIRED);
      const resp = await handleAppendMessageRpc(
        EXT_WIRED,
        rpc({ parentMessageId: parent, role: "extension", content: "hi" }),
        makeCtx(),
      );
      expect(resp.error?.code).toBe(-32001);
    } finally {
      delete process.env.EZCORP_DISABLE_CAPABILITY_TOOLS;
    }
  });
});

describe("append-message — scope/wiring gates", () => {
  test('conversationId="unknown" → -32602', async () => {
    const resp = await handleAppendMessageRpc(
      EXT_WIRED,
      rpc({ parentMessageId: "x", role: "extension", content: "hi" }),
      makeCtx({ conversationId: "unknown" }),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test('ctx.conversationId="unknown" + params.conversationId="<real>" → falls back to params (event-driven path)', async () => {
    // Event-driven invocations (messageToolbar contributions) carry
    // conversationId in the inbound bus event's params, not on the
    // executor's per-turn ctx. The handler must accept the params
    // value when ctx is unbound — wiring + cross-conversation
    // defenses still apply, so accepting it doesn't widen trust.
    const parent = await insertParentMessage(CONV_WIRED);
    const resp = await handleAppendMessageRpc(
      EXT_WIRED,
      rpc({
        parentMessageId: parent,
        role: "extension",
        content: "fallback-test",
        conversationId: CONV_WIRED, // params carries real id
      }, "fb-1"),
      makeCtx({ conversationId: "unknown" }), // ctx is unbound
    );
    expect(resp.error).toBeUndefined();
    const result = resp.result as { messageId: string };
    expect(typeof result.messageId).toBe("string");

    // Verify the row landed in the params-supplied conversation, not
    // some "unknown" placeholder.
    const row = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.id, result.messageId))
      .limit(1);
    expect(row[0]!.conversationId).toBe(CONV_WIRED);
    expect(row[0]!.content).toBe("fallback-test");
  });

  test("extension not wired → -32001", async () => {
    const parent = await insertParentMessage(CONV_WIRED);
    const resp = await handleAppendMessageRpc(
      EXT_UNWIRED,
      rpc({ parentMessageId: parent, role: "extension", content: "hi" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toMatch(/wired/);
  });

  test("caller-supplied conversationId mismatches host scope → -32602", async () => {
    const parent = await insertParentMessage(CONV_WIRED);
    const resp = await handleAppendMessageRpc(
      EXT_WIRED,
      rpc({
        parentMessageId: parent,
        role: "extension",
        content: "hi",
        conversationId: OTHER_CONV, // forged
      }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });
});

describe("append-message — payload validation", () => {
  test("missing parentMessageId → -32602", async () => {
    const resp = await handleAppendMessageRpc(
      EXT_WIRED,
      rpc({ role: "extension", content: "hi" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test('role !== "extension" → -32602', async () => {
    const parent = await insertParentMessage(CONV_WIRED);
    const resp = await handleAppendMessageRpc(
      EXT_WIRED,
      rpc({ parentMessageId: parent, role: "assistant", content: "hi" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.message).toMatch(/role/);
  });

  test("empty content → -32602", async () => {
    const parent = await insertParentMessage(CONV_WIRED);
    const resp = await handleAppendMessageRpc(
      EXT_WIRED,
      rpc({ parentMessageId: parent, role: "extension", content: "" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("content >100k chars → -32602", async () => {
    const parent = await insertParentMessage(CONV_WIRED);
    const big = "x".repeat(100_001);
    const resp = await handleAppendMessageRpc(
      EXT_WIRED,
      rpc({ parentMessageId: parent, role: "extension", content: big }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("invalid tool-call status → -32602", async () => {
    const parent = await insertParentMessage(CONV_WIRED);
    const resp = await handleAppendMessageRpc(
      EXT_WIRED,
      rpc({
        parentMessageId: parent,
        role: "extension",
        content: "hi",
        toolCalls: [{ name: "x", input: {}, status: "bogus" }],
      }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });
});

describe("append-message — happy path", () => {
  test("inserts message row with role:extension + excluded:true", async () => {
    const parent = await insertParentMessage(CONV_WIRED);
    const resp = await handleAppendMessageRpc(
      EXT_WIRED,
      rpc({ parentMessageId: parent, role: "extension", content: "hello" }, "ok-1"),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    const result = resp.result as { messageId: string; toolCallIds: string[] };
    expect(typeof result.messageId).toBe("string");

    const row = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.id, result.messageId))
      .limit(1);
    expect(row[0]!.role).toBe("extension");
    expect(row[0]!.excluded).toBe(true);
    expect(row[0]!.parentMessageId).toBe(parent);
    expect(row[0]!.content).toBe("hello");
  });

  test("forces excluded:true even when caller passes false", async () => {
    const parent = await insertParentMessage(CONV_WIRED);
    const resp = await handleAppendMessageRpc(
      EXT_WIRED,
      rpc({
        parentMessageId: parent,
        role: "extension",
        content: "force-excl",
        excluded: false, // caller tries to override
      }, "force-1"),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    const r = resp.result as { messageId: string };
    const row = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.id, r.messageId))
      .limit(1);
    expect(row[0]!.excluded).toBe(true);
  });

  test("persists tool-call rows + returns ids", async () => {
    const parent = await insertParentMessage(CONV_WIRED);
    const resp = await handleAppendMessageRpc(
      EXT_WIRED,
      rpc({
        parentMessageId: parent,
        role: "extension",
        content: "tc-test",
        toolCalls: [
          { name: "synth", input: { text: "abc" }, cardType: "kokoro-tts-player", status: "running" },
          { name: "log", input: { v: 1 }, status: "complete", output: { ok: true } },
        ],
      }, "tc-1"),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    const result = resp.result as { messageId: string; toolCallIds: string[] };
    expect(result.toolCallIds).toHaveLength(2);

    const tcRows = await getDb()
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.messageId, result.messageId))
      .orderBy(asc(toolCalls.createdAt));
    expect(tcRows).toHaveLength(2);
    expect(tcRows[0]!.toolName).toBe("synth");
    expect(tcRows[0]!.cardType).toBe("kokoro-tts-player");
    expect(tcRows[0]!.extensionId).toBe(EXT_WIRED);
    expect(tcRows[1]!.toolName).toBe("log");
  });

  test("reattributes pre-uploaded attachments to the new message", async () => {
    const parent = await insertParentMessage(CONV_WIRED);
    // First mint a placeholder message so the attachment FK has a target.
    const placeholder = await insertParentMessage(CONV_WIRED);
    const attId = await insertAttachment({ conversationId: CONV_WIRED, messageId: placeholder });

    const resp = await handleAppendMessageRpc(
      EXT_WIRED,
      rpc({
        parentMessageId: parent,
        role: "extension",
        content: "att-test",
        attachmentIds: [attId],
      }, "att-1"),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    const result = resp.result as { messageId: string };

    const att = await getDb()
      .select()
      .from(messageAttachments)
      .where(eq(messageAttachments.id, attId))
      .limit(1);
    expect(att[0]!.messageId).toBe(result.messageId);
  });
});

describe("append-message — cross-conversation attachment reject", () => {
  test("attachment in another conversation → -32001", async () => {
    const parent = await insertParentMessage(CONV_WIRED);
    const otherParent = await insertParentMessage(OTHER_CONV);
    const otherAttId = await insertAttachment({ conversationId: OTHER_CONV, messageId: otherParent });

    const resp = await handleAppendMessageRpc(
      EXT_WIRED,
      rpc({
        parentMessageId: parent,
        role: "extension",
        content: "x-conv",
        attachmentIds: [otherAttId],
      }, "xc-1"),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toMatch(/calling conversation/);

    // Verify NO message row was inserted (pre-flight rejected before
    // createMessage).
    const rows = await getDb()
      .select({ count: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, CONV_WIRED), eq(messages.content, "x-conv")));
    expect(rows.length).toBe(0);
  });

  test("non-existent attachment id → -32602", async () => {
    const parent = await insertParentMessage(CONV_WIRED);
    const resp = await handleAppendMessageRpc(
      EXT_WIRED,
      rpc({
        parentMessageId: parent,
        role: "extension",
        content: "missing-att",
        attachmentIds: ["00000000-0000-0000-0000-000000000000"],
      }, "ma-1"),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });
});
