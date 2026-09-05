import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach, mock } from "bun:test";
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
mock.module("../../web/src/routes/api/conversations/[id]/extensions/$types", () => ({}));

import { POST as wirePOST } from "../../web/src/routes/api/conversations/[id]/extensions/+server";

import { ExtensionRegistry } from "../extensions/registry";
import { ToolExecutor } from "../extensions/tool-executor";
import { createPermissionEngine, _resetPermissionEngineForTests, _setPermissionEngineForTests } from "../extensions/permission-engine";
import {
  backfillMcpManifestCapabilities,
  installMcpExtension,
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
import { EXT_AUDIT_ACTIONS, AUDIT_PERM_DENIED, AUDIT_PERM_ALLOWED } from "../extensions/audit-actions";
import { MCP_TARGET_ALLOW_ENV } from "../mcp/target-guard";
import { getDb } from "../db/connection";
import { auditLog, conversations, projects, users } from "../db/schema";
import { EventBus } from "../runtime/events";
import { and, eq } from "drizzle-orm";
import type { AgentEvents } from "../types";
import type { ExtensionManifestV2 } from "../extensions/types";
import type { NewExtension } from "../db/schema";

/** A blocked target that is NOT the fixture — the cloud metadata address. */
import { mcpReleaseFixture } from "./helpers/mcp-release-fixture";
import { normalizeMcpCatalog } from "@ezcorp/extension-contract";
import { probeRemoteMcp } from "../extensions/mcp-control";
const activeFixtures: ReturnType<typeof mcpReleaseFixture>[] = [];
afterEach(() => { for (const active of activeFixtures.splice(0)) active.cleanup(); });
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


async function installFixture(name: string) {
  const row = await installMcpExtension({ name, creatorUserId: ADMIN_USER.id, server: { transport: "http", name, url: fixture.url }, cachedTools: [{ name: "echo", description: "Echo tool", inputSchema: { type: "object" } }] });
  const active = mcpReleaseFixture({ id: row.id, name, tools: normalizeMcpCatalog(row.manifest.tools ?? []).map((tool, index) => ({ ...tool, capabilities: row.manifest.tools![index]!.capabilities })) });
  activeFixtures.push(active);
  active.snapshot.installation.ownerId = ADMIN_USER.id;
  active.manifest.permissions = { ...row.manifest.permissions, mcpInvoke: true };
  active.invoke(async params => ({ content: [{ type: "text", text: "echoed:" + String((params.input as Record<string, unknown>).text) }], isError: false }));
  const updated = await updateExtension(row.id, { manifest: active.manifest, source: "release-v4" });
  await active.registry.loadFromDb();
  return new Response(JSON.stringify(updated), { status: 201 });
}

async function rowsFor(action: string) {
  return listAuditLog({ action, limit: 50 });
}

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
  const executor = new ToolExecutor(registry, engine);
  _setPermissionEngineForTests(engine);
  executor.setCurrentUserId(ADMIN_USER.id);
  return executor;
}

