// Coverage for the HOST-SIDE extension-RBAC ENFORCEMENT gate in
// `ToolExecutor.executeToolCall` — the fix that makes a manifest's
// per-tool `rbacScope` a real deny-by-default gate rather than an
// advisory hint.
//
// Before this fix a tool that DECLARED `permissions.rbacScopes` and
// exposed `ctx.rbac.check` could simply ignore the boolean and perform
// the action anyway — nothing on the host stopped the dispatch. Now,
// when a tool's manifest declares `rbacScope`, the host resolves the
// acting user's grant at the conversation's project and DENIES the call
// BEFORE the subprocess runs (a `PermissionDeniedError`, thrown from the
// same seam as the capability-PDP deny), regardless of whether the
// extension bothered to call `ctx.rbac.check`.
//
// This shard proves:
//   (a) a declared-scope tool is DENIED when the user lacks the grant,
//       even though the extension code never calls check() — the gate
//       short-circuits BEFORE the capability PDP and BEFORE any subprocess;
//   (b) the same tool is ALLOWED (dispatches to the subprocess) when the
//       user holds the grant;
//   (c) a tool with NO declared scope is unaffected — it dispatches even
//       for a user with no grant (unchanged path);
//   (d) admin-bypass still holds (an admin with no grant row is allowed);
//   (e) a core verb (`configure`) is enforceable exactly like a custom
//       scope; the "no acting user" coordinate fails closed;
//   (f) the advisory `ctx.rbac.check` reverse-RPC and the enforcement
//       gate AGREE — they share one decision core (`resolveExtensionScopeGrant`).
//
// Mirrors tool-executor.rbac-rpc.test.ts: a SMALL isolated shard (kept
// out of the big suites so Bun's --coverage per-line attribution stays
// clean on this huge file). The only module mock is the shared
// test-pglite db/connection redirect — the queries/auth modules under
// test are the REAL ones, backed by real grant rows.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import {
  closeTestDb,
  getTestDb,
  mockDbConnection,
  setupTestDb,
} from "../../__tests__/helpers/test-pglite";

mockDbConnection();

import { sql } from "drizzle-orm";
import { PermissionDeniedError, ToolExecutor } from "../tool-executor";
import { createStubPermissionEngine } from "../../__tests__/helpers/permission-engine-stub";
import {
  _resetCallProvenanceForTests,
  registerCallProvenance,
} from "../call-provenance";
import { upsertGrant } from "../../db/queries/extension-rbac";
import { conversations, extensions, projects, users } from "../../db/schema";
import type { ExtensionRegistry } from "../registry";
import type { ExtensionManifestV2, JsonRpcRequest, ToolCallResult } from "../types";

// RBAC coordinate = the manifest NAME (extension_rbac_grants references
// extensions.name); the registry instance id is deliberately different so
// the fixtures prove the gate resolves the grant against the NAME.
const EXT_ID = "rbac-enforce-ext-instance-id";
const EXT_NAME = "rbac-enforce-ext";
const WRITE_TICKETS = "write-tickets";

/** Three tools: a custom-scope-gated one, a core-verb-gated one, and an
 *  un-gated one (the unchanged path). */
function makeManifest(): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: EXT_NAME,
    version: "1.0.0",
    description: "rbac-enforce shard fixture",
    author: { name: "test" },
    permissions: {
      rbacScopes: [{ name: WRITE_TICKETS, description: "Mutate tickets" }],
    },
    entrypoint: "./e.ts",
    tools: [
      {
        name: "write_tool",
        description: "",
        inputSchema: { type: "object" },
        rbacScope: WRITE_TICKETS,
      },
      {
        name: "configure_tool",
        description: "",
        inputSchema: { type: "object" },
        rbacScope: "configure",
      },
      { name: "open_tool", description: "", inputSchema: { type: "object" } },
    ],
  } as ExtensionManifestV2;
}

/** Records each tool the (fake) subprocess actually received — a non-empty
 *  tape proves the gate let the call through to dispatch. */
