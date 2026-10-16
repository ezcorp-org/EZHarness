import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import type { BuildRequest, BuildResult, WorkspaceFiles } from "@ezcorp/extension-contract";
import type { RunnerReference } from "@ezcorp/factory-sdk";
import { buildLimits, filesDigest, PodmanRunner } from "@ezcorp/extension-runner";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import type { TransactionalDb } from "../db/migrations/types";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { productExtensionRunner } from "../extensions/runner-rehydration";
import { digestObject, FileBlobStore } from "../extensions/v4/blobs";
import { getReadiness, resetReadiness } from "../readiness";
import { FactoryGrants, type FactoryPrincipal } from "./grants";
import { buildFactoryGuestHarnessRelease, factoryGuestManifest } from "./guest-package-build";
import { FactoryPackagePreparationError, FactoryPackagePreparations, FactoryPackageTrusts, FactoryV4PackageCatalog } from "./package-preparation";
import { FactoryRecords } from "./records";

/**
 * C05 "Prepare a release built outside the lifecycle" (W4H-32): the graph proof's installation path
 * (scripts/factory-graph-proof/guest-package.ts installGraphGuest) without Podman. The harness builds its guest
 * into one runner store, installs the release record itself, and prepares into a FRESH store. The release keeps its
 * artifact copy in the release blobs and the preparation goes through the product runner, so the fresh store is
 * restored from that copy; a raw runner as builder refuses by name.
 */

const tenantId = "harness-install-tenant";
const projectId = "harness-install-project";
const admin: FactoryPrincipal = { kind: "user", id: "harness-install-admin", authentication: "session" };
const source: WorkspaceFiles = { "extension.ts": "export const echo = (input: unknown) => input;" };
const artifacts: WorkspaceFiles = { "extension.ts": "export const echo = (input: unknown) => input;", ".runner/recipe.json": "{}" };
const NAME = "harness-guest", VERSION = "1.0.0";
const manifest = factoryGuestManifest({ name: NAME, version: VERSION, author: "W4H-32", description: "Harness guest", tools: { echo: "Echo" } });
const evidence = { protocolVersion: 4, validatorVersion: "runner-v4", discoveryDigest: digestObject(manifest), tests: [{ name: "unit", passed: true }] } as unknown as BuildResult["evidence"];

/** The harness's own build: a store that answers this guest's build and its artifact files (no Podman). */
const harnessBuilder = {
  async build(input: BuildRequest): Promise<BuildResult> {
    return { operationId: input.operationId, state: "succeeded", sourceDigest: input.sourceDigest, artifactDigest: filesDigest(artifacts), imageDigest: "image@sha256:harness", manifest: manifest as never, evidence, diagnostics: [] };
  },
  async collectArtifacts() { return structuredClone(artifacts); },
};

/** A fresh preparation store; it never builds. */
class FreshStore extends PodmanRunner {
  builds = 0;
  override async build(): Promise<BuildResult> { this.builds++; throw new Error("the preparation must not build"); }
}

let root = "";
let database: PGlite;
let db: TransactionalDb;
const stores: FreshStore[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-install-"));
  database = new PGlite({ extensions: { vector, pg_trgm } });
  await database.waitReady;
  db = drizzle(database, { schema }) as unknown as TransactionalDb;
  await migrate(db as never);
  resetReadiness();
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await database.close();
  await rm(root, { recursive: true, force: true });
  resetReadiness();
});
afterAll(() => { resetReadiness(); });

/** installGraphGuest's steps up to the preparation, with `builder` as the preparation's builder. */
async function installedHarnessRelease() {
  const blobs = new FileBlobStore(join(root, "release-blobs"));
  const built = await buildFactoryGuestHarnessRelease({ runner: harnessBuilder, blobs, files: source, operationId: "harness-build", limits: buildLimits, installationId: "harness-installation", releaseId: "harness-release" });
  const records = new FactoryRecords(db, tenantId);
  await records.bindInstallation();
  await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Harness project','/tmp/harness')`);
  await db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${admin.id},'harness@example.test','x','Harness','admin')`);
  await db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('harness-member',${projectId},${admin.id},'owner')`);
  await records.bindProject(projectId);
  const grants = new FactoryGrants(db, tenantId);
  await grants.set(admin, { projectId, principal: admin, action: "factory.trust", expectedRevision: 0, expiresAtMs: null });
  const repository = new DatabaseLifecycleRepository(db);
  const release = built.release as { id: string; installationId: string; artifactDigest: string };
  await repository.create({
    installation: { id: release.installationId, ownerId: admin.id, scope: `project:${projectId}`, generation: 1, activeReleaseId: release.id, enabled: true, uninstalled: false, status: "active", grants: [], acknowledgedGeneration: 1 } as never,
    workspaces: {}, revisions: {}, operations: {}, releases: { [release.id]: built.release as never }, approvals: {},
  });
  const trusts = new FactoryPackageTrusts(db, tenantId, grants);
  const reference: RunnerReference = { package: `@ezcorp/${NAME}`, manifestName: NAME, version: VERSION, digest: `sha256:${release.artifactDigest}`, export: "echo" };
  const catalog = new FactoryV4PackageCatalog(repository, blobs);
  const fresh = new FreshStore({ root: join(root, "prepare") });
  stores.push(fresh);
  return { blobs, release, reference, fresh, preparations: (builder: ConstructorParameters<typeof FactoryPackagePreparations>[5]) => new FactoryPackagePreparations(db, tenantId, grants, trusts, catalog, builder, buildLimits), trusts };
}

test("the harness installation path: a fresh preparation store is restored from the release's artifact copy through the product runner, and never builds (W4H-32)", async () => {
  const { blobs, release, reference, fresh, preparations, trusts } = await installedHarnessRelease();
  const prepared = preparations(productExtensionRunner(blobs, db, fresh));
  await prepared.bind(admin, { projectId, reference, installationId: release.installationId, releaseId: release.id }, "harness-bind");
  await trusts.publish(admin, { projectId, reference, expectedRevision: 0 }, "harness-trust");
  const receipt = await prepared.prepare(projectId, reference);
  expect(receipt).toMatchObject({ reference, artifactDigest: release.artifactDigest, trustRevision: 1 });
  expect(await fresh.collectArtifacts(release.artifactDigest)).toEqual(artifacts);
  expect(fresh.builds).toBe(0);
  expect(getReadiness().warnings).toEqual([{ code: "runner_artifact_rehydrated", artifactDigest: release.artifactDigest, count: 1 }]);
});

test("a raw runner is never a preparation builder: its fresh store's artifact_missing refuses by name and never builds (W4H-32)", async () => {
  const { release, reference, fresh, preparations, trusts } = await installedHarnessRelease();
  const raw = preparations(fresh);
  await raw.bind(admin, { projectId, reference, installationId: release.installationId, releaseId: release.id }, "harness-bind");
  await trusts.publish(admin, { projectId, reference, expectedRevision: 0 }, "harness-trust");
  const refusal = await raw.prepare(projectId, reference).catch((error: unknown) => error) as FactoryPackagePreparationError;
  expect(refusal).toBeInstanceOf(FactoryPackagePreparationError);
  expect(refusal).toMatchObject({ code: "factory_package_artifact_unavailable" });
  expect(JSON.parse(refusal.detail!)).toMatchObject({ code: "artifact_missing", errorCode: "ENOENT" });
  expect(fresh.builds).toBe(0);
});
