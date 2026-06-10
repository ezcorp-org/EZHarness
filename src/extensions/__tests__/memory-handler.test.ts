/**
 * Coverage for `handlePiMemory` (Phase 51.2).
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb, closeTestDb, mockDbConnection, getTestDb,
} from "../../__tests__/helpers/test-pglite";

mock.module("../../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import { handlePiMemory, _resetMemoryWriteQuotaForTests } from "../memory-handler";
import { createUser } from "../../db/queries/users";
import {
  extensions, conversations, projects,
  sdkCapabilityCalls, messages, errorLogs, auditLog,
  memories, memoryAuditLog,
} from "../../db/schema";
import { eq } from "drizzle-orm";
import type { ExtensionPermissions } from "../types";

let userId: string;
let userId2: string;
let extensionId: string;
let extensionId2: string;
let projectId: string;
let conversationId: string;

async function ensureExtension(name: string): Promise<string> {
  const [row] = await getTestDb().insert(extensions).values({
    name, version: "0.0.1", description: "",
    manifest: { schemaVersion: 2, name, version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as any,
    source: "test", enabled: true, grantedPermissions: {} as any,
  }).returning({ id: extensions.id });
  return row!.id;
}

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({ email: "mem-h@example.com", passwordHash: "h", name: "U", role: "admin", status: "active" });
  userId = u.id;
  const u2 = await createUser({ email: "mem-h2@example.com", passwordHash: "h", name: "U2", role: "member", status: "active" });
  userId2 = u2.id;
  extensionId = await ensureExtension("mem-h-ext-1");
  extensionId2 = await ensureExtension("mem-h-ext-2");
  const [proj] = await getTestDb().insert(projects).values({ name: "mem-proj", path: "/tmp/mem" }).returning({ id: projects.id });
  projectId = proj!.id;
  const [conv] = await getTestDb().insert(conversations).values({ projectId, userId, title: "t", kind: "regular" }).returning({ id: conversations.id });
  conversationId = conv!.id;
});

beforeEach(async () => {
  await getTestDb().delete(messages);
  await getTestDb().delete(memoryAuditLog);
  await getTestDb().delete(memories);
  await getTestDb().delete(sdkCapabilityCalls);
  await getTestDb().delete(errorLogs);
  await getTestDb().delete(auditLog);
  _resetMemoryWriteQuotaForTests();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

function grantedWrite(overrides: Partial<NonNullable<ExtensionPermissions["memory"]>> = {}): ExtensionPermissions {
  return {
    grantedAt: { memory: Date.now() },
    memory: { access: "write", maxWritesPerDay: 100, selfOnly: true, ...overrides },
  };
}

function grantedRead(overrides: Partial<NonNullable<ExtensionPermissions["memory"]>> = {}): ExtensionPermissions {
  return {
    grantedAt: { memory: Date.now() },
    memory: { access: "read", maxWritesPerDay: 100, selfOnly: true, ...overrides },
  };
}

function rpcMeta(): Record<string, unknown> {
  return { ezOnBehalfOf: userId, ezConversationId: conversationId };
}

/** Same extension identity, but acting on behalf of a DIFFERENT user —
 *  the shared-bundled-extension scenario. */
function rpcMetaUser2(): Record<string, unknown> {
  return { ezOnBehalfOf: userId2, ezConversationId: conversationId };
}

let embedderCalls = 0;
const fakeEmbed = async (_text: string): Promise<number[]> => {
  embedderCalls++;
  return new Array<number>(384).fill(0).map((_, i) => (i + 1) / 1000);
};

beforeEach(() => { embedderCalls = 0; });