function makeRegistry(captured: string[]): ExtensionRegistry {
  const manifest = makeManifest();
  const fakeProc = {
    callTool: async (name: string): Promise<ToolCallResult> => {
      captured.push(name);
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
    setNotificationHandler: () => {},
    setRequestHandler: () => {},
  };
  return {
    getRegisteredTool: (toolName: string) => {
      const t = manifest.tools?.find((x) => x.name === toolName);
      if (!t) return null;
      return {
        extensionId: EXT_ID,
        originalName: toolName,
        name: toolName,
        description: "",
        inputSchema: { type: "object" },
      };
    },
    getManifest: () => manifest,
    getGrantedPermissions: () =>
      ({ grantedAt: {} }) as unknown as ReturnType<ExtensionRegistry["getGrantedPermissions"]>,
    getProcess: async () => fakeProc,
    getInstallPath: () => "/tmp/ext",
    getMcpClient: async () => {
      throw new Error("not an mcp ext");
    },
  } as unknown as ExtensionRegistry;
}

/** A fresh executor + its subprocess-dispatch tape + its capturing PDP. */
function makeExecutor(): {
  executor: ToolExecutor;
  captured: string[];
  engine: ReturnType<typeof createStubPermissionEngine>;
} {
  const captured: string[] = [];
  const engine = createStubPermissionEngine(); // allow-all: the RBAC gate is the ONLY deny under test
  const executor = new ToolExecutor(makeRegistry(captured), engine);
  return { executor, captured, engine };
}

/** Host-issued provenance token for the advisory `ctx.rbac.check` path. */
function rbacCheckRequest(onBehalfOf: string, conversationId: string, scope: string): JsonRpcRequest {
  const token = registerCallProvenance({
    onBehalfOf,
    conversationId,
    runId: null,
    parentCallId: null,
    actorExtensionId: EXT_ID,
    kind: "tool",
    ownerless: false,
  });
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "ezcorp/rbac-check",
    params: { scope, _meta: { ezCallId: token } },
  };
}

// ── Seeded principals / coordinates (filled in beforeAll) ────────────
let adminId: string;
let memberGrantedId: string; // grant (projectA, EXT_NAME) {write-tickets}
let memberNoGrantId: string; // deny-by-default subject
let projectA: string;
let convA: string; // conversation in projectA

async function seed(): Promise<void> {
  const db = getTestDb();
  await db.insert(extensions).values({
    name: EXT_NAME,
    version: "1.0.0",
    source: "test:fixture",
    manifest: sql`${JSON.stringify({
      schemaVersion: 2,
      name: EXT_NAME,
      version: "1.0.0",
      description: "",
      author: { name: "test" },
    })}::jsonb`,
  });
  const projRows = await db
    .insert(projects)
    .values({ name: "RBAC Enforce Project A", path: "/tmp/rbac-enforce-a" })
    .returning({ id: projects.id });
  projectA = projRows[0]!.id;

  const mkUser = async (email: string, role: "admin" | "member") => {
    const rows = await db
      .insert(users)
      .values({ email, passwordHash: "x", name: email, role })
      .returning({ id: users.id });
    return rows[0]!.id;
  };
  adminId = await mkUser("admin@rbac-enforce.test", "admin");
  memberGrantedId = await mkUser("granted@rbac-enforce.test", "member");
  memberNoGrantId = await mkUser("none@rbac-enforce.test", "member");

  const convRows = await db
    .insert(conversations)
    .values({ projectId: projectA, userId: memberGrantedId })
    .returning({ id: conversations.id });
  convA = convRows[0]!.id;

  // The granted member holds write-tickets at projectA — nothing else.
  await upsertGrant({
    userId: memberGrantedId,
    projectId: projectA,
    extensionId: EXT_NAME,
    scopes: [WRITE_TICKETS],
    grantedByUserId: adminId,
  });
}

afterAll(async () => {
  _resetCallProvenanceForTests();
  await closeTestDb();
  restoreModuleMocks();
});

