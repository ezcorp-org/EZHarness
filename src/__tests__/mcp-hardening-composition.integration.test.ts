/**
 * Cross-branch composition — the three MCP hardening changes together.
 *
 * Each of the SSRF target guard, the capability derivation + PDP gate, and the
 * wire gate + audit trail is covered on its own elsewhere. This file only
 * asserts the things that are true of the COMBINATION, and that therefore no
 * single one of those changes could have proved:
 *
 *  1. The guard and the derivation deliberately disagree about private hosts.
 *     `mcp-capabilities.ts` derives `127.0.0.1` into the network ceiling (an
 *     empty needed-set is an unconditional PDP allow, so the ceiling must
 *     never be empty), while the guard REFUSES to dial a private address
 *     unless it is allowlisted. Composed: refused up front by default; with
 *     `EZCORP_MCP_TARGET_ALLOW` the install succeeds AND the derived grant is
 *     what carries the call through the PDP.
 *  2. The guard runs inside `McpClient.connect()`, i.e. BEFORE any mutation,
 *     so a refused target leaves no extension row and no audit row. Audit is
 *     written only after the mutation it describes succeeded.
 *  3. The refresh audit row reads the PRE-refresh manifest while
 *     `refreshMcpTools` ALSO re-derives per-tool capabilities — two writers on
 *     one manifest, and both results have to survive.
 *  4. The wire gate and the PDP chain rather than shadow each other: the wire
 *     gate decides who may attach the extension, the PDP decides what the
 *     attached extension may do. Passing one must not imply the other.
 *
 * Everything here runs against REAL PGlite, the REAL registry, the REAL
 * `PermissionEngine`, and a REAL MCP server over a REAL loopback socket
 * (`helpers/http-mcp-fixture.ts`) — a stub client would skip the guard, which
 * is the very thing under test.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings, getTestDb } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse, ADMIN_USER, MEMBER_USER } from "./helpers/mock-request";
import { makeHttpMcpServer, type HttpMcpFixture } from "./helpers/http-mcp-fixture";

mockDbConnection();
mockRealSettings();
mockServerAlias();

mock.module("$server/db/queries/extensions", () => require("../db/queries/extensions"));
mock.module("$server/extensions/registry", () => require("../extensions/registry"));
mock.module("$server/mcp/client", () => require("../mcp/client"));
mock.module("$server/extensions/audit-actions", () => require("../extensions/audit-actions"));
mock.module("$server/extensions/mcp-audit", () => require("../extensions/mcp-audit"));
mock.module("$server/auth/extension-wire-authz", () => require("../auth/extension-wire-authz"));
mock.module("$server/db/queries/conversation-extensions", () => require("../db/queries/conversation-extensions"));
mock.module("$lib/server/conversation-ownership", () => require("../../web/src/lib/server/conversation-ownership"));
mock.module("$lib/server/security/api-keys", () => require("../../web/src/lib/server/security/api-keys"));
mock.module("$lib/server/http-errors", () => require("../../web/src/lib/server/http-errors"));
mock.module("../../web/src/routes/api/mcp-servers/$types", () => ({}));
mock.module("../../web/src/routes/api/mcp-servers/[id]/$types", () => ({}));
mock.module("../../web/src/routes/api/mcp-servers/[id]/refresh/$types", () => ({}));
mock.module("../../web/src/routes/api/conversations/[id]/extensions/$types", () => ({}));

import { POST as installPOST } from "../../web/src/routes/api/mcp-servers/+server";
import { PUT as editPUT } from "../../web/src/routes/api/mcp-servers/[id]/+server";
import { POST as refreshPOST } from "../../web/src/routes/api/mcp-servers/[id]/refresh/+server";
import { POST as wirePOST } from "../../web/src/routes/api/conversations/[id]/extensions/+server";

import { ExtensionRegistry } from "../extensions/registry";
import { ToolExecutor } from "../extensions/tool-executor";
import { createPermissionEngine, _resetPermissionEngineForTests } from "../extensions/permission-engine";
import {
  backfillMcpManifestCapabilities,
  createExtension,
  deleteExtension,
  getExtension,
  listExtensions,
  updateExtension,
} from "../db/queries/extensions";
import { mcpManifestPermissions } from "../extensions/mcp-capabilities";
import { canWireExtension } from "../auth/extension-wire-authz";
import { upsertGrant } from "../db/queries/extension-rbac";
import { listAuditLog } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS, AUDIT_PERM_DENIED } from "../extensions/audit-actions";
import { MCP_CONNECT_FAILED_MESSAGE } from "../mcp/connect-failure";
import { MCP_TARGET_ALLOW_ENV } from "../mcp/target-guard";
import { getDb } from "../db/connection";
import { auditLog, conversations, projects, users } from "../db/schema";
import { EventBus } from "../runtime/events";
import { and, eq } from "drizzle-orm";
import type { AgentEvents } from "../types";
import type { ExtensionManifestV2 } from "../extensions/types";
import type { NewExtension } from "../db/schema";

/** A blocked target that is NOT the fixture — the cloud metadata address. */
const METADATA_URL = "http://169.254.169.254/latest/meta-data/";

