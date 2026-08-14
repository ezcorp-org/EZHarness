/**
 * B5 integration: the PDP is no longer inert for MCP tools.
 *
 * Boots a REAL PGlite, installs a REAL `kind:"mcp"` extension row, loads the
 * REAL registry from it and dispatches through the REAL `PermissionEngine`
 * (no `createStubPermissionEngine` — a stub would prove nothing here, since
 * the defect was that the engine's INPUT was empty, not that the engine was
 * wrong).
 *
 * What used to happen: `installMcpExtension` wrote `permissions: {}` and
 * stored `tools/list` verbatim, so `capabilityDeclarationToSet(undefined, …)`
 * returned `[]`, `firstMissingCapability([], [])` returned `null`, and every
 * MCP tool call was allowed with no grant of any kind. The four cases below
 * are the ones that could not be written before the fix.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mockDbConnection, mockRealSettings, setupTestDb, closeTestDb } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mockDbConnection();
mockRealSettings();

import { ExtensionRegistry } from "../extensions/registry";
import { ToolExecutor } from "../extensions/tool-executor";
import { createPermissionEngine, _resetPermissionEngineForTests } from "../extensions/permission-engine";
import {
  backfillMcpManifestCapabilities,
  createExtension,
  deleteExtension,
  getExtension,
  installMcpExtension,
  updateExtension,
  updateMcpExtension,
} from "../db/queries/extensions";
import { createConversation } from "../db/queries/conversations";
import { getDb } from "../db/connection";
import { auditLog, projects } from "../db/schema";
import type { NewExtension } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { EventBus } from "../runtime/events";
import { AUDIT_PERM_ALLOWED, AUDIT_PERM_DENIED } from "../extensions/audit-actions";
import type { AgentEvents } from "../types";
import type { ExtensionManifestV2, ExtensionPermissions, McpServerDefinition } from "../extensions/types";

const REMOTE_URL = "https://mcp.example.com/mcp";
const REMOTE_HOST = "mcp.example.com";

let projectId: string;

beforeAll(async () => {
  await setupTestDb();
  const [p] = await getDb()
    .insert(projects)
    .values({ name: "mcp-pdp-proj", path: "/tmp/mcp-pdp" })
    .returning();
  projectId = p!.id;
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

beforeEach(() => {
  ExtensionRegistry.resetInstance();
  _resetPermissionEngineForTests();
});

/** Boot the registry off the DB and stub the wire client for `extId`. */
async function bootRegistry(extId: string): Promise<{
  registry: ExtensionRegistry;
  calls: string[];
}> {
  const registry = ExtensionRegistry.getInstance();
  await registry.loadFromDb();
  const calls: string[] = [];
  (registry as unknown as { mcpClients: Map<string, unknown> }).mcpClients.set(extId, {
    isConnected: true,
    connect: async () => {},
    listTools: async () => [],
    callTool: async (name: string) => {
      calls.push(name);
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
    close: async () => {},
  });
  return { registry, calls };
}

function makeExecutor(registry: ExtensionRegistry): ToolExecutor {
  const engine = createPermissionEngine({
    registry,
    bus: new EventBus<AgentEvents>(),
    db: {},
  });
  return new ToolExecutor(registry, engine);
}

async function auditRows(extId: string, action: string) {
  return getDb()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.target, extId), eq(auditLog.action, action)));
}