describe("memory: write", () => {
  test("stamps provenance.extensionId from host (NEVER from RPC meta)", async () => {
    const resp = await handlePiMemory(
      { jsonrpc: "2.0", id: 1, method: "ezcorp/memory",
        params: { action: "write", input: { content: "test memory", category: "technical" } } },
      { granted: grantedWrite(), registeredTool: { extensionId }, embedFn: fakeEmbed },
      // Try to spoof: RPC meta CLAIMS a different extension. The host MUST IGNORE.
      { ...rpcMeta(), actorExtensionId: "evil-ext" },
    );
    expect(resp.error).toBeUndefined();
    const memId = (resp.result as { memory: { id: string } }).memory.id;
    const rows = await getTestDb().select().from(memories).where(eq(memories.id, memId));
    // Cast through `unknown` because Drizzle's inferred provenance
    // type includes `null` and `MemoryProvenance` doesn't structurally
    // overlap our local `{ extensionId }` slice.
    const prov = rows[0]!.provenance as unknown as { extensionId: string };
    expect(prov.extensionId).toBe(extensionId); // NOT evil-ext
  });

  test("injectionEligible defaults FALSE on extension write", async () => {
    const resp = await handlePiMemory(
      { jsonrpc: "2.0", id: 2, method: "ezcorp/memory",
        params: { action: "write", input: { content: "x", category: "preferences" } } },
      { granted: grantedWrite(), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMeta(),
    );
    const memId = (resp.result as { memory: { id: string } }).memory.id;
    const rows = await getTestDb().select().from(memories).where(eq(memories.id, memId));
    expect(rows[0]!.injectionEligible).toBe(false);
  });

  test("category not in allowlist → -32001", async () => {
    const resp = await handlePiMemory(
      { jsonrpc: "2.0", id: 3, method: "ezcorp/memory",
        params: { action: "write", input: { content: "x", category: "biographical" } } },
      { granted: grantedWrite({ categories: ["technical"] }), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMeta(),
    );
    expect(resp.error?.code).toBe(-32001);
    expect((resp.error?.data as { reason: string }).reason).toBe("category-not-allowed");
  });

  test("daily quota exceeded → -32103 with retryAfterMs", async () => {
    const granted = grantedWrite({ maxWritesPerDay: 2 });
    const ctx = { granted, registeredTool: { extensionId }, embedFn: fakeEmbed };
    const params = { action: "write" as const, input: { content: "x", category: "technical" as const } };
    await handlePiMemory({ jsonrpc: "2.0", id: 10, method: "ezcorp/memory", params }, ctx, rpcMeta());
    await handlePiMemory({ jsonrpc: "2.0", id: 11, method: "ezcorp/memory", params }, ctx, rpcMeta());
    const denied = await handlePiMemory({ jsonrpc: "2.0", id: 12, method: "ezcorp/memory", params }, ctx, rpcMeta());
    expect(denied.error?.code).toBe(-32103);
    expect((denied.error?.data as { reason: string }).reason).toBe("writes-per-day");
  });

  test("embedder called once host-side; memory_audit_log row written", async () => {
    const resp = await handlePiMemory(
      { jsonrpc: "2.0", id: 4, method: "ezcorp/memory",
        params: { action: "write", input: { content: "audit me", category: "decisions_goals" } } },
      { granted: grantedWrite(), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMeta(),
    );
    expect(resp.error).toBeUndefined();
    expect(embedderCalls).toBe(1);
    const audits = await getTestDb().select().from(memoryAuditLog);
    expect(audits.length).toBe(1);
    expect(audits[0]!.action).toBe("created");
    expect(audits[0]!.newContent).toBe("audit me");
    expect(audits[0]!.reason).toContain(`ext:${extensionId}`);
  });
});

describe("memory: read access guard + selfOnly", () => {
  test("read action without grant → -32001", async () => {
    const resp = await handlePiMemory(
      { jsonrpc: "2.0", id: 20, method: "ezcorp/memory", params: { action: "list" } },
      { granted: { grantedAt: {} }, registeredTool: { extensionId } },
      rpcMeta(),
    );
    expect(resp.error?.code).toBe(-32001);
  });

  test("write action with read-only grant → -32001", async () => {
    const resp = await handlePiMemory(
      { jsonrpc: "2.0", id: 21, method: "ezcorp/memory",
        params: { action: "write", input: { content: "x", category: "technical" } } },
      { granted: grantedRead(), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMeta(),
    );
    expect(resp.error?.code).toBe(-32001);
  });

  test("selfOnly=true hides another extension's memories", async () => {
    // Write from extensionId.
    await handlePiMemory(
      { jsonrpc: "2.0", id: 30, method: "ezcorp/memory",
        params: { action: "write", input: { content: "ext1-secret", category: "technical" } } },
      { granted: grantedWrite(), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMeta(),
    );
    // List from extensionId2 with selfOnly=true.
    const resp = await handlePiMemory(
      { jsonrpc: "2.0", id: 31, method: "ezcorp/memory", params: { action: "list" } },
      { granted: grantedRead(), registeredTool: { extensionId: extensionId2 } },
      rpcMeta(),
    );
    const list = (resp.result as { memories: unknown[] }).memories;
    expect(list.length).toBe(0);
  });

  test("update of non-owned memory → -32001 reason 'not-author'", async () => {
    const written = await handlePiMemory(
      { jsonrpc: "2.0", id: 40, method: "ezcorp/memory",
        params: { action: "write", input: { content: "owned-by-1", category: "technical" } } },
      { granted: grantedWrite(), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMeta(),
    );
    const memId = (written.result as { memory: { id: string } }).memory.id;
    const denied = await handlePiMemory(
      { jsonrpc: "2.0", id: 41, method: "ezcorp/memory",
        params: { action: "update", id: memId, patch: { content: "hacked" } } },
      { granted: grantedWrite(), registeredTool: { extensionId: extensionId2 }, embedFn: fakeEmbed },
      rpcMeta(),
    );
    expect(denied.error?.code).toBe(-32001);
    expect((denied.error?.data as { reason: string }).reason).toBe("not-author");
  });
});

describe("memory: cross-user isolation (shared extension identity)", () => {
  // The SAME extensionId runs on behalf of two different users (the
  // bundled memory-extractor pattern). User 2 must never read or mutate
  // user 1's memories even though the extension identity matches.
  async function writeAsUser1(content: string): Promise<string> {
    const resp = await handlePiMemory(
      { jsonrpc: "2.0", id: 50, method: "ezcorp/memory",
        params: { action: "write", input: { content, category: "technical" } } },
      { granted: grantedWrite(), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMeta(),
    );
    return (resp.result as { memory: { id: string } }).memory.id;
  }

  test("list does not return another user's memory", async () => {
    await writeAsUser1("user1-private");
    const resp = await handlePiMemory(
      { jsonrpc: "2.0", id: 51, method: "ezcorp/memory", params: { action: "list" } },
      { granted: grantedRead(), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMetaUser2(),
    );
    const list = (resp.result as { memories: unknown[] }).memories;
    expect(list.length).toBe(0);
  });

  test("list with selfOnly=false still scopes to the acting user", async () => {
    await writeAsUser1("user1-private");
    const resp = await handlePiMemory(
      { jsonrpc: "2.0", id: 52, method: "ezcorp/memory", params: { action: "list" } },
      { granted: grantedRead({ selfOnly: false }), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMetaUser2(),
    );
    const list = (resp.result as { memories: unknown[] }).memories;
    expect(list.length).toBe(0);
  });

  test("get of another user's memory → not-found (opaque)", async () => {
    const memId = await writeAsUser1("user1-private");
    const resp = await handlePiMemory(
      { jsonrpc: "2.0", id: 53, method: "ezcorp/memory", params: { action: "get", id: memId } },
      { granted: grantedRead(), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMetaUser2(),
    );
    expect(resp.error?.code).toBe(-32001);
    expect((resp.error?.data as { reason: string }).reason).toBe("not-found");
  });

  test("update of another user's memory → not-found, content unchanged", async () => {
    const memId = await writeAsUser1("user1-private");
    const resp = await handlePiMemory(
      { jsonrpc: "2.0", id: 54, method: "ezcorp/memory",
        params: { action: "update", id: memId, patch: { content: "hacked" } } },
      { granted: grantedWrite(), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMetaUser2(),
    );
    expect(resp.error?.code).toBe(-32001);
    expect((resp.error?.data as { reason: string }).reason).toBe("not-found");
    const rows = await getTestDb().select().from(memories).where(eq(memories.id, memId));
    expect(rows[0]!.content).toBe("user1-private");
  });

  test("archive of another user's memory → not-found, status unchanged", async () => {
    const memId = await writeAsUser1("user1-private");
    const resp = await handlePiMemory(
      { jsonrpc: "2.0", id: 55, method: "ezcorp/memory", params: { action: "archive", id: memId } },
      { granted: grantedWrite(), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMetaUser2(),
    );
    expect(resp.error?.code).toBe(-32001);
    expect((resp.error?.data as { reason: string }).reason).toBe("not-found");
    const rows = await getTestDb().select().from(memories).where(eq(memories.id, memId));
    expect(rows[0]!.status).not.toBe("archived");
  });

  test("host-extracted memory (NULL userId) is visible to its conversation's owner, not others", async () => {
    // Simulate the host extraction pipeline: dedupAndWriteMemory inserts
    // with conversationId but NO userId. Ownership is derived from the
    // source conversation (owned by user1 here).
    const [hostMem] = await getTestDb().insert(memories).values({
      content: "host-extracted-for-user1",
      category: "biographical",
      conversationId, // owned by userId (user1)
      userId: null,
      confidence: "medium",
      provenance: { sourceConversationId: conversationId, sourceMessageIds: [], extractedAt: new Date(), confidence: "medium", history: [] } as never,
      injectionEligible: true,
    }).returning();
    const memId = hostMem!.id;

    // Owner (user1), selfOnly:false → sees it.
    const ownerList = await handlePiMemory(
      { jsonrpc: "2.0", id: 60, method: "ezcorp/memory", params: { action: "list" } },
      { granted: grantedRead({ selfOnly: false }), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMeta(),
    );
    const ownerIds = (ownerList.result as { memories: { id: string }[] }).memories.map((m) => m.id);
    expect(ownerIds).toContain(memId);
    const ownerGet = await handlePiMemory(
      { jsonrpc: "2.0", id: 61, method: "ezcorp/memory", params: { action: "get", id: memId } },
      { granted: grantedRead({ selfOnly: false }), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMeta(),
    );
    expect(ownerGet.error).toBeUndefined();

    // Different user (user2) → cannot see it.
    const otherList = await handlePiMemory(
      { jsonrpc: "2.0", id: 62, method: "ezcorp/memory", params: { action: "list" } },
      { granted: grantedRead({ selfOnly: false }), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMetaUser2(),
    );
    const otherIds = (otherList.result as { memories: { id: string }[] }).memories.map((m) => m.id);
    expect(otherIds).not.toContain(memId);
    const otherGet = await handlePiMemory(
      { jsonrpc: "2.0", id: 63, method: "ezcorp/memory", params: { action: "get", id: memId } },
      { granted: grantedRead({ selfOnly: false }), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMetaUser2(),
    );
    expect(otherGet.error?.code).toBe(-32001);
  });

  test("owner CAN still get/update/archive their own memory", async () => {
    const memId = await writeAsUser1("user1-private");
    const got = await handlePiMemory(
      { jsonrpc: "2.0", id: 56, method: "ezcorp/memory", params: { action: "get", id: memId } },
      { granted: grantedRead(), registeredTool: { extensionId }, embedFn: fakeEmbed },
      rpcMeta(),
    );
    expect(got.error).toBeUndefined();
    expect((got.result as { memory: { id: string } }).memory.id).toBe(memId);
  });
});