const allowEnvAtStart = process.env[MCP_TARGET_ALLOW_ENV];

let projectId: string;
let adminConvId: string;
let fixture: HttpMcpFixture;

beforeAll(async () => {
  await setupTestDb();
  const db = getTestDb();
  const [proj] = await db
    .insert(projects)
    .values({ name: "mcp-composition", path: "/tmp/mcp-composition" })
    .returning();
  projectId = proj!.id;

  // `audit_log.user_id` and `conversations.user_id` are real FKs. Without
  // these rows the inserts fail, `insertAuditEntry` swallows its error by
  // contract, and every audit assertion below would pass vacuously.
  await db
    .insert(users)
    .values([
      { id: ADMIN_USER.id, email: ADMIN_USER.email, passwordHash: "x", name: ADMIN_USER.name, role: "admin" },
      { id: MEMBER_USER.id, email: MEMBER_USER.email, passwordHash: "x", name: MEMBER_USER.name, role: "member" },
    ])
    .onConflictDoNothing();

  const [conv] = await db
    .insert(conversations)
    .values({ title: "admin conv", userId: ADMIN_USER.id, projectId })
    .returning();
  adminConvId = conv!.id;

  fixture = makeHttpMcpServer({ tools: [{ name: "echo", description: "Echo tool" }] });
}, 30_000);

afterAll(async () => {
  await fixture.stop();
  restoreModuleMocks();
  if (allowEnvAtStart === undefined) delete process.env[MCP_TARGET_ALLOW_ENV];
  else process.env[MCP_TARGET_ALLOW_ENV] = allowEnvAtStart;
  await closeTestDb();
});

beforeEach(async () => {
  ExtensionRegistry.resetInstance();
  _resetPermissionEngineForTests();
  for (const ext of await listExtensions()) await deleteExtension(ext.id);
  await getDb().delete(auditLog);
  // The refresh case re-points the fixture's tool list; restore it so a later
  // test installs the tool it dispatches. (Without this, `__echo` silently
  // stops existing and a PDP assertion "fails" for a reason that has nothing
  // to do with the PDP.)
  fixture.setTools([{ name: "echo", description: "Echo tool" }]);
  // The guard reads this per call; an inherited shell value must not decide
  // whether these assertions hold.
  delete process.env[MCP_TARGET_ALLOW_ENV];
});

/** Install the loopback fixture through the REAL route. */
function installFixture(name: string) {
  return installPOST(
    createMockEvent({
      method: "POST",
      url: "http://localhost/api/mcp-servers",
      user: ADMIN_USER,
      body: { name, server: { transport: "http", name, url: fixture.url } },
    }),
  );
}

async function rowsFor(action: string) {
  return listAuditLog({ action, limit: 50 });
}

/** Boot the registry off the DB. No stub client: dispatch opens a REAL
 *  connection to the fixture, so the guard runs on the reconnect too. */
async function bootRegistry(): Promise<ExtensionRegistry> {
  const registry = ExtensionRegistry.getInstance();
  await registry.loadFromDb();
  return registry;
}

function makeExecutor(registry: ExtensionRegistry): ToolExecutor {
  const engine = createPermissionEngine({
    registry,
    bus: new EventBus<AgentEvents>(),
    db: {},
  });
  return new ToolExecutor(registry, engine);
}