describe("MCP tool dispatch is gated by the PDP", () => {
  test("(d) install records the derived grant in BOTH granted and installed permissions", async () => {
    const ext = await installMcpExtension({
      name: "pdp-install",
      server: { transport: "http", name: "pdp-install", url: REMOTE_URL },
      cachedTools: [{ name: "probe", description: "p", inputSchema: { type: "object" } }],
      creatorUserId: null,
    });

    const manifest = ext.manifest as ExtensionManifestV2;
    // The manifest CEILING — what `clampExtensionPermissions` intersects an
    // admin's submitted grant against. `{}` here is what made the network
    // grant unreachable.
    expect(manifest.permissions.network).toEqual([REMOTE_HOST]);
    // The per-tool declaration the PDP turns into the needed-cap set.
    expect(manifest.tools![0]!.capabilities).toEqual({ network: { hosts: [REMOTE_HOST] } });
    // The install-time consent, recorded the same way `activateExtension`
    // records it so the reapprove flow clamps against it.
    expect(ext.grantedPermissions.network).toEqual([REMOTE_HOST]);
    expect((ext.installedPermissions as ExtensionPermissions).network).toEqual([REMOTE_HOST]);
    expect(typeof ext.grantedPermissions.grantedAt.network).toBe("number");

    await deleteExtension(ext.id);
  });

  test("(b) a granted MCP tool call is ALLOWED and the PDP writes its allow row", async () => {
    const ext = await installMcpExtension({
      name: "pdp-allow",
      server: { transport: "http", name: "pdp-allow", url: REMOTE_URL },
      cachedTools: [{ name: "probe", description: "p", inputSchema: { type: "object" } }],
    });
    const { registry, calls } = await bootRegistry(ext.id);
    const conv = await createConversation(projectId, { title: "allow" });

    const result = await makeExecutor(registry).executeToolCall(
      "pdp-allow__probe",
      {},
      conv.id,
      null,
    );

    expect(result.isError).toBe(false);
    expect(calls).toEqual(["probe"]);
    const allowed = await auditRows(ext.id, AUDIT_PERM_ALLOWED);
    expect(allowed.length).toBeGreaterThan(0);

    await deleteExtension(ext.id);
  });

  test("(a) revoking the grant DENIES the tool call and audits ext:perm:denied", async () => {
    const ext = await installMcpExtension({
      name: "pdp-deny",
      server: { transport: "http", name: "pdp-deny", url: REMOTE_URL },
      cachedTools: [{ name: "probe", description: "p", inputSchema: { type: "object" } }],
    });
    // Exactly what an admin `PUT /api/extensions/<id>/permissions` with an
    // empty body produces once the clamp has a ceiling to work against.
    await updateExtension(ext.id, { grantedPermissions: { grantedAt: {} } });

    const { registry, calls } = await bootRegistry(ext.id);
    const conv = await createConversation(projectId, { title: "deny" });

    await expect(
      makeExecutor(registry).executeToolCall("pdp-deny__probe", {}, conv.id, null),
    ).rejects.toThrow(/Missing capability network \(mcp\.example\.com\)/);
    // The wire client is never reached — the deny happens before dispatch.
    expect(calls).toEqual([]);

    const denied = await auditRows(ext.id, AUDIT_PERM_DENIED);
    expect(denied).toHaveLength(1);
    expect((denied[0]!.metadata as Record<string, unknown>).capabilityKind).toBe("network");
    expect((denied[0]!.metadata as Record<string, unknown>).capabilityValue).toBe(REMOTE_HOST);

    await deleteExtension(ext.id);
  });

  test("a stdio server's command-line host is derived, granted and enforced", async () => {
    const server: McpServerDefinition = {
      transport: "stdio",
      name: "pdp-stdio",
      command: "npx",
      args: ["-y", "mcp-remote", "https://stdio.example.com/mcp"],
    };
    const ext = await installMcpExtension({
      name: "pdp-stdio",
      server,
      cachedTools: [{ name: "probe", description: "p", inputSchema: { type: "object" } }],
    });
    // The same list `mcp-sandbox.ts` hands the forward proxy as
    // `permittedHosts`, and the same value `mcp-proxy.ts` re-authorizes each
    // CONNECT against — so the grant maps onto real egress enforcement.
    expect(ext.grantedPermissions.network).toEqual(["stdio.example.com"]);

    const { registry } = await bootRegistry(ext.id);
    const conv = await createConversation(projectId, { title: "stdio" });
    const ok = await makeExecutor(registry).executeToolCall("pdp-stdio__probe", {}, conv.id, null);
    expect(ok.isError).toBe(false);

    await updateExtension(ext.id, { grantedPermissions: { grantedAt: {} } });
    ExtensionRegistry.resetInstance();
    _resetPermissionEngineForTests();
    const revoked = await bootRegistry(ext.id);
    await expect(
      makeExecutor(revoked.registry).executeToolCall("pdp-stdio__probe", {}, conv.id, null),
    ).rejects.toThrow(/Missing capability network \(stdio\.example\.com\)/);

    await deleteExtension(ext.id);
  });

  test("a stdio server naming NO host stays deny-by-default with an empty grant", async () => {
    const ext = await installMcpExtension({
      name: "pdp-hostless",
      server: {
        transport: "stdio",
        name: "pdp-hostless",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
      },
      cachedTools: [{ name: "probe", description: "p", inputSchema: { type: "object" } }],
    });
    // Nothing is invented: no host in the command line means no host granted.
    // The forward proxy therefore still refuses every CONNECT — the documented
    // deny-by-default posture, now explicit rather than accidental.
    expect(ext.grantedPermissions.network).toBeUndefined();
    expect((ext.manifest as ExtensionManifestV2).permissions.network).toEqual([]);

    await deleteExtension(ext.id);
  });
});

