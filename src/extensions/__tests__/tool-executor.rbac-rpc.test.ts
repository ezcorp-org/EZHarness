// Coverage for the `ezcorp/rbac-check` reverse-RPC entry point on
// ToolExecutor (the host side of the SDK's `ctx.rbac.check`):
//   • dispatch routing in the installed request handler —
//     `if (req.method === "ezcorp/rbac-check") return this.handlePiRbacCheck(...)`,
//   • the registry guard (-32603 when the extension is unknown),
//   • the provenance gate (unresolved ezCallId → -32602),
//   • param validation + the declared-scope allowlist (core verbs always;
//     custom scopes only when the REGISTRY manifest declares them —
//     unknown scope → -32602 naming the valid scopes),
//   • the decision matrix against REAL PGlite-backed grants: admin allow,
//     granted-member allow, deny-by-default, deleted-user fail-closed,
//     conversation→project derivation (background fires check at the
//     NULL-project coordinate), and the foreign-extension spoof rejection
//     (identity is registry-resolved — wire params claiming another
//     extension are ignored).
//
// Mirrors tool-executor.github-projects-rpc.test.ts: a SMALL isolated
// shard (kept out of the big suites so Bun's --coverage per-line
// attribution stays clean for these lines on this huge file). The only
// module mock is the shared test-pglite db/connection redirect — the
// queries/auth modules under test are the REAL ones.

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
import { ToolExecutor } from "../tool-executor";
import { createStubPermissionEngine } from "../../__tests__/helpers/permission-engine-stub";
import {
  _resetCallProvenanceForTests,
  registerCallProvenance,
} from "../call-provenance";
import { upsertGrant } from "../../db/queries/extension-rbac";
import { conversations, extensions, projects, users } from "../../db/schema";
import type { ExtensionProcess } from "../subprocess";
import type { ExtensionRegistry } from "../registry";
import type {
  ExtensionManifestV2,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../types";

// The RBAC extension coordinate is the manifest NAME (extension_rbac_grants
// references extensions.name); the registry key is a separate instance id —
// keeping them distinct in the fixtures proves the handler uses the right one.
const EXT_ID = "rbac-rpc-ext-instance-id";
const EXT_NAME = "rbac-rpc-ext";
const OTHER_EXT_NAME = "rbac-rpc-other-ext";
const WRITE_TICKETS = "write-tickets";

function makeManifest(
  name: string,
  rbacScopes?: Array<{ name: string; description: string }>,
): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name,
    version: "1.0.0",
    description: "rbac-check reverse-RPC shard fixture",
    author: { name: "test" },
    permissions: rbacScopes ? { rbacScopes } : {},
  };
}

function makeRegistry(
  overrides: Partial<{
    getGrantedPermissions: ExtensionRegistry["getGrantedPermissions"];
    getManifest: ExtensionRegistry["getManifest"];
  }> = {},
): ExtensionRegistry {
  return {
    getGrantedPermissions: () => null,
    getManifest: () => undefined,
    getInstallPath: () => "/tmp/ext",
    getRegisteredTool: () => null,
    ...overrides,
  } as unknown as ExtensionRegistry;
}

function makeExecutor(manifest: ExtensionManifestV2 | undefined): ToolExecutor {
  return new ToolExecutor(
    makeRegistry({
      getGrantedPermissions: () =>
        ({ grantedAt: {} }) as unknown as ReturnType<ExtensionRegistry["getGrantedPermissions"]>,
      getManifest: () => manifest,
    }),
    createStubPermissionEngine(),
  );
}

/** Host-issued provenance snapshot for one call — the anti-spoofing anchor. */
function mintToken(onBehalfOf: string, conversationId: string | null): string {
  return registerCallProvenance({
    onBehalfOf,
    conversationId,
    runId: null,
    parentCallId: null,
    actorExtensionId: EXT_ID,
    kind: "tool",
    ownerless: false,
  });
}

