// Disabling and re-enabling an extension must not silently kill the cron
// jobs a user created through `ctx.triggers` (dynamic rows). The manifest
// reconciler only owns manifest rows, so whatever the disable path does to
// a dynamic row is never undone on re-enable. A row the daemon auto-disabled
// for repeated errors must stay disabled.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { closeTestDb, getTestDb, mockDbConnection, mockRealSettings, setupTestDb } from "./helpers/test-pglite";

mockDbConnection();
mockRealSettings();

// `publishExtensionGeneration` reloads the registry, which imports the
// subprocess module. Nothing here spawns one.
mock.module("../extensions/subprocess", () => ({
  ExtensionProcess: class {
    isRunning = false;
    kill() {}
  },
  parseMemoryLimit: (_: string) => undefined,
}));

import { eq, sql } from "drizzle-orm";
import { validateManifest } from "@ezcorp/extension-contract";
import { extensionSchedules, users } from "../db/schema";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { getExtensionLifecycle, publishExtensionGeneration } from "../extensions/extension-lifecycle-service";
import { requestedReleaseGrants } from "../extensions/extension-control";
import { ExtensionRegistry } from "../extensions/registry";
import { releaseRuntimeFixture } from "./helpers/release-runtime";
import type { InstallationRecord } from "../extensions/v4/types";

const OWNER = "dyn-cron-owner";

beforeAll(async () => {
  await setupTestDb();
  await getTestDb().insert(users).values({ id: OWNER, email: "dyn-cron@example.com", passwordHash: "h", name: "Owner", role: "admin" });
  await getExtensionLifecycle();
});

afterAll(async () => {
  ExtensionRegistry.resetInstance();
  restoreModuleMocks();
  await closeTestDb();
});

/** Flip the stored installation the way disable / activate do, then publish it. */
async function publishEnabled(installation: InstallationRecord, release: Parameters<typeof publishExtensionGeneration>[1], enabled: boolean) {
  const next: InstallationRecord = { ...installation, enabled, generation: installation.generation + 1 };
  await getTestDb().execute(sql`UPDATE extension_release_installations SET payload = ${JSON.stringify(next)} WHERE id = ${installation.id}`);
  await publishExtensionGeneration(next, release);
  return next;
}

describe("dynamic cron triggers across extension disable / re-enable", () => {
  test("a user job runs again after re-enable; an error auto-disabled job stays disabled", async () => {
    const manifest = validateManifest({
      schemaVersion: 4, name: "dyn-cron-ext", version: "1.0.0", description: "fixture",
      author: { name: "test" }, entrypoint: "./index.js", tools: [], permissions: {},
    });
    const fixture = releaseRuntimeFixture(crypto.randomUUID(), manifest, { ownerId: OWNER });
    fixture.snapshot.installation.grants = requestedReleaseGrants(manifest);
    const { release } = fixture.snapshot;
    let installation = fixture.snapshot.installation;
    await new DatabaseLifecycleRepository(getTestDb()).create({ installation, releases: { [release.id]: release }, revisions: {}, workspaces: {}, approvals: {}, operations: {} });
    await publishExtensionGeneration(installation, release);

    const nextFireAt = new Date(Date.now() + 3_600_000);
    await getTestDb().insert(extensionSchedules).values([
      { extensionId: installation.id, cron: "0 9 * * *", nextFireAt, dynamic: true, key: "live-job", enabled: true },
      { extensionId: installation.id, cron: "0 10 * * *", nextFireAt, dynamic: true, key: "broken-job", enabled: false, consecutiveErrors: 5 },
    ]);

    installation = await publishEnabled(installation, release, false);
    installation = await publishEnabled(installation, release, true);

    const rows = await getTestDb().select().from(extensionSchedules).where(eq(extensionSchedules.extensionId, installation.id));
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.enabled]));
    expect(byKey).toEqual({ "live-job": true, "broken-job": false });
  });
});