describe("ToolExecutor · extension-RBAC enforcement gate", () => {
  beforeAll(async () => {
    await setupTestDb();
    await seed();
  }, 30_000);

  test("(a) declared-scope tool is DENIED for an ungranted user (extension never called check)", async () => {
    const { executor, captured, engine } = makeExecutor();
    executor.setCurrentUserId(memberNoGrantId);
    let err: unknown;
    try {
      await executor.executeToolCall("write_tool", {}, convA, null);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect((err as Error).message).toContain(WRITE_TICKETS);
    // The gate short-circuits BEFORE the capability PDP and BEFORE dispatch.
    expect(engine.calls).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });

  test("(b) declared-scope tool is ALLOWED for a granted user → dispatches to the subprocess", async () => {
    const { executor, captured, engine } = makeExecutor();
    executor.setCurrentUserId(memberGrantedId);
    const res = await executor.executeToolCall("write_tool", {}, convA, null);
    expect(res.isError).toBe(false);
    expect(captured).toEqual(["write_tool"]); // reached the subprocess
    expect(engine.calls).toHaveLength(1); // gate passed → capability PDP ran
  });

  test("(c) a tool with NO declared rbacScope is unaffected (dispatches for an ungranted user)", async () => {
    const { executor, captured, engine } = makeExecutor();
    executor.setCurrentUserId(memberNoGrantId);
    const res = await executor.executeToolCall("open_tool", {}, convA, null);
    expect(res.isError).toBe(false);
    expect(captured).toEqual(["open_tool"]);
    expect(engine.calls).toHaveLength(1);
  });

  test("(d) admin-bypass: a declared-scope tool is ALLOWED for an admin with NO grant row", async () => {
    const { executor, captured } = makeExecutor();
    executor.setCurrentUserId(adminId);
    const res = await executor.executeToolCall("write_tool", {}, convA, null);
    expect(res.isError).toBe(false);
    expect(captured).toEqual(["write_tool"]);
  });

  test("(e1) a CORE verb (configure) is enforced too — DENIED for the ungranted member", async () => {
    const { executor, captured, engine } = makeExecutor();
    executor.setCurrentUserId(memberNoGrantId);
    let err: unknown;
    try {
      await executor.executeToolCall("configure_tool", {}, convA, null);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect((err as Error).message).toContain("configure");
    expect(engine.calls).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });

  test("(e2) no acting user (currentUserId unset) → declared-scope tool DENIED, fail-closed", async () => {
    const { executor, captured, engine } = makeExecutor();
    // Deliberately do NOT setCurrentUserId — onBehalfOf resolves null.
    let err: unknown;
    try {
      await executor.executeToolCall("write_tool", {}, convA, null);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect(engine.calls).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });

  test("(f) advisory ctx.rbac.check and the enforcement gate AGREE (one shared decision core)", async () => {
    const { executor: grantedExec, captured: grantedCap } = makeExecutor();
    grantedExec.setCurrentUserId(memberGrantedId);
    // Advisory: the extension is TOLD granted:true …
    const advisoryGranted = await grantedExec.handlePiRbacCheck(
      EXT_ID,
      rbacCheckRequest(memberGrantedId, convA, WRITE_TICKETS),
    );
    expect(advisoryGranted.result).toEqual({ granted: true });
    // … and the host ENFORCES the same answer (dispatch proceeds).
    await grantedExec.executeToolCall("write_tool", {}, convA, null);
    expect(grantedCap).toEqual(["write_tool"]);

    const { executor: noExec, captured: noCap } = makeExecutor();
    noExec.setCurrentUserId(memberNoGrantId);
    // Advisory: the extension is TOLD granted:false …
    const advisoryDenied = await noExec.handlePiRbacCheck(
      EXT_ID,
      rbacCheckRequest(memberNoGrantId, convA, WRITE_TICKETS),
    );
    expect(advisoryDenied.result).toEqual({ granted: false });
    // … and the host ENFORCES the same answer (dispatch is blocked).
    await expect(
      noExec.executeToolCall("write_tool", {}, convA, null),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(noCap).toHaveLength(0);
  });
});
