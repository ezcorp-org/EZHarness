import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../__tests__/helpers/test-pglite";
import { users } from "../db/schema";
import { getExtensionDeliveryQueue, getExtensionLifecycle, recoverExtensionLifecycle } from "./extension-lifecycle-service";
import { ReleaseProcess } from "./release-process";
import { releaseRuntimeFixture } from "../__tests__/helpers/release-runtime";
import { createDatabaseLifecycleRepository } from "../db/queries/extension-releases";

mockDbConnection();

test("production lifecycle edits and empty delivery polling work offline while builds fail closed", async () => {
  const previous = { socket: process.env.EZCORP_EXTENSION_RUNNER_SOCKET, token: process.env.EZCORP_EXTENSION_RUNNER_TOKEN, blobs: process.env.EZCORP_EXTENSION_BLOB_ROOT };
  const directory = await mkdtemp(join(tmpdir(), "offline-extension-"));
  delete process.env.EZCORP_EXTENSION_RUNNER_SOCKET;
  delete process.env.EZCORP_EXTENSION_RUNNER_TOKEN;
  process.env.EZCORP_EXTENSION_BLOB_ROOT = directory;
  await setupTestDb();
  try {
    const [user] = await getTestDb().insert(users).values({ email: `${crypto.randomUUID()}@example.test`, name: "Owner", passwordHash: "unused" }).returning();
    const actor = { principalId: user!.id, scope: "global", kind: "agent" as const };
    const lifecycle = await getExtensionLifecycle();
    const created = await lifecycle.createWorkspace(actor, { files: { "extension.ts": "original" } });
    await lifecycle.editWorkspace(actor, { installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: 1, writes: { "extension.ts": "edited" } });
    expect((await lifecycle.readWorkspace(actor, created.installation.id, created.workspace.id)).files).toEqual({ "extension.ts": "edited" });
    expect((await lifecycle.inspect(actor, created.installation.id)).installation.enabled).toBe(false);
    expect(await (await getExtensionDeliveryQueue()).claim()).toBeNull();
    const operation = await lifecycle.build(actor, { installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: 2, idempotencyKey: "offline-build" });
    const result = await lifecycle.runBuild(actor, created.installation.id, operation.id);
    expect(result.state).toBe("failed");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "runner_unconfigured" }));
    expect(Object.keys((await lifecycle.inspect(actor, created.installation.id)).releases)).toHaveLength(0);
    await recoverExtensionLifecycle();
    expect((await lifecycle.inspect(actor, created.installation.id)).operations[operation.id]?.state).toBe("failed");
    await expect(new ReleaseProcess(created.installation.id).call("tools/list", {})).rejects.toMatchObject({ code: "RELEASE_NOT_ACTIVE" });
    await expect(new ReleaseProcess(created.installation.id).sendNotification("ezcorp/trigger-fire")).rejects.toMatchObject({ code: "invalid_delivery" });
    const active = releaseRuntimeFixture(crypto.randomUUID(), { schemaVersion: 4, name: "offline-catalog", version: "1.0.0", description: "Fixture", author: { name: "Test" }, permissions: {}, tools: [{ name: "read", description: "Read", inputSchema: { type: "object" }, outputSchema: { type: "object" } }] }, { ownerId: user!.id }).snapshot;
    await (await createDatabaseLifecycleRepository()).create({ installation: active.installation, releases: { [active.release.id]: active.release }, revisions: {}, workspaces: {}, approvals: {}, operations: {} });
    expect((await new ReleaseProcess(active.installation.id).call("tools/list", {})).result).toEqual({ tools: active.release.manifest.tools });
  } finally {
    for (const [key, value] of [["EZCORP_EXTENSION_RUNNER_SOCKET", previous.socket], ["EZCORP_EXTENSION_RUNNER_TOKEN", previous.token], ["EZCORP_EXTENSION_BLOB_ROOT", previous.blobs]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await closeTestDb();
    await rm(directory, { recursive: true, force: true });
  }
});
