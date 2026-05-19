/**
 * Phase 54 Plan 03 — SEC-06 (Claim-1 caveat) PDP-wiring contract tests.
 *
 * The v1.3 security review surfaced one remaining bypass in the PDP
 * audit/scope ladder: the messageToolbar shortcut at
 * `web/src/routes/api/extensions/[name]/events/[event]/+server.ts:367-371`
 * builds an `AppendMessageContext` WITHOUT the `engine` field, causing
 * `handleAppendMessageRpc` (src/extensions/append-message-handler.ts:197)
 * to fall into the legacy boolean fallback at line 213-215 — silently
 * bypassing:
 *   1. The PDP audit row (`PERM_ALLOWED` / `PERM_DENIED`).
 *   2. The always-allow scope ladder (sensitive-cap gate; not relevant
 *      for `ezcorp:chat:append` because it isn't in `SENSITIVE_KINDS`,
 *      but the principle applies for any future append-shaped cap).
 *   3. The per-conversation override lookup (effective grants).
 *
 * Plan 03's source fix is a 1-line addition (`engine: getPermissionEngine()`)
 * to the route's ctx object. THIS test file is the contract that locks
 * the wiring at the handler-call layer:
 *
 *   • Test 1 — engine wired + grantedPermissions append=false → engine
 *     consulted; handler does NOT short-circuit on the legacy boolean
 *     check. Proves the PDP path takes precedence when both are present.
 *
 *   • Test 2 — engine wired + grantedPermissions append=true + engine
 *     denies → -32001 returned; NO message persistence side-effect.
 *     Proves the deny gate prevents downstream writes (the security
 *     guarantee that gives the audit row teeth).
 *
 *   • Test 3 — engine UNDEFINED + legacy boolean → still works (true
 *     succeeds the perm gate; false returns -32001). Back-compat
 *     invariant for pre-PDP test contexts.
 *
 * Note on overlap with `append-message-handler.test.ts`: that file has
 * baseline coverage of the PDP allow/deny + legacy paths. This file
 * adds the SEC-06-specific assertions:
 *   - Test 1 asserts engine is called AND grantedPermissions=false is
 *     ignored (existing test had grantedPermissions=false but didn't
 *     explicitly contrast the two-input precedence).
 *   - Test 2 asserts NO message row was inserted (existing test only
 *     checks the response code).
 *   - Test 3 confirms the legacy fallback path remains intact (back-compat).
 *
 * Pattern follows `src/__tests__/append-message-handler.test.ts` (real
 * PGlite + drizzle, mock only `db/connection`) so the deny-prevents-write
 * assertion can read the `messages` table directly.
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
const { eq } = await import("drizzle-orm");

import type { JsonRpcRequest } from "../extensions/types";
import type { AppendMessageContext } from "../extensions/append-message-handler";
import type { ExtensionPermissions } from "../extensions/types";

// ── Fixtures ─────────────────────────────────────────────────────────

const PROJECT_ID = "proj-sec06";
const CONV_ID = "conv-sec06";
const EXT_ID = "ext-sec06";
const USER_ID = "user-sec06";
const PARENT_MSG_ID = "msg-sec06-parent";

function makePerms(append: boolean): ExtensionPermissions {
  return {
    ...(append ? { appendMessages: { excludedDefault: true } } : {}),
    grantedAt: {},
  };
}

function rpc(params: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ezcorp/append-message", params };
}

beforeAll(async () => {
  await setupTestDb();
  await getDb()
    .insert(users)
    .values({ id: USER_ID, email: "sec06@test.local", passwordHash: "x", name: "sec06" } as never)
    .onConflictDoNothing();
  await getDb()
    .insert(projects)
    .values({ id: PROJECT_ID, name: "sec06", path: "/tmp/sec06" } as never)
    .onConflictDoNothing();
  await getDb()
    .insert(conversations)
    .values({ id: CONV_ID, projectId: PROJECT_ID, title: "sec06" } as never)
    .onConflictDoNothing();
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
  await getDb()
    .insert(conversationExtensions)
    .values({ conversationId: CONV_ID, extensionId: EXT_ID } as never)
    .onConflictDoNothing();
  await getDb()
    .insert(messages)
    .values({
      id: PARENT_MSG_ID,
      conversationId: CONV_ID,
      role: "user",
      content: "sec06 parent",
    } as never)
    .onConflictDoNothing();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

// ── SEC-06: PDP wiring takes precedence over legacy boolean ─────────

describe("SEC-06 PDP wiring contract", () => {
  test("when ctx.engine is wired (allow), handler consults engine.authorize and ignores legacy grantedPermissions.appendMessages=false", async () => {
    // The PDP path must take precedence: engine says ALLOW, even though
    // the legacy boolean would say DENY. This is the SEC-06 invariant —
    // wiring the route's ctx with `engine` switches the gate from the
    // boolean fallback (line 213-215) to the PDP (line 197).
    const { createStubPermissionEngine } = await import("./helpers/permission-engine-stub");
    const engine = createStubPermissionEngine("allow-all");

    const ctx: AppendMessageContext = {
      conversationId: CONV_ID,
      userId: USER_ID,
      // Legacy boolean is FALSE — would block on the fallback path.
      grantedPermissions: makePerms(false),
      engine,
    };

    const resp = await handleAppendMessageRpc(
      EXT_ID,
      rpc({
        v: 1,
        parentMessageId: PARENT_MSG_ID,
        role: "extension",
        content: "sec06 allow path",
      }),
      ctx,
    );

    // PDP allow → handler proceeds. NOT the -32001 deny that the
    // legacy fallback would have returned.
    expect(resp.error?.message ?? "").not.toContain("appendMessages permission not granted");

    // Engine was consulted exactly once with the SEC-06 capability shape.
    expect(engine.calls.length).toBe(1);
    const call = engine.calls[0]!;
    expect(call.ctx.extensionId).toBe(EXT_ID);
    expect(call.ctx.userId).toBe(USER_ID);
    expect(call.ctx.conversationId).toBe(CONV_ID);
    expect(call.ctx.toolName).toBe("ezcorp/append-message");
    expect(call.needed).toEqual([{ kind: "ezcorp:chat:append" }]);
  });

  test("when ctx.engine returns deny, handler returns -32001 AND does NOT persist a message row", async () => {
    // The deny gate's whole point: prevent the side-effect AND emit an
    // audit row. Here we assert the prevent-side-effect leg by reading
    // back the messages table after the call.
    const { createStubPermissionEngine } = await import("./helpers/permission-engine-stub");
    const engine = createStubPermissionEngine("deny-all");

    // Count messages before the call.
    const beforeRows = await getDb()
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, CONV_ID));
    const beforeCount = beforeRows.length;

    const ctx: AppendMessageContext = {
      conversationId: CONV_ID,
      userId: USER_ID,
      // Legacy boolean is TRUE — would have allowed the write under
      // the fallback path. PDP deny must override.
      grantedPermissions: makePerms(true),
      engine,
    };

    const resp = await handleAppendMessageRpc(
      EXT_ID,
      rpc({
        v: 1,
        parentMessageId: PARENT_MSG_ID,
        role: "extension",
        content: "sec06 deny path - SHOULD NOT BE PERSISTED",
      }),
      ctx,
    );

    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toContain("appendMessages permission not granted");
    expect(engine.calls.length).toBe(1);

    // Critical: NO new message row was written. The deny gate truly
    // short-circuits before the createMessage call (line 284 in the
    // handler).
    const afterRows = await getDb()
      .select({ id: messages.id, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, CONV_ID));
    expect(afterRows.length).toBe(beforeCount);
    // Belt-and-suspenders: the never-persisted content string must
    // not appear in any row.
    expect(
      afterRows.find((r: { id: string; content: unknown }) => typeof r.content === "string" && (r.content as string).includes("SHOULD NOT BE PERSISTED")),
    ).toBeUndefined();
  });

  test("legacy boolean fallback still works when ctx.engine is undefined (back-compat invariant)", async () => {
    // Pre-PDP test contexts and any caller that hasn't been migrated
    // to wire the engine MUST continue to work. This is the safety net
    // that lets us land Plan 03's wiring change without breaking older
    // call sites that construct AppendMessageContext manually.

    // append=true → success.
    const respAllow = await handleAppendMessageRpc(
      EXT_ID,
      rpc({
        v: 1,
        parentMessageId: PARENT_MSG_ID,
        role: "extension",
        content: "sec06 legacy allow",
      }),
      {
        conversationId: CONV_ID,
        userId: USER_ID,
        grantedPermissions: makePerms(true),
        // engine: undefined — explicitly tests the fallback branch.
      },
    );
    expect(respAllow.error?.message ?? "").not.toContain("appendMessages permission not granted");

    // append=false → -32001.
    const respDeny = await handleAppendMessageRpc(
      EXT_ID,
      rpc({
        v: 1,
        parentMessageId: PARENT_MSG_ID,
        role: "extension",
        content: "sec06 legacy deny",
      }),
      {
        conversationId: CONV_ID,
        userId: USER_ID,
        grantedPermissions: makePerms(false),
      },
    );
    expect(respDeny.error?.code).toBe(-32001);
    expect(respDeny.error?.message).toContain("appendMessages permission not granted");
  });
});