function rbacRequest(
  token: string | null,
  scope?: unknown,
  extraParams: Record<string, unknown> = {},
  id: number | string = 7,
): JsonRpcRequest {
  const params: Record<string, unknown> = { ...extraParams };
  if (scope !== undefined) params.scope = scope;
  if (token) params._meta = { ezCallId: token };
  return { jsonrpc: "2.0", id, method: "ezcorp/rbac-check", params };
}

// ── Stub subprocess: capture the handler ensureSubprocessRpcWired installs ──
interface StubProc {
  installedRequestHandler: ((req: JsonRpcRequest) => Promise<JsonRpcResponse>) | null;
}
function makeStubProc(): StubProc & ExtensionProcess {
  const proc: StubProc & {
    setRequestHandler: (h: (req: JsonRpcRequest) => Promise<JsonRpcResponse>) => void;
    setNotificationHandler: (h: (n: JsonRpcNotification) => void) => void;
  } = {
    installedRequestHandler: null,
    setRequestHandler(handler) {
      proc.installedRequestHandler = handler;
    },
    setNotificationHandler() {
      /* no mediator in these tests */
    },
  };
  return proc as unknown as StubProc & ExtensionProcess;
}

// ── Seeded principals / coordinates (filled in beforeAll) ───────────
let adminId: string;
let memberId: string; //        grant (projectA, EXT_NAME) {write-tickets}
let memberGlobalId: string; //  grant (null, EXT_NAME)     {use}
let memberNoGrantId: string; // deny-by-default subject
let memberForeignId: string; // grant (null, OTHER_EXT)    {write-tickets} — spoof subject
let projectA: string;
let convA: string; // conversation in projectA

async function seed(): Promise<void> {
  const db = getTestDb();
  for (const name of [EXT_NAME, OTHER_EXT_NAME]) {
    await db.insert(extensions).values({
      name,
      version: "1.0.0",
      source: "test:fixture",
      manifest: sql`${JSON.stringify({
        schemaVersion: 2,
        name,
        version: "1.0.0",
        description: "",
        author: { name: "test" },
      })}::jsonb`,
    });
  }
  const projRows = await db
    .insert(projects)
    .values({ name: "RBAC RPC Project A", path: "/tmp/rbac-rpc-a" })
    .returning({ id: projects.id });
  projectA = projRows[0]!.id;

  const mkUser = async (email: string, role: "admin" | "member") => {
    const rows = await db
      .insert(users)
      .values({ email, passwordHash: "x", name: email, role })
      .returning({ id: users.id });
    return rows[0]!.id;
  };
  adminId = await mkUser("admin@rbac-rpc.test", "admin");
  memberId = await mkUser("member@rbac-rpc.test", "member");
  memberGlobalId = await mkUser("global@rbac-rpc.test", "member");
  memberNoGrantId = await mkUser("none@rbac-rpc.test", "member");
  memberForeignId = await mkUser("foreign@rbac-rpc.test", "member");

  const convRows = await db
    .insert(conversations)
    .values({ projectId: projectA, userId: memberId })
    .returning({ id: conversations.id });
  convA = convRows[0]!.id;

  await upsertGrant({
    userId: memberId,
    projectId: projectA,
    extensionId: EXT_NAME,
    scopes: [WRITE_TICKETS],
    grantedByUserId: adminId,
  });
  await upsertGrant({
    userId: memberGlobalId,
    projectId: null,
    extensionId: EXT_NAME,
    scopes: ["use"],
    grantedByUserId: adminId,
  });
  // The spoof subject holds write-tickets on the OTHER extension only.
  await upsertGrant({
    userId: memberForeignId,
    projectId: null,
    extensionId: OTHER_EXT_NAME,
    scopes: [WRITE_TICKETS],
    grantedByUserId: adminId,
  });
}

afterAll(async () => {
  _resetCallProvenanceForTests();
  await closeTestDb();
  restoreModuleMocks();
});