describe("the guard and the capability derivation compose", () => {
  test("a private target is refused before any socket, though its host WOULD derive into the ceiling", async () => {
    // The two subsystems genuinely disagree, and that is the design: the
    // derivation describes the target so the needed-cap set is never empty;
    // the guard decides whether it may be dialed at all.
    expect(
      mcpManifestPermissions({ transport: "http", name: "x", url: fixture.url }).network,
    ).toEqual([fixture.host]);

    const res = await installFixture("compose-blocked");

    expect(res.status).toBe(502);
    expect((await jsonFromResponse(res)).error).toBe(MCP_CONNECT_FAILED_MESSAGE);
    // Refused BEFORE the mutation: no row to read back…
    expect(await listExtensions()).toHaveLength(0);
    // …and no audit row either. A trail that recorded a refused install would
    // claim a mutation that never happened.
    expect(await rowsFor(EXT_AUDIT_ACTIONS.MCP_SERVER_INSTALLED)).toHaveLength(0);
  }, 20_000);

  test("allowlisted: install succeeds, the derived grant covers the host, and dispatch clears the PDP", async () => {
    process.env[MCP_TARGET_ALLOW_ENV] = fixture.host;

    const res = await installFixture("compose-allowed");
    expect(res.status).toBe(201);
    const ext = await jsonFromResponse(res);

    // The derivation ran on the very host the allowlist re-opened.
    const manifest = ext.manifest as ExtensionManifestV2;
    expect(manifest.permissions.network).toEqual([fixture.host]);
    // The host cap PLUS the `ezcorp:mcp:invoke` dispatch sentinel every MCP
    // tool carries — without it a server naming no host would declare `{}`,
    // which flattens to an empty needed set the PDP can never fail.
    expect(manifest.tools![0]!.capabilities).toEqual({
      network: { hosts: [fixture.host] },
      custom: { "ezcorp:mcp:invoke": true },
    });
    expect(ext.grantedPermissions.network).toEqual([fixture.host]);

    // And the grant is what carries a real dispatch through the real PDP —
    // over a real socket, so the guard runs again on the registry's reconnect.
    const registry = await bootRegistry();
    const result = await makeExecutor(registry).executeToolCall(
      "compose-allowed__echo",
      { text: "hi" },
      adminConvId,
      null,
    );
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result)).toContain("echoed:hi");

    registry.killAll();
  }, 30_000);

  test("revoking the derived grant denies the same dispatch — the ceiling is load-bearing, not decorative", async () => {
    process.env[MCP_TARGET_ALLOW_ENV] = fixture.host;
    const ext = await jsonFromResponse(await installFixture("compose-revoked"));

    // Strip the network grant the install recorded; everything else is intact.
    await updateExtension(ext.id, { grantedPermissions: { grantedAt: {} } });
    ExtensionRegistry.resetInstance();
    _resetPermissionEngineForTests();
    const registry = await bootRegistry();

    await expect(
      makeExecutor(registry).executeToolCall("compose-revoked__echo", { text: "hi" }, adminConvId, null),
    ).rejects.toThrow(new RegExp(`Missing capability network \\(${fixture.host}\\)`));

    const denied = await getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.target, ext.id), eq(auditLog.action, AUDIT_PERM_DENIED)));
    expect(denied.length).toBeGreaterThan(0);

    registry.killAll();
  }, 30_000);
});

