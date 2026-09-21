/**
 * `runtime.memory.dedupMemoryWrite` → memory COLUMNS, end to end.
 *
 * The bundled memory-extractor is the only caller of this RPC, and the
 * eligibility it sends is the whole point of the call: the injection path
 * (`hybridSearch` with `injectionEligibleOnly`) filters on the
 * `injection_eligible` COLUMN, so eligibility parked in provenance JSON
 * changes nothing. Ownership has the same shape — retrieval only falls back
 * to the source conversation's owner while `user_id` is null, and
 * `conversation_id` is `on delete set null`, so a row that leans on the
 * fallback goes unattributable the moment its conversation is deleted.
 *
 * These tests therefore drive the real handler against a real PGlite and
 * read the columns back off the row. The embedder is the only stub — the
 * production one loads an ONNX model.
 *
 * The handler's arg-validation and routing branches are covered by
 * `runtime-invoke-handler.test.ts`, which runs fully mocked; this file is
 * deliberately the DB-backed half.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import type { JsonRpcRequest } from "../extensions/types";

mockDbConnection();

mock.module("../memory/embeddings", () => {
  function makeVector(text: string): number[] {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
    const vec = Array.from({ length: 384 }, (_, i) => Math.sin(h + i) * 0.1);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map((v) => v / norm);
  }
  return {
    generateEmbedding: async (text: string) => makeVector(text),
    generateEmbeddings: async (texts: string[]) => texts.map(makeVector),
    resetEmbeddingProvider: () => {},
  };
});

const { handleRuntimeInvoke } = await import("../extensions/runtime-invoke-handler");
type RuntimeInvokeContext = import("../extensions/runtime-invoke-handler").RuntimeInvokeContext;
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { getDb } = await import("../db/connection");
const { users, memories } = await import("../db/schema");
const { sql, eq } = await import("drizzle-orm");

const OWNER = "dedup-rpc-owner";
/** The one bundled extension carrying `memory.selfOnly: false`. */
const BUNDLED_NAME = "memory-extractor";

let projectId: string;
let conversationId: string;
let unownedConversationId: string;

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values({
    id: OWNER, email: "dedup-rpc@test.local", name: "Dedup RPC", passwordHash: "fake-hash",
  }).onConflictDoNothing();
  const project = await createProject({ name: "dedup-rpc", path: "/tmp/dedup-rpc" });
  projectId = project.id;
  conversationId = (await createConversation(projectId, { title: "owned", userId: OWNER })).id;
  unownedConversationId = (await createConversation(projectId, { title: "unowned" })).id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  // Every case writes a distinct fact, but a clean table keeps a dedup hit
  // from silently turning an INSERT assertion into an UPDATE one.
  await getDb().execute(sql`TRUNCATE TABLE memories CASCADE`);
});

function makeCtx(overrides: Partial<RuntimeInvokeContext> = {}): RuntimeInvokeContext {
  return {
    extensionId: "ext-memory-extractor",
    extensionName: BUNDLED_NAME,
    userId: OWNER,
    currentConversationId: conversationId,
    granted: { grantedAt: {} },
    ...overrides,
  };
}

function makeReq(args: Record<string, unknown>): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "ezcorp/invoke",
    params: { tool: "runtime.memory.dedupMemoryWrite", arguments: args },
  };
}

/** Call the RPC and return the row it wrote. */
async function writeAndRead(
  args: Record<string, unknown>,
  ctx: RuntimeInvokeContext = makeCtx(),
): Promise<{ userId: string | null; injectionEligible: boolean; provenance: unknown }> {
  const res = await handleRuntimeInvoke(
    "runtime.memory.dedupMemoryWrite",
    args,
    ctx,
    makeReq(args),
  );
  expect(res.error).toBeUndefined();
  const { action, memoryId } = res.result as { action: string; memoryId: string };
  expect(action).toBe("inserted");
  const rows = await getDb()
    .select({
      userId: memories.userId,
      injectionEligible: memories.injectionEligible,
      provenance: memories.provenance,
    })
    .from(memories)
    .where(eq(memories.id, memoryId));
  return rows[0]!;
}

const baseArgs = {
  category: "preferences",
  confidence: "high",
  sourceMessageIds: ["m1"],
  extensionId: "ext-memory-extractor",
};

describe("runtime.memory.dedupMemoryWrite — injection_eligible column", () => {
  test("injectionEligible: true lands on the column", async () => {
    const row = await writeAndRead({
      ...baseArgs, content: "Eligible via RPC", conversationId, projectId, injectionEligible: true,
    });
    expect(row.injectionEligible).toBe(true);
  });

  test("injectionEligible: false lands on the column", async () => {
    // The case that matters: `false` is what keeps an extension's memory out
    // of every future system prompt. Before the column was written, this
    // memory injected anyway.
    const row = await writeAndRead({
      ...baseArgs, content: "Ineligible via RPC", conversationId, projectId, injectionEligible: false,
    });
    expect(row.injectionEligible).toBe(false);
  });

  test("an absent injectionEligible takes the column default (true)", async () => {
    const row = await writeAndRead({
      ...baseArgs, content: "Unspecified eligibility via RPC", conversationId, projectId,
    });
    expect(row.injectionEligible).toBe(true);
  });

  test("a non-boolean injectionEligible is ignored, not coerced", async () => {
    // "false" (a string) is truthy in JS. Coercing it would flip the memory
    // back into injection — the opposite of what the caller wrote.
    const row = await writeAndRead({
      ...baseArgs, content: "Garbage eligibility via RPC", conversationId, projectId,
      injectionEligible: "false",
    });
    expect(row.injectionEligible).toBe(true);
    expect((row.provenance as { injectionEligible?: unknown }).injectionEligible).toBeUndefined();
  });

  test("eligibility is also kept in provenance for audit parity", async () => {
    const row = await writeAndRead({
      ...baseArgs, content: "Audit parity via RPC", conversationId, projectId, injectionEligible: false,
    });
    const prov = row.provenance as { injectionEligible?: boolean; extensionId?: string };
    expect(prov.injectionEligible).toBe(false);
    expect(prov.extensionId).toBe("ext-memory-extractor");
  });
});

describe("runtime.memory.dedupMemoryWrite — user_id column", () => {
  test("the row carries the source conversation's owner", async () => {
    const row = await writeAndRead({
      ...baseArgs, content: "Owned via RPC", conversationId, projectId,
    });
    expect(row.userId).toBe(OWNER);
  });

  test("an unowned source conversation writes user_id null", async () => {
    // Fail-closed, not a guess: the RPC ctx knows a userId, but attributing
    // the memory to it would claim ownership the conversation never had.
    const row = await writeAndRead(
      { ...baseArgs, content: "Unowned via RPC", conversationId: unownedConversationId, projectId },
      makeCtx({ currentConversationId: unownedConversationId }),
    );
    expect(row.userId).toBeNull();
  });
});

describe("runtime.memory.dedupMemoryWrite — bundled-only gate", () => {
  test("a non-bundled caller is rejected and writes nothing", async () => {
    const args = { ...baseArgs, content: "Gate-crasher", conversationId, projectId, injectionEligible: true };
    const res = await handleRuntimeInvoke(
      "runtime.memory.dedupMemoryWrite",
      args,
      makeCtx({ extensionName: "some-user-installed-ext" }),
      makeReq(args),
    );
    expect(res.error?.code).toBe(-32604);
    expect(res.error?.message).toMatch(/restricted to bundled extensions/i);
    const rows = await getDb().select({ id: memories.id }).from(memories);
    expect(rows).toHaveLength(0);
  });
});
