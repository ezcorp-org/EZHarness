import { describe, expect, test, afterAll, beforeEach } from "bun:test";
import { clampExtensionPermissions } from "../../extensions/clamp-permissions";
import { buildFullGrantFromManifest } from "../../extensions/install-grant";
import type { ExtensionManifestV2 } from "../../extensions/types";

describe("host API permission grants", () => {
  test("exact release grants retain trigger and message declarations without changing exclusion policy", () => {
    const permissions = { webhooks: ["tickets"], loopEvents: true, appendMessages: { excludedDefault: true } };
    const manifest: ExtensionManifestV2 = { schemaVersion: 4, name: "fixture", version: "1.0.0", description: "Fixture", author: { name: "Test" }, permissions };
    const grant = buildFullGrantFromManifest(manifest, 123);
    expect(grant).toMatchObject({ ...permissions, grantedAt: { webhooks: 123, loopEvents: 123, appendMessages: 123 } });
    expect(clampExtensionPermissions({ appendMessages: { excludedDefault: false } }, permissions).appendMessages).toBeUndefined();
    expect(clampExtensionPermissions(permissions, {}).appendMessages).toBeUndefined();
  });
  test("intersects exact route and event IDs without wildcard escalation", () => {
    const grant = clampExtensionPermissions({ hostApi: { routes: [{ method: "GET", path: "/api/tasks" }, { method: "POST", path: "/api/admin" }, { method: "GET", path: "/api/*" }], events: true } }, { hostApi: { routes: [{ method: "GET", path: "/api/tasks" }], events: false } });
    expect(grant.hostApi).toEqual({ routes: [{ method: "GET", path: "/api/tasks" }], events: false });
    expect(clampExtensionPermissions({}, { hostApi: { routes: [{ method: "GET", path: "/api/tasks" }], events: false } }).hostApi).toBeUndefined();
    expect(clampExtensionPermissions({ hostApi: { routes: [{ method: "GET", path: "/api/tasks" }], events: false } }, {}).hostApi).toBeUndefined();
  });

  test("full exact-release grants retain and timestamp host API permissions", () => {
    const manifest: ExtensionManifestV2 = { schemaVersion: 3, name: "fixture", version: "1.0.0", description: "Test", author: { name: "Test" }, permissions: { hostApi: { routes: [{ method: "GET", path: "/api/tasks" }], events: true } } };
    const grant = buildFullGrantFromManifest(manifest, 12_345);
    expect(grant.hostApi).toEqual({ routes: [{ method: "GET", path: "/api/tasks" }], events: true });
    expect(grant.grantedAt.hostApi).toBe(12_345);
  });
});


import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../helpers/test-pglite";
import { releaseRuntimeFixture } from "../helpers/release-runtime";
import { validateManifest, type Runner } from "@ezcorp/extension-contract";
import { createPermissionEngine } from "../../extensions/permission-engine";
import { createExtension, updateExtension } from "../../db/queries/extensions";
import { users } from "../../db/schema";
import { ReleaseProcess } from "../../extensions/release-process";
import { registerCallProvenance, releaseCallProvenance } from "../../extensions/call-provenance";
import { applySweepResult, runSweep } from "../../extensions/perm-expiry-sweep";
import { TTL_CONFIG } from "../../extensions/perm-expiry-config";
import type { ExtensionRegistry } from "../../extensions/registry";

mockDbConnection();
beforeEach(setupTestDb);
afterAll(closeTestDb);

test("a live release cannot use cached caller grants after actual policy revocation or expiry", async () => {
  const database = getTestDb();
  const [owner] = await database.insert(users).values({ email: `${crypto.randomUUID()}@example.test`, name: "Owner", passwordHash: "unused" }).returning();
  const extensionId = crypto.randomUUID();
  const manifest = validateManifest({ schemaVersion: 4, name: "live-grants", version: "1.0.0", description: "Fixture", author: { name: "Test" }, permissions: { storage: true }, tools: [{ name: "check", description: "Check", inputSchema: { type: "object" }, outputSchema: { type: "object" } }] });
  const grants = { storage: true, grantedAt: { storage: 1 } };
  await createExtension({ id: extensionId, name: manifest.name, version: manifest.version, manifest, source: "release-v4", enabled: true, creatorUserId: owner!.id, grantedPermissions: grants });
  const registry = { getManifest: () => manifest, getGrantedPermissions: () => grants } as unknown as ExtensionRegistry;
  const engine = createPermissionEngine({ registry, db: database, bus: { emit() {}, on() {} } as never });
  const fixture = releaseRuntimeFixture(extensionId, manifest, { ownerId: owner!.id });
  const runner: Runner = { ...fixture.runner, async start(input, reverseRpc) {
    return { workerId: input.workerId, close: async () => {}, onNotification: () => () => {}, request: async (method) => {
      if (method === "extension/discover") return manifest;
      await reverseRpc("ezcorp/storage", { context: input.context, input: { action: "get", key: "value" } });
      return {};
    } };
  } };
  const runtime = new ReleaseProcess(extensionId, { runner: async () => runner, resolve: async () => fixture.snapshot });
  runtime.setRequestHandler(async (request) => {
    const decision = await engine.authorize({ extensionId, userId: owner!.id, conversationId: null, toolName: "check", capContext: [{ kind: "storage" }] }, [{ kind: "storage" }]);
    return decision.decision === "allow" ? { jsonrpc: "2.0", id: request.id, result: { exists: false } } : { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Live grant denied" } };
  });
  const token = registerCallProvenance({ actorExtensionId: extensionId, onBehalfOf: owner!.id, conversationId: null, runId: null, parentCallId: null, kind: "tool", ownerless: false });
  const call = () => runtime.call("tools/call", { name: "check", arguments: {}, _meta: { ezCallId: token } });
  try {
    expect((await call()).result).toEqual({});
    await updateExtension(extensionId, { grantedPermissions: { grantedAt: {} } });
    await expect(call()).rejects.toThrow("Live grant denied");
    await updateExtension(extensionId, { grantedPermissions: grants });
    expect((await call()).result).toEqual({});
    const sweep = await runSweep({ db: database, now: 1000, config: { ttlConfig: { ...TTL_CONFIG, storage: 1 } } });
    expect((await applySweepResult(database, sweep, 1000)).applied).toBeGreaterThan(0);
    await expect(call()).rejects.toThrow("Live grant denied");
    expect(registry.getGrantedPermissions(extensionId)).toEqual(grants);
    expect(fixture.snapshot.installation.enabled).toBe(true);
  } finally { releaseCallProvenance(token); await runtime.kill(); }
});
