// Unit tests for src/extensions/finalize-tool-call-handler.ts.
//
// Validates permission gating, ownership enforcement (extensionId
// match), happy-path output + success column persistence, and
// rejection on cross-conversation calls.

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

const { handleFinalizeToolCallRpc } = await import("../finalize-tool-call-handler");
const { getDb } = await import("../../db/connection");
const {
  conversations,
  projects,
  users,
  messages,
  extensions: extensionsTable,
  toolCalls,
} = await import("../../db/schema");
const { eq } = await import("drizzle-orm");

import type { JsonRpcRequest } from "../types";
import type { FinalizeToolCallContext } from "../finalize-tool-call-handler";
import type { ExtensionPermissions } from "../types";

const EXT_OWNER = "ext-ftc-owner";
const EXT_INTRUDER = "ext-ftc-intruder";
const CONV = "conv-ftc";
const OTHER_CONV = "conv-ftc-other";
const PROJECT = "proj-ftc";
const USER = "user-ftc";

function makePerms(append = true): ExtensionPermissions {
  const perms: ExtensionPermissions = { grantedAt: {} };
  if (append) perms.appendMessages = { excludedDefault: true };
  return perms;
}

function makeCtx(overrides: Partial<FinalizeToolCallContext> = {}): FinalizeToolCallContext {
  return {
    conversationId: overrides.conversationId ?? CONV,
    userId: overrides.userId ?? USER,
    grantedPermissions: overrides.grantedPermissions ?? makePerms(true),
  };
}

function rpc(params: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ezcorp/finalize-tool-call", params };
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

async function insertMessage(convId: string): Promise<string> {
  const rows = await getDb().insert(messages).values({
    conversationId: convId,
    role: "extension",
    content: "x",
  } as any).returning();
  return rows[0]!.id;
}

async function insertToolCall(opts: {
  conversationId: string;
  messageId: string;
  extensionId: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await getDb().insert(toolCalls).values({
    id,
    conversationId: opts.conversationId,
    messageId: opts.messageId,
    extensionId: opts.extensionId,
    toolName: "synth",
    input: { text: "x" },
    output: { content: [] },
    success: true,
    durationMs: 0,
  } as any);
  return id;
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
  await getDb().insert(conversations).values({ id: CONV, projectId: PROJECT, title: "ftc", userId: USER } as any);
  await getDb().insert(conversations).values({ id: OTHER_CONV, projectId: PROJECT, title: "other", userId: USER } as any);
  await ensureExtension(EXT_OWNER);
  await ensureExtension(EXT_INTRUDER);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("finalize-tool-call — permission gate", () => {
  test("appendMessages NOT granted → -32001", async () => {
    const msgId = await insertMessage(CONV);
    const tcId = await insertToolCall({ conversationId: CONV, messageId: msgId, extensionId: EXT_OWNER });
    const resp = await handleFinalizeToolCallRpc(
      EXT_OWNER,
      rpc({ toolCallId: tcId, status: "complete", output: {} }),
      makeCtx({ grantedPermissions: makePerms(false) }),
    );
    expect(resp.error?.code).toBe(-32001);
  });

  test("kill-switch → -32001", async () => {
    process.env.EZCORP_DISABLE_CAPABILITY_TOOLS = "1";
    try {
      const msgId = await insertMessage(CONV);
      const tcId = await insertToolCall({ conversationId: CONV, messageId: msgId, extensionId: EXT_OWNER });
      const resp = await handleFinalizeToolCallRpc(
        EXT_OWNER,
        rpc({ toolCallId: tcId, status: "complete", output: {} }),
        makeCtx(),
      );
      expect(resp.error?.code).toBe(-32001);
    } finally {
      delete process.env.EZCORP_DISABLE_CAPABILITY_TOOLS;
    }
  });
});

describe("finalize-tool-call — payload validation", () => {
  test("missing toolCallId → -32602", async () => {
    const resp = await handleFinalizeToolCallRpc(
      EXT_OWNER,
      rpc({ status: "complete", output: {} }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("invalid status → -32602", async () => {
    const resp = await handleFinalizeToolCallRpc(
      EXT_OWNER,
      rpc({ toolCallId: "x", status: "bogus", output: {} }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("toolCallId not found → -32602", async () => {
    const resp = await handleFinalizeToolCallRpc(
      EXT_OWNER,
      rpc({ toolCallId: "00000000-0000-0000-0000-000000000000", status: "complete", output: {} }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });
});

describe("finalize-tool-call — ownership", () => {
  test("non-owning extension → -32001", async () => {
    const msgId = await insertMessage(CONV);
    const tcId = await insertToolCall({ conversationId: CONV, messageId: msgId, extensionId: EXT_OWNER });
    const resp = await handleFinalizeToolCallRpc(
      EXT_INTRUDER,
      rpc({ toolCallId: tcId, status: "complete", output: {} }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toMatch(/not owned/);
  });

  test("tool call in different conversation → -32001", async () => {
    const otherMsg = await insertMessage(OTHER_CONV);
    const tcId = await insertToolCall({ conversationId: OTHER_CONV, messageId: otherMsg, extensionId: EXT_OWNER });
    const resp = await handleFinalizeToolCallRpc(
      EXT_OWNER,
      rpc({ toolCallId: tcId, status: "complete", output: {} }),
      makeCtx({ conversationId: CONV }),
    );
    expect(resp.error?.code).toBe(-32001);
  });
});

describe("finalize-tool-call — happy path", () => {
  test("status=complete writes success=true + output", async () => {
    const msgId = await insertMessage(CONV);
    const tcId = await insertToolCall({ conversationId: CONV, messageId: msgId, extensionId: EXT_OWNER });
    const resp = await handleFinalizeToolCallRpc(
      EXT_OWNER,
      rpc({ toolCallId: tcId, status: "complete", output: { attachmentId: "abc" } }),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    expect((resp.result as { ok: boolean }).ok).toBe(true);

    const rows = await getDb().select().from(toolCalls).where(eq(toolCalls.id, tcId)).limit(1);
    expect(rows[0]!.success).toBe(true);
    const out = rows[0]!.output as { content: { type: string; text: string }[] };
    expect(out.content[0]!.text).toContain("attachmentId");
  });

  test("status=error writes success=false", async () => {
    const msgId = await insertMessage(CONV);
    const tcId = await insertToolCall({ conversationId: CONV, messageId: msgId, extensionId: EXT_OWNER });
    const resp = await handleFinalizeToolCallRpc(
      EXT_OWNER,
      rpc({ toolCallId: tcId, status: "error", output: "synth failed" }),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    const rows = await getDb().select().from(toolCalls).where(eq(toolCalls.id, tcId)).limit(1);
    expect(rows[0]!.success).toBe(false);
    const out = rows[0]!.output as { content: { type: string; text: string }[] };
    expect(out.content[0]!.text).toBe("synth failed");
  });
});