describe("ToolExecutor · ezcorp/rbac-check reverse-RPC", () => {
  beforeAll(async () => {
    await setupTestDb();
    await seed();
  }, 30_000);

  test("the installed handler routes ezcorp/rbac-check into handlePiRbacCheck", async () => {
    // Empty registry → the guard fires with -32603. Getting -32603 (not
    // -32601 'method not found') proves the dispatcher matched the method
    // and routed into handlePiRbacCheck.
    const executor = new ToolExecutor(makeRegistry(), createStubPermissionEngine());
    const proc = makeStubProc();
    await executor.ensureSubprocessRpcWired("ghost-ext", proc);
    const handler = proc.installedRequestHandler;
    expect(typeof handler).toBe("function");
    const res = await handler!(rbacRequest(null, "use", {}, 3));
    expect(res.id).toBe(3);
    expect(res.error?.code).toBe(-32603);
    expect(res.error?.message).toMatch(/not found/i);
  });

  test("known permissions but missing manifest → -32603 (both guard seams)", async () => {
    const executor = makeExecutor(undefined);
    const res = await executor.handlePiRbacCheck(EXT_ID, rbacRequest(null, "use", {}, 9));
    expect(res.id).toBe(9);
    expect(res.error?.code).toBe(-32603);
  });

  test("no valid host-issued call token → -32602 provenance unresolved", async () => {
    const executor = makeExecutor(makeManifest(EXT_NAME));
    const res = await executor.handlePiRbacCheck(EXT_ID, rbacRequest(null, "use"));
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toMatch(/provenance/i);
  });

  test("missing / non-string / empty scope → -32602", async () => {
    const executor = makeExecutor(makeManifest(EXT_NAME));
    for (const scope of [undefined, 42, ""]) {
      const res = await executor.handlePiRbacCheck(
        EXT_ID,
        rbacRequest(mintToken(adminId, convA), scope),
      );
      expect(res.error?.code).toBe(-32602);
      expect(res.error?.message).toMatch(/'scope' is required/);
    }
  });

  test("unknown scope for this extension → -32602 naming the valid scopes", async () => {
    const executor = makeExecutor(
      makeManifest(EXT_NAME, [{ name: WRITE_TICKETS, description: "Mutate tickets" }]),
    );
    const res = await executor.handlePiRbacCheck(
      EXT_ID,
      rbacRequest(mintToken(adminId, convA), "made-up-scope"),
    );
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain("Unknown RBAC scope 'made-up-scope'");
    expect(res.error?.message).toContain(EXT_NAME);
    // The error names every valid scope: the 5 core verbs + the declaration.
    for (const s of ["use", "configure", "secrets", "approve-runs", "manage", WRITE_TICKETS]) {
      expect(res.error?.message).toContain(s);
    }
  });

  test("custom scope on a manifest with NO declarations → -32602; core verbs still checkable", async () => {
    const executor = makeExecutor(makeManifest(EXT_NAME)); // no rbacScopes block
    const unknown = await executor.handlePiRbacCheck(
      EXT_ID,
      rbacRequest(mintToken(adminId, convA), WRITE_TICKETS),
    );
    expect(unknown.error?.code).toBe(-32602);
    // Core verb needs no declaration — admin resolves true.
    const core = await executor.handlePiRbacCheck(
      EXT_ID,
      rbacRequest(mintToken(adminId, convA), "approve-runs"),
    );
    expect(core.error).toBeUndefined();
    expect(core.result).toEqual({ granted: true });
  });

  test("admin → granted:true for core verbs AND declared custom scopes", async () => {
    const executor = makeExecutor(
      makeManifest(EXT_NAME, [{ name: WRITE_TICKETS, description: "Mutate tickets" }]),
    );
    for (const scope of ["use", WRITE_TICKETS]) {
      const res = await executor.handlePiRbacCheck(
        EXT_ID,
        rbacRequest(mintToken(adminId, convA), scope),
      );
      expect(res.result).toEqual({ granted: true });
    }
  });

  test("granted member → granted:true via conversation→project derivation (real grant row)", async () => {
    const executor = makeExecutor(
      makeManifest(EXT_NAME, [{ name: WRITE_TICKETS, description: "Mutate tickets" }]),
    );
    const res = await executor.handlePiRbacCheck(
      EXT_ID,
      rbacRequest(mintToken(memberId, convA), WRITE_TICKETS),
    );
    expect(res.result).toEqual({ granted: true });
  });

  test("member with no grant → {granted:false}, NOT an error (deny-by-default)", async () => {
    const executor = makeExecutor(
      makeManifest(EXT_NAME, [{ name: WRITE_TICKETS, description: "Mutate tickets" }]),
    );
    for (const scope of ["use", WRITE_TICKETS]) {
      const res = await executor.handlePiRbacCheck(
        EXT_ID,
        rbacRequest(mintToken(memberNoGrantId, convA), scope),
      );
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({ granted: false });
    }
  });

  test("foreign-extension spoof rejected: wire params naming another extension are ignored", async () => {
    // memberForeign holds write-tickets on OTHER_EXT_NAME (all projects). The
    // CALLING extension resolves from the registry to EXT_NAME, so the check
    // runs at EXT_NAME regardless of what the wire claims → denied.
    const executor = makeExecutor(
      makeManifest(EXT_NAME, [{ name: WRITE_TICKETS, description: "Mutate tickets" }]),
    );
    const res = await executor.handlePiRbacCheck(
      EXT_ID,
      rbacRequest(mintToken(memberForeignId, convA), WRITE_TICKETS, {
        // Spoof attempts — every one of these must be ignored.
        extension: OTHER_EXT_NAME,
        extensionId: OTHER_EXT_NAME,
        extensionName: OTHER_EXT_NAME,
      }),
    );
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ granted: false });
    // Sanity: the same user IS granted on the other extension — a registry
    // resolving to OTHER_EXT_NAME allows, proving the deny above came from
    // the registry-resolved identity, not the grant being absent.
    const otherExecutor = makeExecutor(
      makeManifest(OTHER_EXT_NAME, [{ name: WRITE_TICKETS, description: "Mutate tickets" }]),
    );
    const other = await otherExecutor.handlePiRbacCheck(
      EXT_ID,
      rbacRequest(mintToken(memberForeignId, convA), WRITE_TICKETS),
    );
    expect(other.result).toEqual({ granted: true });
  });

  test("background fire (no conversation) checks at the NULL-project coordinate", async () => {
    const executor = makeExecutor(makeManifest(EXT_NAME));
    // memberGlobal's grant is (null, EXT_NAME) {use} → covers the global context.
    const globalRes = await executor.handlePiRbacCheck(
      EXT_ID,
      rbacRequest(mintToken(memberGlobalId, null), "use"),
    );
    expect(globalRes.result).toEqual({ granted: true });
    // member's grant is project-scoped — it must NOT cover the global context.
    const scoped = await executor.handlePiRbacCheck(
      EXT_ID,
      rbacRequest(
        mintToken(memberId, null),
        WRITE_TICKETS,
      ),
    );
    // (declaration missing on this manifest → use the declared one)
    expect(scoped.error?.code).toBe(-32602);
    const declared = makeExecutor(
      makeManifest(EXT_NAME, [{ name: WRITE_TICKETS, description: "Mutate tickets" }]),
    );
    const scopedDeclared = await declared.handlePiRbacCheck(
      EXT_ID,
      rbacRequest(mintToken(memberId, null), WRITE_TICKETS),
    );
    expect(scopedDeclared.result).toEqual({ granted: false });
  });

  test("unknown provenance user (deleted account) → fail-closed {granted:false}", async () => {
    const executor = makeExecutor(makeManifest(EXT_NAME));
    const res = await executor.handlePiRbacCheck(
      EXT_ID,
      rbacRequest(mintToken("no-such-user-id", convA), "use"),
    );
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ granted: false });
  });

  test("a dangling conversation id derives a null project (grant row still decides)", async () => {
    const executor = makeExecutor(makeManifest(EXT_NAME));
    // memberGlobal's NULL-project grant covers it; member's project grant does not.
    const res = await executor.handlePiRbacCheck(
      EXT_ID,
      rbacRequest(mintToken(memberGlobalId, "unknown"), "use"),
    );
    expect(res.result).toEqual({ granted: true });
    const gone = await executor.handlePiRbacCheck(
      EXT_ID,
      rbacRequest(mintToken(memberGlobalId, crypto.randomUUID()), "use"),
    );
    expect(gone.result).toEqual({ granted: true });
  });
});