describe("audit fires only after a successful mutation", () => {
  test("the install audit actor and the row's creatorUserId are the same principal", async () => {
    // The deliberately-deferred cross-agent stitch: the install route stamps
    // `creatorUserId`, and the wire gate reads that column. If the route ever
    // stops threading it, the row silently becomes admin-only forever and the
    // audit trail is the only place the real installer is still named — so
    // assert the two agree rather than either alone.
    process.env[MCP_TARGET_ALLOW_ENV] = fixture.host;
    const ext = await jsonFromResponse(await installFixture("compose-creator"));

    const row = (await rowsFor(EXT_AUDIT_ACTIONS.MCP_SERVER_INSTALLED)).find((r) => r.target === ext.id);
    expect(row).toBeDefined();
    const actor = (row!.metadata as Record<string, unknown>).actor;

    expect(ext.creatorUserId).toBe(ADMIN_USER.id);
    expect(actor).toBe(ext.creatorUserId);
    expect(row!.userId).toBe(ext.creatorUserId);

    // …and it is persisted, not just echoed by the handler.
    expect((await getExtension(ext.id))!.creatorUserId).toBe(ADMIN_USER.id);
  }, 20_000);

  test("a failed EDIT leaves the stored config untouched AND unaudited", async () => {
    process.env[MCP_TARGET_ALLOW_ENV] = fixture.host;
    const ext = await jsonFromResponse(await installFixture("compose-edit-502"));

    // Re-point at cloud metadata. The allowlist covers loopback only, so the
    // guard refuses this target — before `updateMcpExtension` is reached.
    const editRes = await editPUT(
      createMockEvent({
        method: "PUT",
        url: `http://localhost/api/mcp-servers/${ext.id}`,
        user: ADMIN_USER,
        params: { id: ext.id },
        body: { server: { transport: "http", name: "compose-edit-502", url: METADATA_URL } },
      }),
    );

    expect(editRes.status).toBe(502);
    expect((await jsonFromResponse(editRes)).error).toBe(MCP_CONNECT_FAILED_MESSAGE);

    const stored = (await getExtension(ext.id))!.manifest as ExtensionManifestV2;
    const server = stored.mcpServers![0]!;
    expect(server.transport === "http" ? server.url : "").toBe(fixture.url);
    // The ceiling did not move to the blocked host either.
    expect(stored.permissions.network).toEqual([fixture.host]);
    expect(await rowsFor(EXT_AUDIT_ACTIONS.MCP_SERVER_UPDATED)).toHaveLength(0);
  }, 30_000);

  test("refresh audits the OLD tool list while re-deriving the NEW tools' capabilities", async () => {
    // Two writers on one manifest: the audit path must read it BEFORE
    // `refreshMcpTools` writes, and `refreshMcpTools` must re-derive the
    // declaration for tools a fresh `tools/list` delivers without one. Either
    // one alone passes its own branch's tests; only together do they prove
    // the merge did not drop one.
    process.env[MCP_TARGET_ALLOW_ENV] = fixture.host;
    const ext = await jsonFromResponse(await installFixture("compose-refresh"));
    await bootRegistry();

    fixture.setTools([
      { name: "one", description: "1" },
      { name: "two", description: "2" },
    ]);

    const res = await refreshPOST(
      createMockEvent({
        method: "POST",
        url: `http://localhost/api/mcp-servers/${ext.id}/refresh`,
        user: ADMIN_USER,
        params: { id: ext.id },
      }),
    );
    expect(res.status).toBe(200);

    const row = (await rowsFor(EXT_AUDIT_ACTIONS.MCP_SERVER_REFRESHED)).find((r) => r.target === ext.id);
    expect(row).toBeDefined();
    const meta = row!.metadata as Record<string, unknown>;
    // a1's ordering: the before side is the PRE-refresh snapshot…
    expect((meta.oldValue as Record<string, unknown>).toolNames).toEqual(["echo"]);
    expect((meta.newValue as Record<string, unknown>).toolNames).toEqual(["one", "two"]);

    // …and a3's re-derivation still landed on the tools that replaced it. A
    // tool with no `capabilities` would be an unconditional PDP allow.
    const refreshed = (await getExtension(ext.id))!.manifest as ExtensionManifestV2;
    expect(refreshed.tools!.map((t) => t.name)).toEqual(["one", "two"]);
    for (const t of refreshed.tools!) {
      expect(t.capabilities).toEqual({
        network: { hosts: [fixture.host] },
        custom: { "ezcorp:mcp:invoke": true },
      });
    }

    ExtensionRegistry.getInstance().killAll();
  }, 30_000);
});

describe("the wire gate and the PDP chain rather than shadow each other", () => {
  /** Wire `names` into the admin's conversation as `user`. */
  function wireEvent(user: typeof ADMIN_USER, names: string[], conversationId: string) {
    return createMockEvent({
      method: "POST",
      url: `http://localhost/api/conversations/${conversationId}/extensions`,
      user,
      params: { id: conversationId },
      body: { names },
    });
  }

  async function memberConversation(): Promise<string> {
    const [conv] = await getTestDb()
      .insert(conversations)
      .values({ title: "member conv", userId: MEMBER_USER.id, projectId })
      .returning();
    return conv!.id;
  }

  test("a `mcp-wire`-granted member wires it and the granted network cap carries the dispatch", async () => {
    process.env[MCP_TARGET_ALLOW_ENV] = fixture.host;
    const ext = await jsonFromResponse(await installFixture("chain-granted"));

    // Gate 1 — the wire gate. The member is not the creator and not an admin,
    // so only the explicit `use` grant can open it.
    await upsertGrant({
      userId: MEMBER_USER.id,
      projectId,
      extensionId: "chain-granted", // the NAME — the column stores the slug
      scopes: ["mcp-wire"],
      grantedByUserId: ADMIN_USER.id,
    });
    const convId = await memberConversation();
    const wireRes = await wirePOST(wireEvent(MEMBER_USER, ["chain-granted"], convId));
    expect(wireRes.status).toBe(200);

    // Gate 2 — the PDP, on the same extension, still consulted separately.
    const registry = await bootRegistry();
    const result = await makeExecutor(registry).executeToolCall(
      "chain-granted__echo",
      { text: "chained" },
      convId,
      null,
    );
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result)).toContain("echoed:chained");

    registry.killAll();
    await deleteExtension(ext.id);
  }, 30_000);

  test("passing the wire gate does NOT imply the PDP — the network grant is still required", async () => {
    // The shadowing case. If the wire gate were mistaken for authorization,
    // this dispatch would be allowed because the member is permitted to
    // attach the extension.
    process.env[MCP_TARGET_ALLOW_ENV] = fixture.host;
    const ext = await jsonFromResponse(await installFixture("chain-no-cap"));
    await upsertGrant({
      userId: MEMBER_USER.id,
      projectId,
      extensionId: "chain-no-cap",
      scopes: ["mcp-wire"],
      grantedByUserId: ADMIN_USER.id,
    });
    const convId = await memberConversation();
    expect((await wirePOST(wireEvent(MEMBER_USER, ["chain-no-cap"], convId))).status).toBe(200);

    // Wired, then the network grant is revoked.
    await updateExtension(ext.id, { grantedPermissions: { grantedAt: {} } });
    ExtensionRegistry.resetInstance();
    _resetPermissionEngineForTests();
    const registry = await bootRegistry();

    await expect(
      makeExecutor(registry).executeToolCall("chain-no-cap__echo", { text: "x" }, convId, null),
    ).rejects.toThrow(new RegExp(`Missing capability network \\(${fixture.host}\\)`));

    const denied = await getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.target, ext.id), eq(auditLog.action, AUDIT_PERM_DENIED)));
    expect(denied.length).toBeGreaterThan(0);

    registry.killAll();
  }, 30_000);

  test("holding the network capability does NOT imply the wire gate — an ungranted member is refused", async () => {
    // The mirror image, and the reason the two gates are not redundant: the
    // PDP grant is a property of the EXTENSION, not of the member.
    process.env[MCP_TARGET_ALLOW_ENV] = fixture.host;
    const ext = await jsonFromResponse(await installFixture("chain-ungranted"));
    expect((ext.grantedPermissions as { network?: string[] }).network).toEqual([fixture.host]);

    const convId = await memberConversation();
    const res = await wirePOST(wireEvent(MEMBER_USER, ["chain-ungranted"], convId));

    // Shaped as a MISS so a member cannot enumerate installed MCP servers.
    expect(res.status).toBe(404);
  }, 20_000);
});

