/**
 * Phase 6 — `ezcorp/append-message` reverse-RPC handler unit tests.
 *
 * Pre-Phase-6 there was no test file for `append-message-handler.ts`
 * (cited by the auditor as critical gap #5). Closes the gap with both
 * the legacy boolean fallback path AND the new PDP path (deny + allow).
 *
 * Strategy mirrors `storage-handler-coverage.test.ts` — real PGlite +
 * drizzle, mock only `db/connection`.
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

const { handleAppendMessageRpc } = await import("../extensions/append-message-handler");
const { getDb } = await import("../db/connection");
const {
  conversations,
  projects,
  conversationExtensions,
  messages,
  users,
  extensions,
} = await import("../db/schema");

import type { JsonRpcRequest } from "../extensions/types";
import type { AppendMessageContext } from "../extensions/append-message-handler";
import type { ExtensionPermissions } from "../extensions/types";

// ── Fixtures ─────────────────────────────────────────────────────────

const PROJECT_ID = "proj-am";
const CONV_WIRED = "conv-am-wired";
const CONV_UNWIRED = "conv-am-unwired";
const EXT_ID = "ext-am";
const USER_ID = "user-am";

function makePerms(append = true): ExtensionPermissions {
  return {
    ...(append ? { appendMessages: { excludedDefault: true } } : {}),
    grantedAt: {},
  };
}

function makeCtx(overrides: Partial<AppendMessageContext> = {}): AppendMessageContext {
  return {
    conversationId: overrides.conversationId ?? CONV_WIRED,
    userId: overrides.userId ?? USER_ID,
    grantedPermissions: overrides.grantedPermissions ?? makePerms(true),
    ...(overrides.engine ? { engine: overrides.engine } : {}),
  };
}

function rpc(params: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ezcorp/append-message", params };
}

beforeAll(async () => {
  await setupTestDb();
  await getDb()
    .insert(users)
    .values({ id: USER_ID, email: "am@test.local", passwordHash: "x", name: "am" } as never)
    .onConflictDoNothing();
  await getDb()
    .insert(projects)
    .values({ id: PROJECT_ID, name: "am", path: "/tmp/am" } as never)
    .onConflictDoNothing();
  await getDb()
    .insert(conversations)
    .values({ id: CONV_WIRED, projectId: PROJECT_ID, title: "wired" } as never)
    .onConflictDoNothing();
  await getDb()
    .insert(conversations)
    .values({ id: CONV_UNWIRED, projectId: PROJECT_ID, title: "unwired" } as never)
    .onConflictDoNothing();
  // Insert the extension row so the conversation_extensions FK
  // resolves.
  await getDb()
    .insert(extensions)
    .values({
      id: EXT_ID,
      name: EXT_ID,
      version: "1.0.0",
      description: EXT_ID,
      manifest: { schemaVersion: 2, name: EXT_ID } as never,
      source: `test:${EXT_ID}`,
      installPath: `/tmp/${EXT_ID}`,
      enabled: true,
      grantedPermissions: { grantedAt: {} } as never,
    } as never)
    .onConflictDoNothing();
  // Wire the extension to CONV_WIRED.
  await getDb()
    .insert(conversationExtensions)
    .values({ conversationId: CONV_WIRED, extensionId: EXT_ID } as never)
    .onConflictDoNothing();
  // Seed a parent message in the wired conversation so parentMessageId
  // resolves.
  await getDb()
    .insert(messages)
    .values({
      id: "msg-am-parent",
      conversationId: CONV_WIRED,
      role: "user",
      content: "hello",
    } as never)
    .onConflictDoNothing();
});

afterAll(async () => {
  await closeTestDb();
  // Restore the real db/connection module so subsequent test files
  // that share this process don't keep our mock — leaks the test
  // PGlite into spawn-assignment-handler.test.ts and friends.
  restoreModuleMocks();
});

// ── Legacy boolean path (no engine) ─────────────────────────────────

describe("append-message — legacy boolean fallback (no engine)", () => {
  test("appendMessages not granted → -32001", async () => {
    const resp = await handleAppendMessageRpc(
      EXT_ID,
      rpc({
        v: 1,
        parentMessageId: "msg-am-parent",
        role: "extension",
        content: "x",
      }),
      makeCtx({ grantedPermissions: makePerms(false) }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toContain("appendMessages permission not granted");
  });

  test("kill-switch → -32001 even with permission granted", async () => {
    process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = "1";
    const resp = await handleAppendMessageRpc(
      EXT_ID,
      rpc({
        v: 1,
        parentMessageId: "msg-am-parent",
        role: "extension",
        content: "x",
      }),
      makeCtx(),
    );
    delete process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
    expect(resp.error?.code).toBe(-32001);
  });

  test("not wired to conversation → -32001", async () => {
    const resp = await handleAppendMessageRpc(
      EXT_ID,
      rpc({
        v: 1,
        parentMessageId: "msg-am-parent",
        role: "extension",
        content: "x",
      }),
      makeCtx({ conversationId: CONV_UNWIRED }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toContain("not wired");
  });
});

// ── Phase 6 PDP path ────────────────────────────────────────────────

describe("append-message — Phase 6 PDP path", () => {
  test("ctx.engine returns deny → -32001 'appendMessages permission not granted'", async () => {
    const { createStubPermissionEngine } = await import("./helpers/permission-engine-stub");
    const engine = createStubPermissionEngine("deny-all");
    const resp = await handleAppendMessageRpc(
      EXT_ID,
      rpc({
        v: 1,
        parentMessageId: "msg-am-parent",
        role: "extension",
        content: "x",
      }),
      // grantedPermissions still has append; the PDP path overrides.
      makeCtx({ grantedPermissions: makePerms(true), engine }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toContain("appendMessages permission not granted");
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0]!.needed).toEqual([{ kind: "ezcorp:chat:append" }]);
  });

  test("ctx.engine returns allow + grantedPermissions empty → handler proceeds to wiring check", async () => {
    const { createStubPermissionEngine } = await import("./helpers/permission-engine-stub");
    const engine = createStubPermissionEngine("allow-all");
    const resp = await handleAppendMessageRpc(
      EXT_ID,
      rpc({
        v: 1,
        parentMessageId: "msg-am-parent",
        role: "extension",
        content: "x",
      }),
      makeCtx({
        grantedPermissions: makePerms(false),
        engine,
      }),
    );
    // PDP allowed → handler proceeds. Either error is undefined
    // (full insert succeeded) or it's a downstream issue (e.g. content
    // length, attachment reattribute) — definitely NOT the
    // permission-denied -32001.
    expect(resp.error?.message ?? "").not.toContain("appendMessages permission not granted");
    expect(engine.calls.length).toBe(1);
  });
});