describe("refresh does not silently un-declare the tools", () => {
  test("refreshMcpTools re-derives the declaration for the fresh tools/list", async () => {
    const ext = await installMcpExtension({
      name: "pdp-refresh",
      server: { transport: "http", name: "pdp-refresh", url: REMOTE_URL },
      cachedTools: [{ name: "old", description: "o", inputSchema: { type: "object" } }],
    });
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    (registry as unknown as { mcpClients: Map<string, unknown> }).mcpClients.set(ext.id, {
      isConnected: true,
      connect: async () => {},
      // A live `tools/list` carries NO capability declaration — this is the
      // exact input that erased an install-time-only fix.
      listTools: async () => [{ name: "fresh", description: "f", inputSchema: { type: "object" } }],
      callTool: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
      close: async () => {},
    });

    await registry.refreshMcpTools(ext.id);

    // In memory AND at rest, the refreshed tool still declares the host.
    expect(registry.getManifest(ext.id)!.tools![0]!.capabilities).toEqual({
      network: { hosts: [REMOTE_HOST] },
    });
    const row = await getExtension(ext.id);
    expect((row!.manifest as ExtensionManifestV2).tools![0]!.capabilities).toEqual({
      network: { hosts: [REMOTE_HOST] },
    });

    // …and the PDP still denies the refreshed tool once the grant is gone.
    await updateExtension(ext.id, { grantedPermissions: { grantedAt: {} } });
    ExtensionRegistry.resetInstance();
    _resetPermissionEngineForTests();
    const rebooted = await bootRegistry(ext.id);
    await expect(
      makeExecutor(rebooted.registry).executeToolCall(
        "pdp-refresh__fresh",
        {},
        (await createConversation(projectId, { title: "refresh" })).id,
        null,
      ),
    ).rejects.toThrow(/Missing capability network \(mcp\.example\.com\)/);

    await deleteExtension(ext.id);
  });
});

describe("edit-after-install keeps the ceiling and the grant honest", () => {
  test("re-pointing at a different host re-issues the grant for the NEW host only", async () => {
    const ext = await installMcpExtension({
      name: "pdp-repoint",
      server: { transport: "http", name: "pdp-repoint", url: REMOTE_URL },
      cachedTools: [{ name: "probe", description: "p", inputSchema: { type: "object" } }],
    });

    const updated = await updateMcpExtension({
      id: ext.id,
      server: { transport: "http", name: "pdp-repoint", url: "https://other.example.com/mcp" },
      cachedTools: [{ name: "probe", description: "p", inputSchema: { type: "object" } }],
    });

    const manifest = updated!.manifest as ExtensionManifestV2;
    expect(manifest.permissions.network).toEqual(["other.example.com"]);
    // The stale host is gone from the grant, not merely joined by the new one.
    expect(updated!.grantedPermissions.network).toEqual(["other.example.com"]);
    expect((updated!.installedPermissions as ExtensionPermissions).network).toEqual([
      "other.example.com",
    ]);

    await deleteExtension(ext.id);
  });

  test("a description-only edit preserves a deliberate admin revocation", async () => {
    const ext = await installMcpExtension({
      name: "pdp-desc-edit",
      server: { transport: "http", name: "pdp-desc-edit", url: REMOTE_URL },
      cachedTools: [{ name: "probe", description: "p", inputSchema: { type: "object" } }],
    });
    await updateExtension(ext.id, { grantedPermissions: { grantedAt: {} } });

    const updated = await updateMcpExtension({
      id: ext.id,
      description: "renamed",
      server: { transport: "http", name: "pdp-desc-edit", url: REMOTE_URL },
      cachedTools: [{ name: "probe", description: "p", inputSchema: { type: "object" } }],
    });

    expect(updated!.description).toBe("renamed");
    // Ceiling unchanged → no re-consent, so the revocation still stands.
    expect(updated!.grantedPermissions.network).toBeUndefined();

    await deleteExtension(ext.id);
  });

  test("editing a LEGACY row heals its missing ceiling and grant", async () => {
    const ext = await createExtension({
      name: "pdp-legacy-edit",
      version: "0.0.0",
      description: "",
      manifest: {
        schemaVersion: 2,
        name: "pdp-legacy-edit",
        version: "0.0.0",
        description: "",
        author: { name: "local" },
        kind: "mcp",
        mcpServers: [{ transport: "http", name: "pdp-legacy-edit", url: REMOTE_URL }],
        tools: [],
        permissions: {},
      } as ExtensionManifestV2,
      source: "mcp:http",
      installPath: null,
      enabled: true,
      grantedPermissions: { grantedAt: {} },
      checksumVerified: false,
      consecutiveFailures: 0,
    } as NewExtension);

    const updated = await updateMcpExtension({
      id: ext.id,
      server: { transport: "http", name: "pdp-legacy-edit", url: REMOTE_URL },
      cachedTools: [{ name: "probe", description: "p", inputSchema: { type: "object" } }],
    });

    expect((updated!.manifest as ExtensionManifestV2).permissions.network).toEqual([REMOTE_HOST]);
    expect(updated!.grantedPermissions.network).toEqual([REMOTE_HOST]);

    await deleteExtension(ext.id);
  });

  test("updateMcpExtension still refuses a non-MCP row", async () => {
    const ext = await createExtension({
      name: "pdp-not-mcp",
      version: "0.0.0",
      description: "",
      manifest: {
        schemaVersion: 2,
        name: "pdp-not-mcp",
        version: "0.0.0",
        description: "",
        author: { name: "local" },
        permissions: {},
        tools: [],
      } as ExtensionManifestV2,
      source: "local",
      installPath: null,
      enabled: true,
      grantedPermissions: { grantedAt: {} },
      checksumVerified: false,
      consecutiveFailures: 0,
    } as NewExtension);

    await expect(
      updateMcpExtension({
        id: ext.id,
        server: { transport: "http", name: "pdp-not-mcp", url: REMOTE_URL },
        cachedTools: [],
      }),
    ).resolves.toBeNull();

    await deleteExtension(ext.id);
  });
});