describe("the guard and the capability derivation compose", () => {
  test("private targets remain forbidden even when their host can be declared", async () => {
    expect(mcpManifestPermissions({ transport: "http", name: "private", url: fixture.url }).network).toEqual([fixture.host]);
    await expect(probeRemoteMcp({ transport: "http", name: "private", url: fixture.url }, async () => {})).rejects.toThrow();
    expect(await listExtensions()).toHaveLength(0);
    expect(await rowsFor(EXT_AUDIT_ACTIONS.MCP_SERVER_INSTALLED)).toHaveLength(0);
  });

  test("an approved isolated release clears the real PDP only with both declared grants", async () => {
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

  test("BOTH the host cap and the mcp:invoke sentinel are required — revoking either denies", async () => {
    // The seam between the two round-2 changes: the derivation now emits a
    // sentinel alongside the host, so a dispatch needs BOTH. Granting one and
    // withholding the other is the case neither cap's own suite can show —
    // each proves its cap in isolation, and an AND that silently degraded to
    // an OR would pass both of them.
    process.env[MCP_TARGET_ALLOW_ENV] = fixture.host;
    const ext = await jsonFromResponse(await installFixture("compose-both-caps"));
    const granted = ext.grantedPermissions as Record<string, unknown>;
    // Precondition: the install really did record both halves.
    expect(granted.network).toEqual([fixture.host]);
    expect(granted.mcpInvoke).toBe(true);

    // (a) Host granted, sentinel revoked.
    await updateExtension(ext.id, {
      grantedPermissions: { network: [fixture.host], grantedAt: { network: Date.now() } },
    });
    ExtensionRegistry.resetInstance();
    _resetPermissionEngineForTests();
    let registry = await bootRegistry();
    await expect(
      makeExecutor(registry).executeToolCall("compose-both-caps__echo", { text: "x" }, adminConvId, null),
    ).rejects.toThrow(/ezcorp:mcp:invoke/);
    registry.killAll();

    // (b) Sentinel granted, host revoked. A different missing cap, so the
    // reason must name the HOST rather than the sentinel.
    await updateExtension(ext.id, {
      grantedPermissions: { mcpInvoke: true, grantedAt: { mcpInvoke: Date.now() } },
    });
    ExtensionRegistry.resetInstance();
    _resetPermissionEngineForTests();
    registry = await bootRegistry();
    await expect(
      makeExecutor(registry).executeToolCall("compose-both-caps__echo", { text: "x" }, adminConvId, null),
    ).rejects.toThrow(new RegExp(`Missing capability network \\(${fixture.host}\\)`));
    registry.killAll();

    // (c) Both granted — the same call now succeeds, so (a) and (b) failed on
    // the grant and not on something incidental to the fixture.
    await updateExtension(ext.id, {
      grantedPermissions: {
        network: [fixture.host],
        mcpInvoke: true,
        grantedAt: { network: Date.now(), mcpInvoke: Date.now() },
      },
    });
    ExtensionRegistry.resetInstance();
    _resetPermissionEngineForTests();
    registry = await bootRegistry();
    const ok = await makeExecutor(registry).executeToolCall(
      "compose-both-caps__echo",
      { text: "both" },
      adminConvId,
      null,
    );
    expect(ok.isError).toBe(false);
    expect(JSON.stringify(ok)).toContain("echoed:both");
    registry.killAll();
  }, 40_000);

  test("release authorization is rechecked on every call rather than cached at connect", async () => {
    await installFixture("compose-revalidate");
    const registry = await bootRegistry();
    const executor = makeExecutor(registry);
    expect((await executor.executeToolCall("compose-revalidate__echo", { text: "before" }, adminConvId, null)).isError).toBe(false);
    activeFixtures[0]!.snapshot.installation.enabled = false;
    const second = await executor.executeToolCall("compose-revalidate__echo", { text: "after" }, adminConvId, null);
    expect(second.isError).toBe(true);
    expect(JSON.stringify(second)).not.toContain("echoed:after");
  });

});

describe("audit and catalog invariants", () => {
  test("the dispatch audit actor matches the approved owner rather than a worker claim", async () => {
    const ext = await jsonFromResponse(await installFixture("compose-creator"));
    const registry = await bootRegistry();
    await makeExecutor(registry).executeToolCall("compose-creator__echo", { text: "audit" }, adminConvId, null);
    const row = (await rowsFor(AUDIT_PERM_ALLOWED)).find(value => value.target === ext.id);
    expect(row).toBeDefined();
    expect(row!.userId).toBe(ADMIN_USER.id);
    expect((await getExtension(ext.id))!.creatorUserId).toBe(ADMIN_USER.id);
  });
  test("a blocked connection probe leaves the existing definition and mutation audit unchanged", async () => {
    const ext = await jsonFromResponse(await installFixture("compose-edit"));
    const original = (await getExtension(ext.id))!.manifest;
    await expect(probeRemoteMcp({ transport: "http", name: "metadata", url: METADATA_URL }, async () => {})).rejects.toThrow();
    expect((await getExtension(ext.id))!.manifest).toEqual(original);
    expect(await rowsFor(EXT_AUDIT_ACTIONS.MCP_SERVER_UPDATED)).toHaveLength(0);
  });
  test("catalog drift cannot replace stored tools or erase their capability requirements", async () => {
    const ext = await jsonFromResponse(await installFixture("compose-refresh"));
    const registry = await bootRegistry();
    activeFixtures[0]!.discover(() => ({ ...activeFixtures[0]!.manifest, tools: [] }));
    const result = await makeExecutor(registry).executeToolCall("compose-refresh__echo", {}, adminConvId, null);
    expect(result.isError).toBe(true);
    expect((await registry.refreshMcpTools(ext.id)).map(tool => tool.name)).toEqual(["echo"]);
    const stored = (await getExtension(ext.id))!.manifest;
    expect(stored.tools![0]!.capabilities).toEqual({ network: { hosts: [fixture.host] }, custom: { "ezcorp:mcp:invoke": true } });
    expect(await rowsFor(EXT_AUDIT_ACTIONS.MCP_SERVER_REFRESHED)).toHaveLength(0);
  });
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
