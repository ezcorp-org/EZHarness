import { afterAll, beforeEach, expect, test } from "bun:test";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../__tests__/helpers/test-pglite";
import { releaseRuntimeFixture } from "../__tests__/helpers/release-runtime";
import { validateManifest } from "@ezcorp/extension-contract";
import { eq } from "drizzle-orm";
import { users, extensionStorage } from "../db/schema";
import { up } from "../db/migrations/add-extension-releases";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { publishExtensionGeneration } from "./extension-lifecycle-service";
import { createExtension, getExtension, getExtensionByName, getExtensionByRef, getExtensionsByNames, listExtensions } from "../db/queries/extensions";
import { resolveFilePlaceholders } from "./entities/seed";
import { ExtensionRegistry } from "./registry";

mockDbConnection();
beforeEach(setupTestDb);
afterAll(async () => { ExtensionRegistry.resetInstance(); await closeTestDb(); });

async function fixture() {
  const database = getTestDb();
  await up(database);
  const [owner] = await database.insert(users).values({ email: `${crypto.randomUUID()}@example.test`, passwordHash: "unused", name: "Owner" }).returning();
  const manifest = validateManifest({ schemaVersion: 4, name: "publication-fixture", version: "2.0.0", description: "Fixture", author: { name: "Test" }, permissions: { storage: true }, entities: [{ type: "note", label: "Note", pluralLabel: "Notes", scope: "user", schema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] }, seed: [{ slug: "one", data: { body: "{file:./one.txt}" } }, { slug: "two", data: { body: "{file:./two.txt}" } }] }] });
  const runtime = releaseRuntimeFixture(crypto.randomUUID(), manifest, { ownerId: owner!.id });
  const repository = new DatabaseLifecycleRepository(database);
  await repository.create({ installation: runtime.snapshot.installation, releases: { [runtime.snapshot.release.id]: runtime.snapshot.release }, revisions: {}, workspaces: {}, approvals: {}, operations: {} });
  await createExtension({ id: runtime.snapshot.installation.id, name: manifest.name, version: "1.0.0", manifest: { ...manifest, version: "1.0.0" }, source: "release-v4", creatorUserId: owner!.id });
  return { ...runtime.snapshot, repository, database };
}

test("publication atomically seeds immutable files and preserves existing user edits on replay", async () => {
  const { installation, release, database } = await fixture();
  await publishExtensionGeneration(installation, release, { "one.txt": "immutable one", "two.txt": "immutable two" });
  const rows = await database.select().from(extensionStorage).where(eq(extensionStorage.extensionId, installation.id));
  expect(rows).toHaveLength(3);
  expect(rows.every((row) => row.scopeId === installation.ownerId)).toBe(true);
  const first = rows.find((row) => (row.value as { body?: string }).body === "immutable one")!;
  await database.update(extensionStorage).set({ value: { body: "user edit" } }).where(eq(extensionStorage.id, first.id));
  await publishExtensionGeneration(installation, release, { "one.txt": "different source", "two.txt": "different source" });
  expect((await database.select().from(extensionStorage).where(eq(extensionStorage.id, first.id)))[0]?.value).toEqual({ body: "user edit" });
  expect((await getExtension(installation.id))?.version).toBe("2.0.0");
});

test("missing immutable seed file rolls back projection and every partial seed write", async () => {
  const { installation, release, database } = await fixture();
  await expect(publishExtensionGeneration(installation, release, { "one.txt": "first write must roll back" })).rejects.toThrow("Immutable source file is missing");
  expect(await database.select().from(extensionStorage).where(eq(extensionStorage.extensionId, installation.id))).toHaveLength(0);
  expect((await getExtension(installation.id))?.version).toBe("1.0.0");
});

test("superseded generations cannot seed or publish any projection", async () => {
  const { installation, release, repository, database } = await fixture();
  await repository.transact(installation.id, (state) => { state.installation.generation++; });
  await expect(publishExtensionGeneration(installation, release, { "one.txt": "one", "two.txt": "two" })).rejects.toMatchObject({ code: "generation_superseded" });
  expect(await database.select().from(extensionStorage).where(eq(extensionStorage.extensionId, installation.id))).toHaveLength(0);
  expect((await getExtension(installation.id))?.version).toBe("1.0.0");
});

test("immutable placeholder resolution never falls back to host paths", () => {
  expect(resolveFilePlaceholders({ values: ["{file:./present.txt}"] }, "/", { "present.txt": "bound source" })).toEqual({ values: ["bound source"] });
  for (const path of ["../etc/passwd", "/etc/passwd", "missing.txt"]) expect(() => resolveFilePlaceholders(`{file:${path}}`, "/", {})).toThrow();
});

test("uninstall removes installed catalog visibility but retains projection, release history and user data", async () => {
  const { installation, release, repository, database } = await fixture();
  await publishExtensionGeneration(installation, release, { "one.txt": "one", "two.txt": "two" });
  await repository.transact(installation.id, (state) => { state.installation.generation++; state.installation.enabled = false; });
  const disabled = (await repository.read(installation.id))!.installation;
  await publishExtensionGeneration(disabled, null);
  expect((await listExtensions()).some((row) => row.id === installation.id)).toBe(true);
  expect((await listExtensions(true)).some((row) => row.id === installation.id)).toBe(false);
  await repository.transact(installation.id, (state) => { state.installation.generation++; state.installation.uninstalled = true; });
  const removed = (await repository.read(installation.id))!.installation;
  await publishExtensionGeneration(removed, null);
  for (const options of [undefined, false, true, { bundled: false }]) expect((await listExtensions(options)).some((row) => row.id === installation.id)).toBe(false);
  expect(await getExtensionByName(release.manifest.name)).toBeNull();
  expect(await getExtensionByRef(release.manifest.name)).toBeNull();
  expect(await getExtensionByRef(installation.id)).toBeNull();
  expect((await getExtensionsByNames([release.manifest.name])).size).toBe(0);
  expect(await getExtension(installation.id)).not.toBeNull();
  expect((await repository.read(installation.id))!.releases[release.id]).toEqual(release);
  expect(await database.select().from(extensionStorage).where(eq(extensionStorage.extensionId, installation.id))).toHaveLength(3);
});