describe("legacy MCP rows (permissions: {})", () => {
  /** The exact row shape `installMcpExtension` wrote before this fix. */
  async function insertLegacyRow(name: string) {
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name,
      version: "0.0.0",
      description: "",
      author: { name: "local" },
      kind: "mcp",
      mcpServers: [{ transport: "http", name, url: REMOTE_URL }],
      tools: [{ name: "probe", description: "p", inputSchema: { type: "object" } }],
      permissions: {},
    } as ExtensionManifestV2;
    return createExtension({
      name,
      version: "0.0.0",
      description: "",
      manifest,
      source: "mcp:http",
      installPath: null,
      enabled: true,
      grantedPermissions: { grantedAt: {} },
      checksumVerified: false,
      consecutiveFailures: 0,
    } as NewExtension);
  }

  test("(c) read-time normalization makes a legacy row fail CLOSED before the backfill", async () => {
    const ext = await insertLegacyRow("pdp-legacy-closed");
    const { registry, calls } = await bootRegistry(ext.id);
    const conv = await createConversation(projectId, { title: "legacy" });

    // The registry derived the needed cap from the row's own stored server
    // definition; the row still carries no grant, so the PDP denies. This is
    // the documented direction: a legacy row is never silently wide open.
    await expect(
      makeExecutor(registry).executeToolCall("pdp-legacy-closed__probe", {}, conv.id, null),
    ).rejects.toThrow(/Missing capability network \(mcp\.example\.com\)/);
    expect(calls).toEqual([]);

    await deleteExtension(ext.id);
  });

  test("(c) the one-shot backfill heals the row's ceiling AND its grant", async () => {
    const ext = await insertLegacyRow("pdp-legacy-healed");

    const result = await backfillMcpManifestCapabilities();
    expect(result.migrated).toBeGreaterThan(0);
    expect(result.scanned).toBeGreaterThanOrEqual(result.migrated);

    const healed = await getExtension(ext.id);
    const manifest = healed!.manifest as ExtensionManifestV2;
    expect(manifest.permissions.network).toEqual([REMOTE_HOST]);
    expect(manifest.tools![0]!.capabilities).toEqual({ network: { hosts: [REMOTE_HOST] } });
    // Not bricked: the grant covers exactly the host the row was already
    // contacting on every call — de-facto authority made explicit, not widened.
    expect(healed!.grantedPermissions.network).toEqual([REMOTE_HOST]);
    expect((healed!.installedPermissions as ExtensionPermissions).network).toEqual([REMOTE_HOST]);

    const { registry, calls } = await bootRegistry(ext.id);
    const conv = await createConversation(projectId, { title: "healed" });
    const ok = await makeExecutor(registry).executeToolCall(
      "pdp-legacy-healed__probe",
      {},
      conv.id,
      null,
    );
    expect(ok.isError).toBe(false);
    expect(calls).toEqual(["probe"]);

    await deleteExtension(ext.id);
  });

  test("(c) the backfill is idempotent — a second pass migrates nothing", async () => {
    const ext = await insertLegacyRow("pdp-legacy-idem");
    const first = await backfillMcpManifestCapabilities();
    expect(first.migrated).toBeGreaterThan(0);
    const second = await backfillMcpManifestCapabilities();
    expect(second.migrated).toBe(0);
    expect(second.scanned).toBeGreaterThan(0);
    await deleteExtension(ext.id);
  });
});
