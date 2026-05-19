/**
 * Phase 6 — `ezcorp/finalize-tool-call` reverse-RPC handler unit tests.
 *
 * Pre-Phase-6 there was no test file for `finalize-tool-call-handler.ts`
 * (cited by the auditor as critical gap #5). Closes the gap with both
 * the legacy boolean fallback path AND the new PDP path.
 */

import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mock.module("../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized — call setupTestDb() first");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

const { handleFinalizeToolCallRpc } = await import(
  "../extensions/finalize-tool-call-handler"
);
const { getDb } = await import("../db/connection");
const { conversations, projects, messages, toolCalls, users, extensions } = await import(
  "../db/schema"
);

import type { JsonRpcRequest } from "../extensions/types";
import type { FinalizeToolCallContext } from "../extensions/finalize-tool-call-handler";
import type { ExtensionPermissions } from "../extensions/types";

// ── Fixtures ─────────────────────────────────────────────────────────

const PROJECT_ID = "proj-ftc";
const CONV_ID = "conv-ftc";
const EXT_ID = "ext-ftc";
const OTHER_EXT_ID = "ext-ftc-other";
const USER_ID = "user-ftc";
const MSG_ID = "msg-ftc-anchor";

function makePerms(append = true): ExtensionPermissions {
  return {
    ...(append ? { appendMessages: { excludedDefault: true } } : {}),
    grantedAt: {},
  };
}

function makeCtx(
  overrides: Partial<FinalizeToolCallContext> = {},
): FinalizeToolCallContext {
  return {
    conversationId: overrides.conversationId ?? CONV_ID,
    userId: overrides.userId ?? USER_ID,
    grantedPermissions: overrides.grantedPermissions ?? makePerms(true),
    ...(overrides.engine ? { engine: overrides.engine } : {}),
  };
}

function rpc(params: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ezcorp/finalize-tool-call", params };
}

let counter = 0;
function uniqueToolCallId(): string {
  counter += 1;
  return `tc-ftc-${counter}-${crypto.randomUUID().slice(0, 8)}`;
}

async function insertToolCall(id: string, extensionId: string): Promise<void> {
  await getDb()
    .insert(toolCalls)
    .values({
      id,
      conversationId: CONV_ID,
      messageId: MSG_ID,
      extensionId,
      toolName: "ftc-tool",
      input: { hello: "world" } as never,
      output: { content: [] } as never,
      success: true,
      durationMs: 0,
    } as never);
}

async function ensureExtension(id: string): Promise<void> {
  await getDb()
    .insert(extensions)
    .values({
      id,
      name: id,
      version: "1.0.0",
      description: id,
      manifest: { schemaVersion: 2, name: id } as never,
      source: `test:${id}`,
      installPath: `/tmp/${id}`,
      enabled: true,
      grantedPermissions: { grantedAt: {} } as never,
    } as never)
    .onConflictDoNothing();
}

beforeAll(async () => {
  await setupTestDb();
  await getDb()
    .insert(users)
    .values({ id: USER_ID, email: "ftc@test.local", passwordHash: "x", name: "ftc" } as never)
    .onConflictDoNothing();
  await getDb()
    .insert(projects)
    .values({ id: PROJECT_ID, name: "ftc", path: "/tmp/ftc" } as never)
    .onConflictDoNothing();
  await getDb()
    .insert(conversations)
    .values({ id: CONV_ID, projectId: PROJECT_ID, title: "ftc" } as never)
    .onConflictDoNothing();
  await getDb()
    .insert(messages)
    .values({
      id: MSG_ID,
      conversationId: CONV_ID,
      role: "user",
      content: "anchor",
    } as never)
    .onConflictDoNothing();
  // FK target rows for tool_calls.
  await ensureExtension(EXT_ID);
  await ensureExtension(OTHER_EXT_ID);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

// ── Legacy boolean path ─────────────────────────────────────────────

describe("finalize-tool-call — legacy boolean fallback (no engine)", () => {
  test("appendMessages not granted → -32001", async () => {
    const tcid = uniqueToolCallId();
    await insertToolCall(tcid, EXT_ID);
    const resp = await handleFinalizeToolCallRpc(
      EXT_ID,
      rpc({ toolCallId: tcid, status: "complete" }),
      makeCtx({ grantedPermissions: makePerms(false) }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toContain("appendMessages permission not granted");
  });

  test("kill-switch → -32001 even with permission granted", async () => {
    process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = "1";
    const tcid = uniqueToolCallId();
    await insertToolCall(tcid, EXT_ID);
    const resp = await handleFinalizeToolCallRpc(
      EXT_ID,
      rpc({ toolCallId: tcid, status: "complete" }),
      makeCtx(),
    );
    delete process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
    expect(resp.error?.code).toBe(-32001);
  });

  test("ownership: cross-extension finalize is rejected", async () => {
    const tcid = uniqueToolCallId();
    await insertToolCall(tcid, EXT_ID);
    const resp = await handleFinalizeToolCallRpc(
      OTHER_EXT_ID,
      rpc({ toolCallId: tcid, status: "complete" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toContain("not owned");
  });

  test("happy path: finalizes a row owned by caller in the wired conversation", async () => {
    const tcid = uniqueToolCallId();
    await insertToolCall(tcid, EXT_ID);
    const resp = await handleFinalizeToolCallRpc(
      EXT_ID,
      rpc({ toolCallId: tcid, status: "complete", output: "ok" }),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    expect((resp.result as { ok: boolean }).ok).toBe(true);
  });
});

// ── Phase 6 PDP path ────────────────────────────────────────────────

describe("finalize-tool-call — Phase 6 PDP path", () => {
  test("ctx.engine returns deny → -32001 'appendMessages permission not granted'", async () => {
    const { createStubPermissionEngine } = await import("./helpers/permission-engine-stub");
    const engine = createStubPermissionEngine("deny-all");
    const tcid = uniqueToolCallId();
    await insertToolCall(tcid, EXT_ID);
    const resp = await handleFinalizeToolCallRpc(
      EXT_ID,
      rpc({ toolCallId: tcid, status: "complete" }),
      // grantedPermissions still has append; PDP overrides.
      makeCtx({ grantedPermissions: makePerms(true), engine }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toContain("appendMessages permission not granted");
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0]!.needed).toEqual([{ kind: "ezcorp:chat:append" }]);
  });

  test("ctx.engine returns allow + grantedPermissions empty → handler proceeds", async () => {
    const { createStubPermissionEngine } = await import("./helpers/permission-engine-stub");
    const engine = createStubPermissionEngine("allow-all");
    const tcid = uniqueToolCallId();
    await insertToolCall(tcid, EXT_ID);
    const resp = await handleFinalizeToolCallRpc(
      EXT_ID,
      rpc({ toolCallId: tcid, status: "complete" }),
      makeCtx({ grantedPermissions: makePerms(false), engine }),
    );
    // PDP allowed → no permission-denied error. The row gets finalized.
    expect(resp.error).toBeUndefined();
    expect(engine.calls.length).toBe(1);
  });
});