describe("legacy rows after the backfill", () => {
  /** The exact row shape `installMcpExtension` wrote before either fix: no
   *  derived permissions, and no creator stamp. */
  async function createLegacyRow(name: string) {
    return createExtension({
      name,
      version: "1.0.0",
      description: "",
      manifest: {
        schemaVersion: 2,
        name,
        version: "1.0.0",
        description: "",
        author: { name: "local" },
        kind: "mcp",
        mcpServers: [{ transport: "http", name, url: fixture.url }],
        tools: [{ name: "echo", description: "e", inputSchema: { type: "object" } }],
        permissions: {},
      },
      source: "mcp:http",
      installPath: null,
      enabled: true,
      creatorUserId: null,
      checksumVerified: false,
      consecutiveFailures: 0,
    } as NewExtension);
  }

  test("the backfill heals the ceiling but never invents a creator, so the row stays admin-only", async () => {
    const ext = await createLegacyRow("legacy-mcp");
    await backfillMcpManifestCapabilities();

    const healed = (await getExtension(ext.id))!;
    // a3's backfill: the ceiling and grant now exist, so the row is not
    // bricked the moment its tools start carrying a needed-cap set.
    expect((healed.manifest as ExtensionManifestV2).permissions.network).toEqual([fixture.host]);
    expect(healed.grantedPermissions.network).toEqual([fixture.host]);
    // …and it deliberately did NOT stamp a creator. A backfill has no way to
    // know who installed a legacy row, and guessing would hand the row to a
    // user who never had it.
    expect(healed.creatorUserId).toBeNull();

    // a1's gate on that same healed row: admin yes, plain member no.
    await expect(canWireExtension(healed, { user: ADMIN_USER, projectId })).resolves.toBe(true);
    await expect(canWireExtension(healed, { user: MEMBER_USER, projectId })).resolves.toBe(false);
    // NULL creator matches nobody — not even a caller with an empty id.
    await expect(
      canWireExtension(healed, { user: { id: "", role: "member" }, projectId }),
    ).resolves.toBe(false);
  }, 20_000);

  test("a legacy row is not bricked — an explicit `mcp-wire` grant still opens it", async () => {
    const ext = await createLegacyRow("legacy-mcp-granted");
    await backfillMcpManifestCapabilities();
    await upsertGrant({
      userId: MEMBER_USER.id,
      projectId,
      extensionId: "legacy-mcp-granted",
      scopes: ["mcp-wire"],
      grantedByUserId: ADMIN_USER.id,
    });

    const healed = (await getExtension(ext.id))!;
    await expect(canWireExtension(healed, { user: MEMBER_USER, projectId })).resolves.toBe(true);
  }, 20_000);
});
