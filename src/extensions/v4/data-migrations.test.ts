import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { randomUUID } from "node:crypto";
import type { OperationRecord, ReleaseRecord } from "@ezcorp/extension-contract";
import { up } from "../../db/migrations/add-extension-releases";
import { DatabaseLifecycleRepository } from "../../db/queries/extension-releases";
import { ExtensionDataMigrations } from "./data-migrations";

let database: PGlite;
let repository: DatabaseLifecycleRepository;
beforeAll(async () => {
  database = new PGlite();
  await database.exec("CREATE TABLE extension_storage (id TEXT PRIMARY KEY, extension_id TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT, key TEXT NOT NULL, value JSONB NOT NULL, encrypted BOOLEAN NOT NULL DEFAULT FALSE, size_bytes INTEGER NOT NULL, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const driver = drizzle(database);
  await up(driver);
  repository = new DatabaseLifecycleRepository(driver);
});
afterAll(async () => { await database.close(); });

async function fixture() {
  const id = randomUUID();
  const previous: ReleaseRecord = { id: randomUUID(), installationId: id, workspaceId: "workspace", workspaceRevision: 1, sourceDigest: "a".repeat(64), artifactDigest: "b".repeat(64), imageDigest: "image", runnerProfile: "podman", policyDigest: "c".repeat(64), releaseDigest: "d".repeat(64), createdAt: new Date().toISOString(), evidence: { protocolVersion: 4, validatorVersion: "test", discoveryDigest: "e".repeat(64), tests: [{ name: "test", passed: true }] }, manifest: { schemaVersion: 4, name: "fixture", version: "1.0.0", author: { name: "Test" }, description: "Test", permissions: {}, dataSchema: { version: "1", readableVersions: ["1"] } } };
  previous.manifest.name = `fixture-${id}`;
  const release: ReleaseRecord = { ...previous, id: randomUUID(), manifest: { ...previous.manifest, version: "2.0.0", dataSchema: { version: "2", readableVersions: ["2"], migrateMethod: "migrate-storage" } } };
  const installation = { id, ownerId: "owner", scope: "global", activeReleaseId: previous.id, generation: 1, enabled: true, uninstalled: false, status: "active" as const, grants: [], acknowledgedGeneration: 1 };
  const operation: OperationRecord = { id: randomUUID(), kind: "activate", state: "activating", idempotencyKey: randomUUID(), inputDigest: "f".repeat(64), diagnostics: [], events: [], lease: { holder: randomUUID(), until: Date.now() + 60_000, fence: 1 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await repository.create({ installation, workspaces: {}, revisions: {}, releases: { [previous.id]: previous, [release.id]: release }, operations: { [operation.id]: operation }, approvals: {} });
  for (const user of ["alice", "bob"]) await database.query("INSERT INTO extension_storage (id,extension_id,scope,scope_id,key,value,size_bytes) VALUES ($1,$2,'user',$3,'value',$4::jsonb,1)", [randomUUID(), id, user, JSON.stringify({ old: user })]);
  return { installation, previous, release, operation };
}

async function values(installationId: string) { return (await database.query<{ scope_id: string; value: unknown }>("SELECT scope_id,value FROM extension_storage WHERE extension_id=$1 ORDER BY scope_id", [installationId])).rows; }

describe("isolated storage migrations", () => {
  test("each principal is transformed separately and writes pause until pointer commit", async () => {
    const setup = await fixture();
    const owners: string[] = [];
    const migrations = new ExtensionDataMigrations(drizzle(database), async (input) => { owners.push(input.principalId); return { values: { value: { current: (input.values.value as { old: string }).old } } }; });
    await migrations.prepare(setup.installation, setup.previous, setup.release, setup.operation);
    expect(owners.sort()).toEqual(["alice", "bob"]);
    expect(await migrations.isPaused(setup.installation.id)).toBe(true);
    await expect(database.query("UPDATE extension_storage SET value='{}' WHERE extension_id=$1", [setup.installation.id])).rejects.toThrow("paused");
    await expect(migrations.finalize(setup.installation.id)).rejects.toMatchObject({ code: "migration_not_committed" });
    await repository.transact(setup.installation.id, (state) => { state.installation.activeReleaseId = setup.release.id; state.installation.generation += 1; state.operations[setup.operation.id]!.state = "reconciling"; });
    await migrations.finalize(setup.installation.id);
    expect(await migrations.isPaused(setup.installation.id)).toBe(false);
    expect(await values(setup.installation.id)).toEqual([{ scope_id: "alice", value: { current: "alice" } }, { scope_id: "bob", value: { current: "bob" } }]);
  });

  test("failed or invalid transformation restores every scope before reopening writes", async () => {
    const setup = await fixture();
    let calls = 0;
    const migrations = new ExtensionDataMigrations(drizzle(database), async () => { calls += 1; if (calls === 2) throw new Error("migration failed"); return { values: { value: "changed" } }; });
    await expect(migrations.prepare(setup.installation, setup.previous, setup.release, setup.operation)).rejects.toThrow("migration failed");
    expect(await migrations.isPaused(setup.installation.id)).toBe(false);
    expect(await values(setup.installation.id)).toEqual([{ scope_id: "alice", value: { old: "alice" } }, { scope_id: "bob", value: { old: "bob" } }]);
  });

  test("crash after pointer commit finalizes the saved migration on restart", async () => {
    const setup = await fixture();
    const migrations = new ExtensionDataMigrations(drizzle(database), async (input) => ({ values: input.values }));
    await migrations.prepare(setup.installation, setup.previous, setup.release, setup.operation);
    await repository.transact(setup.installation.id, (state) => { state.installation.activeReleaseId = setup.release.id; state.operations[setup.operation.id]!.state = "reconciling"; });
    await new ExtensionDataMigrations(drizzle(database), async () => { throw new Error("must not rerun committed transform"); }).recover(setup.installation.id);
    expect(await migrations.isPaused(setup.installation.id)).toBe(false);
  });

  test("rollback after new writes requires readability and never silently restores data", async () => {
    const setup = await fixture();
    const migrations = new ExtensionDataMigrations(drizzle(database), async (input) => ({ values: input.values }));
    await migrations.prepare(setup.installation, setup.previous, setup.release, setup.operation);
    await repository.transact(setup.installation.id, (state) => { state.installation.activeReleaseId = setup.release.id; state.operations[setup.operation.id]!.state = "reconciling"; });
    await migrations.finalize(setup.installation.id);
    await database.query("UPDATE extension_storage SET value='\"new-write\"' WHERE extension_id=$1", [setup.installation.id]);
    const rollback = { ...setup.operation, id: randomUUID(), rollback: true };
    await expect(migrations.prepare({ ...setup.installation, activeReleaseId: setup.release.id }, setup.release, setup.previous, rollback)).rejects.toMatchObject({ code: "data_restore_required" });
    expect((await values(setup.installation.id)).every((row) => row.value === "new-write")).toBe(true);
  });

  test("stale migration holders cannot restore a newer fenced preparation", async () => {
    const setup = await fixture();
    const migrations = new ExtensionDataMigrations(drizzle(database), async (input) => ({ values: input.values }));
    await migrations.prepare(setup.installation, setup.previous, setup.release, setup.operation);
    await migrations.prepare(setup.installation, setup.previous, setup.release, { ...setup.operation, lease: { ...setup.operation.lease!, fence: 2 } });
    await migrations.abort(setup.installation.id, setup.operation.id, 1);
    expect(await migrations.isPaused(setup.installation.id)).toBe(true);
    await migrations.abort(setup.installation.id, setup.operation.id, 2);
    expect(await migrations.isPaused(setup.installation.id)).toBe(false);
  });

  test("encrypted values are excluded by refusing unsupported migrations", async () => {
    const setup = await fixture();
    await database.query("UPDATE extension_storage SET encrypted=TRUE WHERE extension_id=$1", [setup.installation.id]);
    const migrations = new ExtensionDataMigrations(drizzle(database), async () => { throw new Error("must not receive ciphertext"); });
    await expect(migrations.prepare(setup.installation, setup.previous, setup.release, setup.operation)).rejects.toMatchObject({ code: "encrypted_migration_unsupported" });
    expect(await migrations.isPaused(setup.installation.id)).toBe(false);
  });
});
