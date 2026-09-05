import { afterAll, beforeEach, expect, test } from "bun:test";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../__tests__/helpers/test-pglite";
import { releaseRuntimeFixture } from "../__tests__/helpers/release-runtime";
import { validateManifest, type Runner } from "@ezcorp/extension-contract";
import { createPermissionEngine } from "./permission-engine";
import { createExtension, updateExtension } from "../db/queries/extensions";
import { users } from "../db/schema";
import { ReleaseProcess } from "./release-process";
import { registerCallProvenance, releaseCallProvenance } from "./call-provenance";
import { applySweepResult, runSweep } from "./perm-expiry-sweep";
import { TTL_CONFIG } from "./perm-expiry-config";
import type { ExtensionRegistry } from "./registry";

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
    await updateExtension(extensionId, { grantedPermissions: {} });
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
